import { tool } from "ai";
import { z } from "zod";
import type { Client } from "@atcute/client";
import { ok } from "@atcute/client";
import type { Did, AtUri } from "../types.js";

/** Strong reference to a record (needed for replies, likes, etc.) */
const strongRefSchema = z.object({
	uri: z.string().describe("AT URI of the record"),
	cid: z.string().describe("CID of the record"),
});

export interface BlueskyToolsConfig {
	rpc: Client;
	chatRpc: Client;
	did: string;
	adminDid: string;
}

export function blueskyTools({
	rpc,
	chatRpc,
	did,
	adminDid,
}: BlueskyToolsConfig) {
	const repo = did as Did;

	return {
		reply: tool({
			description:
				"Reply to a post. You must provide the root and parent references for threading.",
			inputSchema: z.object({
				text: z.string().max(300).describe("Reply text"),
				root: strongRefSchema.describe("Root post of the thread"),
				parent: strongRefSchema.describe("Post you're replying to"),
			}),
			execute: async ({ text, root, parent }) => {
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.feed.post",
							record: {
								$type: "app.bsky.feed.post",
								text,
								reply: {
									root: { uri: root.uri as AtUri, cid: root.cid },
									parent: { uri: parent.uri as AtUri, cid: parent.cid },
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
			}),
			execute: async ({ text }) => {
				const result = await ok(
					rpc.post("com.atproto.repo.createRecord", {
						input: {
							repo,
							collection: "app.bsky.feed.post",
							record: {
								$type: "app.bsky.feed.post",
								text,
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
									uri: subject.uri as AtUri,
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
			description: "Look up a user's Bluesky profile.",
			inputSchema: z.object({
				actor: z.string().describe("DID or handle of the user"),
			}),
			execute: async ({ actor }) => {
				const result = await ok(
					rpc.get("app.bsky.actor.getProfile", {
						params: { actor: actor as Did },
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
				};
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
							members: [adminDid as Did],
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
