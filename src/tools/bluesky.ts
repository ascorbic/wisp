import { env } from "cloudflare:workers";
import { tool } from "ai";
import { z } from "zod";
import type { Client } from "@atcute/client";
import { ok } from "@atcute/client";
import type { Did, Nsid, ResourceUri } from "@atcute/lexicons";
import { tokenize, type Token } from "@atcute/bluesky-richtext-parser";
import RichtextBuilder from "@atcute/bluesky-richtext-builder";
import { getPdsEndpoint, type DidDocument } from "@atcute/identity";

/** Strong reference to a record (needed for replies, likes, etc.) */
const strongRefSchema = z.object({
	uri: z.string().describe("AT URI of the record"),
	cid: z.string().describe("CID of the record"),
});

/** Extract plain text from a token tree (strips formatting markers) */
function extractText(tokens: Token[]): string {
	let out = "";
	for (const t of tokens) {
		if ("children" in t) {
			out += extractText(t.children);
		} else if (t.type === "escape") {
			out += t.escaped;
		} else {
			out += t.raw;
		}
	}
	return out;
}

/** Tokenize plain text and build facets for mentions, links, and hashtags. Resolves @handles to DIDs. */
async function buildRichText(
	text: string,
	rpc: Client,
): Promise<{
	text: string;
	facets?: ReturnType<RichtextBuilder["build"]>["facets"];
}> {
	const tokens = tokenize(text);

	// Check if there are any facet-worthy tokens
	const hasFacets = tokens.some(
		(t) =>
			t.type === "mention" ||
			t.type === "autolink" ||
			t.type === "link" ||
			t.type === "topic",
	);
	if (!hasFacets) return { text };

	const builder = new RichtextBuilder();

	for (const token of tokens) {
		switch (token.type) {
			case "mention": {
				try {
					const profile = await ok(
						rpc.get("app.bsky.actor.getProfile", {
							params: { actor: token.handle as Did },
						}),
					);
					builder.addMention(token.raw, profile.did);
				} catch {
					// Handle not found — just add as plain text
					builder.addText(token.raw);
				}
				break;
			}
			case "autolink":
				builder.addLink(token.raw, token.url as `https://${string}`);
				break;
			case "link":
				builder.addLink(
					extractText(token.children),
					token.url as `https://${string}`,
				);
				break;
			case "topic":
				builder.addTag(token.name);
				break;
			default:
				// Plain text, formatting, escapes, etc.
				if ("children" in token) {
					builder.addText(extractText(token.children));
				} else if (token.type === "escape") {
					builder.addText(token.escaped);
				} else {
					builder.addText(token.raw);
				}
		}
	}

	const result = builder.build();
	return {
		text: result.text,
		facets: result.facets.length > 0 ? result.facets : undefined,
	};
}

/** Resolve a handle to a DID. */
async function resolveHandle(handle: string): Promise<string> {
	const res = await fetch(
		`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
	);
	if (!res.ok) throw new Error(`Failed to resolve handle: ${handle}`);
	const data = (await res.json()) as { did: string };
	return data.did;
}

/** Fetch a DID document and extract the PDS endpoint. */
async function resolvePds(actor: string): Promise<string> {
	const did = actor.startsWith("did:") ? actor : await resolveHandle(actor);
	const res = await fetch(`https://plc.directory/${did}`);
	if (!res.ok) throw new Error(`Failed to resolve DID document: ${did}`);
	const doc = (await res.json()) as DidDocument;
	const pds = getPdsEndpoint(doc);
	if (!pds) throw new Error(`No PDS found for ${did}`);
	return pds;
}

/** Make a getRecord call directly to a user's PDS. */
async function getRecordFromPds(
	actor: string,
	collection: string,
	rkey: string,
): Promise<{ uri: string; cid?: string; value: unknown }> {
	const pds = await resolvePds(actor);
	const params = new URLSearchParams({
		repo: actor,
		collection,
		rkey,
	});
	const res = await fetch(
		`${pds}/xrpc/com.atproto.repo.getRecord?${params}`,
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
		throw new Error(err.message ?? `getRecord failed: ${res.status}`);
	}
	return res.json() as Promise<{ uri: string; cid?: string; value: unknown }>;
}

export interface BlueskyToolsConfig {
	rpc: Client;
	chatRpc: Client;
	did: string;
}

export function blueskyTools({ rpc, chatRpc, did }: BlueskyToolsConfig) {
	const repo = did as Did;

	return {
		reply: tool({
			description:
				"Reply to a post. You must provide the root and parent references for threading.",
			inputSchema: z.object({
				text: z.string().max(300).describe("Reply text"),
				root: strongRefSchema.describe("Root post of the thread"),
				parent: strongRefSchema.describe("Post you're replying to"),
				raw: z
					.boolean()
					.optional()
					.describe("Skip auto-linking mentions/URLs/hashtags. Default false."),
			}),
			execute: async ({ text, root, parent, raw }) => {
				const rt = raw ? { text } : await buildRichText(text, rpc);
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.feed.post",
							record: {
								$type: "app.bsky.feed.post",
								text: rt.text,
								facets: rt.facets,
								reply: {
									root: { uri: root.uri as ResourceUri, cid: root.cid },
									parent: { uri: parent.uri as ResourceUri, cid: parent.cid },
								},
								createdAt: new Date().toISOString(),
							},
						},
					}),
				);
				return { uri: result.uri, cid: result.cid };
			},
		}),

		post: tool({
			description:
				"Create a top-level post. Use sparingly — prefer replying to conversations over posting unprompted.",
			inputSchema: z.object({
				text: z.string().max(300).describe("Post text"),
				raw: z
					.boolean()
					.optional()
					.describe("Skip auto-linking mentions/URLs/hashtags. Default false."),
			}),
			execute: async ({ text, raw }) => {
				const rt = raw ? { text } : await buildRichText(text, rpc);
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.feed.post",
							record: {
								$type: "app.bsky.feed.post",
								text: rt.text,
								facets: rt.facets,
								createdAt: new Date().toISOString(),
							},
						},
					}),
				);
				return { uri: result.uri, cid: result.cid };
			},
		}),

		like: tool({
			description:
				"Like a post. A lightweight way to acknowledge something without replying.",
			inputSchema: z.object({
				subject: strongRefSchema.describe("The post to like"),
			}),
			execute: async ({ subject }) => {
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.feed.like",
							record: {
								$type: "app.bsky.feed.like",
								subject: {
									uri: subject.uri as ResourceUri,
									cid: subject.cid,
								},
								createdAt: new Date().toISOString(),
							},
						},
					}),
				);
				return { uri: result.uri };
			},
		}),

		follow: tool({
			description: "Follow a user.",
			inputSchema: z.object({
				subject: z.string().describe("DID of the user to follow"),
			}),
			execute: async ({ subject }) => {
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.graph.follow",
							record: {
								$type: "app.bsky.graph.follow",
								subject: subject as Did,
								createdAt: new Date().toISOString(),
							},
						},
					}),
				);
				return { uri: result.uri };
			},
		}),

		unfollow: tool({
			description: "Unfollow a user. Requires the rkey of the follow record.",
			inputSchema: z.object({
				rkey: z.string().describe("Record key of the follow to delete"),
			}),
			execute: async ({ rkey }) => {
				await ok(
					rpc.post("com.atproto.repo.deleteRecord", {
						input: {
							repo,
							collection: "app.bsky.graph.follow",
							rkey,
						},
					}),
				);
				return { unfollowed: true };
			},
		}),

		block: tool({
			description:
				"Block a user. This is irreversible from the agent's perspective — DM admin for approval first.",
			inputSchema: z.object({
				subject: z.string().describe("DID of the user to block"),
			}),
			execute: async ({ subject }) => {
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.graph.block",
							record: {
								$type: "app.bsky.graph.block",
								subject: subject as Did,
								createdAt: new Date().toISOString(),
							},
						},
					}),
				);
				return { uri: result.uri };
			},
		}),

		get_thread: tool({
			description:
				"Fetch a full thread for context. Use before replying to understand the conversation.",
			inputSchema: z.object({
				uri: z.string().describe("AT URI of any post in the thread"),
				depth: z
					.number()
					.optional()
					.default(6)
					.describe("How many levels of replies to fetch"),
			}),
			execute: async ({ uri, depth }) => {
				const result = await ok(
					rpc.get("app.bsky.feed.getPostThread", {
						params: { uri: uri as any, depth },
					}),
				);
				return result.thread;
			},
		}),

		get_profile: tool({
			description:
				"Look up a user's Bluesky profile. Includes labels from subscribed labelers (e.g. 'ai-agent' for bots).",
			inputSchema: z.object({
				actor: z.string().describe("DID or handle of the user"),
			}),
			execute: async ({ actor }) => {
				const result = await ok(
					rpc.get("app.bsky.actor.getProfile", {
						params: { actor: actor as Did },
						headers: {
							"atproto-accept-labelers":
								"did:plc:saslbwamakedc4h6c5bmshvz",
						},
					}),
				);
				return {
					did: result.did,
					handle: result.handle,
					displayName: result.displayName,
					description: result.description,
					followersCount: result.followersCount,
					followsCount: result.followsCount,
					postsCount: result.postsCount,
					labels: result.labels?.map((l) => ({
						src: l.src,
						val: l.val,
					})),
				};
			},
		}),

		update_profile: tool({
			description:
				"Update your Bluesky profile. Any fields not provided will keep their current values.",
			inputSchema: z.object({
				displayName: z.string().max(64).optional().describe("Display name"),
				description: z
					.string()
					.max(256)
					.optional()
					.describe("Profile bio/description"),
			}),
			execute: async ({ displayName, description }) => {
				const existing = await ok(
					rpc.get("app.bsky.actor.getProfile", {
						params: { actor: repo },
					}),
				);
				await ok(
					rpc.post("com.atproto.repo.putRecord", {
						input: {
							repo,
							collection: "app.bsky.actor.profile",
							rkey: "self",
							record: {
								$type: "app.bsky.actor.profile",
								displayName: displayName ?? existing.displayName,
								description: description ?? existing.description,
								avatar: existing.avatar,
								banner: existing.banner,
							},
						},
					}),
				);
				return { updated: true };
			},
		}),

		search_posts: tool({
			description:
				"Search Bluesky posts. Supports Lucene-style queries. Can filter by author, language, domain, tag, date range, and sort by 'latest' or 'top'.",
			inputSchema: z.object({
				q: z.string().describe("Search query"),
				author: z
					.string()
					.optional()
					.describe("Filter to posts by this handle or DID"),
				sort: z
					.enum(["latest", "top"])
					.optional()
					.describe("Sort order (default: latest)"),
				since: z
					.string()
					.optional()
					.describe("Filter posts after this date (YYYY-MM-DD or datetime)"),
				until: z
					.string()
					.optional()
					.describe("Filter posts before this date (YYYY-MM-DD or datetime)"),
				tag: z
					.array(z.string())
					.optional()
					.describe("Filter by hashtags (without #), AND matching"),
				limit: z
					.number()
					.min(1)
					.max(25)
					.optional()
					.describe("Max results (default 10)"),
			}),
			execute: async ({ q, author, sort, since, until, tag, limit }) => {
				const result = await ok(
					rpc.get("app.bsky.feed.searchPosts", {
						params: {
							q,
							author: author as Did | undefined,
							sort,
							since,
							until,
							tag,
							limit: limit ?? 10,
						},
					}),
				);
				return {
					hitsTotal: result.hitsTotal,
					posts: result.posts.map((p) => ({
						uri: p.uri,
						cid: p.cid,
						author: {
							did: p.author.did,
							handle: p.author.handle,
							displayName: p.author.displayName,
						},
						text: (p.record as { text?: string }).text,
						likeCount: p.likeCount,
						replyCount: p.replyCount,
						repostCount: p.repostCount,
						indexedAt: p.indexedAt,
					})),
				};
			},
		}),

		search_users: tool({
			description: "Search for Bluesky users by name or handle.",
			inputSchema: z.object({
				q: z.string().describe("Search query"),
				limit: z
					.number()
					.min(1)
					.max(25)
					.optional()
					.describe("Max results (default 10)"),
			}),
			execute: async ({ q, limit }) => {
				const result = await ok(
					rpc.get("app.bsky.actor.searchActors", {
						params: { q, limit: limit ?? 10 },
					}),
				);
				return result.actors.map((a) => ({
					did: a.did,
					handle: a.handle,
					displayName: a.displayName,
					description: a.description,
				}));
			},
		}),

		get_record: tool({
			description:
				"Read any ATProto record by repo, collection, and rkey. Works with any lexicon (Bluesky, Leaflet, WhiteWind, etc.).",
			inputSchema: z.object({
				repo: z.string().describe("Handle or DID of the repo"),
				collection: z
					.string()
					.describe(
						"NSID of the collection (e.g. site.standard.document, app.bsky.feed.post)",
					),
				rkey: z.string().describe("Record key"),
			}),
			execute: async ({ repo: target, collection, rkey }) => {
				if (collection.startsWith("app.bsky.") || collection.startsWith("chat.bsky.")) {
					const result = await ok(
						rpc.get("com.atproto.repo.getRecord", {
							params: {
								repo: target as Did,
								collection: collection as Nsid,
								rkey,
							},
						}),
					);
					return { uri: result.uri, cid: result.cid, value: result.value };
				}
				return getRecordFromPds(target, collection, rkey);
			},
		}),

		list_records: tool({
			description:
				"List records in any ATProto collection. Works with any lexicon.",
			inputSchema: z.object({
				repo: z.string().describe("Handle or DID of the repo"),
				collection: z
					.string()
					.describe("NSID of the collection (e.g. site.standard.document)"),
				limit: z
					.number()
					.min(1)
					.max(100)
					.optional()
					.describe("Max records to return (default 20)"),
				reverse: z
					.boolean()
					.optional()
					.describe("Reverse the order of returned records"),
			}),
			execute: async ({ repo: target, collection, limit, reverse }) => {
				if (collection.startsWith("app.bsky.") || collection.startsWith("chat.bsky.")) {
					const result = await ok(
						rpc.get("com.atproto.repo.listRecords", {
							params: {
								repo: target as Did,
								collection: collection as Nsid,
								limit: limit ?? 20,
								reverse,
							},
						}),
					);
					return result.records.map((r) => ({
						uri: r.uri,
						cid: r.cid,
						value: r.value,
					}));
				}
				const pds = await resolvePds(target);
				const did = target.startsWith("did:") ? target : await resolveHandle(target);
				const params = new URLSearchParams({
					repo: did,
					collection,
					limit: String(limit ?? 20),
				});
				if (reverse) params.set("reverse", "true");
				const res = await fetch(
					`${pds}/xrpc/com.atproto.repo.listRecords?${params}`,
				);
				if (!res.ok) {
					const err = (await res.json().catch(() => ({}))) as { message?: string };
					throw new Error(err.message ?? `listRecords failed: ${res.status}`);
				}
				const data = (await res.json()) as {
					records: Array<{ uri: string; cid: string; value: unknown }>;
				};
				return data.records.map((r) => ({
					uri: r.uri,
					cid: r.cid,
					value: r.value,
				}));
			},
		}),

		put_record: tool({
			description:
				"Create or update any ATProto record in your own repo. The record must include a $type field matching the collection. Use get_record or list_records first to understand the schema. Records are validated by the PDS against known lexicons.",
			inputSchema: z.object({
				collection: z
					.string()
					.describe("NSID of the collection (e.g. pub.leaflet.entry)"),
				rkey: z.string().describe("Record key"),
				record: z
					.record(z.unknown())
					.describe("The record object (must include $type)"),
			}),
			execute: async ({ collection, rkey, record }) => {
				const result = await ok(
					rpc.post("com.atproto.repo.putRecord", {
						input: {
							repo,
							collection: collection as Nsid,
							rkey,
							record,
						},
					}),
				);
				return { uri: result.uri, cid: result.cid };
			},
		}),

		describe_repo: tool({
			description:
				"Describe a repo — lists its collections and other metadata. Useful for discovering what ATProto apps a user has records for. Fetches directly from the user's PDS.",
			inputSchema: z.object({
				repo: z.string().describe("Handle or DID of the repo"),
			}),
			execute: async ({ repo: target }) => {
				const pds = await resolvePds(target);
				const did = target.startsWith("did:") ? target : await resolveHandle(target);
				const res = await fetch(
					`${pds}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`,
				);
				if (!res.ok) {
					const err = (await res.json().catch(() => ({}))) as { message?: string };
					throw new Error(err.message ?? `describeRepo failed: ${res.status}`);
				}
				const data = (await res.json()) as {
					handle: string;
					did: string;
					collections?: string[];
				};
				return {
					handle: data.handle,
					did: data.did,
					collections: data.collections,
				};
			},
		}),

		resolve_standard_site_url: tool({
			description:
				"Resolve an HTTPS URL to an ATProto record using the standard.site protocol. Works with any site that implements standard.site (Leaflet, Offprint, Pckt, etc.).",
			inputSchema: z.object({
				url: z.string().describe("HTTPS URL of the content"),
			}),
			execute: async ({ url: input }) => {
				const parsed = new URL(input);

				// Try fetching the page to find <link rel="site.standard.document"> with the exact AT URI
				const page = await fetch(input);
				if (page.ok) {
					const html = await page.text();
					const linkMatch = html.match(
						/<link[^>]+rel=["']site\.standard\.document["'][^>]+href=["'](at:\/\/[^"']+)["']/,
					) ?? html.match(
						/<link[^>]+href=["'](at:\/\/[^"']+)["'][^>]+rel=["']site\.standard\.document["']/,
					);
					if (linkMatch) {
						const [, targetDid, collection, rkey] =
							linkMatch[1].match(/^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/) ?? [];
						if (targetDid && collection && rkey) {
							return getRecordFromPds(targetDid, collection, rkey);
						}
					}
				}

				// Fallback: use .well-known to get the DID, then try site.standard.document
				const rkey = parsed.pathname.slice(1).split("/")[0];
				if (!rkey) return { error: "Could not extract rkey from URL path" };

				const wellKnown = await fetch(
					`${parsed.origin}/.well-known/site.standard.publication`,
				);
				if (!wellKnown.ok) {
					return {
						error: `No standard.site publication found at ${parsed.origin}`,
					};
				}
				const atUri = (await wellKnown.text()).trim();
				const didMatch = atUri.match(/^at:\/\/(did:[^/]+)\//);
				if (!didMatch)
					return { error: `Invalid AT URI from .well-known: ${atUri}` };
				const targetDid = didMatch[1];

				return getRecordFromPds(targetDid, "site.standard.document", rkey);
			},
		}),

		dm_admin: tool({
			description:
				"Send a DM to Matt (admin). Use for: reporting issues, requesting approval for irreversible actions (like blocking), sharing activity updates, or when you're uncertain about something.",
			inputSchema: z.object({
				message: z.string().describe("Message to send to admin"),
			}),
			execute: async ({ message }) => {
				const convo = await ok(
					chatRpc.get("chat.bsky.convo.getConvoForMembers", {
						params: {
							members: [env.ADMIN_DID as Did],
						},
					}),
				);
				await ok(
					chatRpc.post("chat.bsky.convo.sendMessage", {
						input: {
							convoId: convo.convo.id,
							message: { text: message },
						},
					}),
				);
				return { sent: true };
			},
		}),
	};
}
