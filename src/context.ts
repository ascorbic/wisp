import { ok } from "@atcute/client";
import type { Client } from "@atcute/client";
import type { Did } from "@atcute/lexicons";
import type { JetstreamEvent } from "./jetstream.js";

type SqlFn = <T = Record<string, string | number | boolean | null>>(
	strings: TemplateStringsArray,
	...values: (string | number | boolean | null)[]
) => T[];

export interface AuthorProfile {
	did: string;
	handle: string;
	displayName?: string;
	description?: string;
	followersCount?: number;
	followsCount?: number;
	postsCount?: number;
	labels?: Array<{ src: string; val: string }>;
}

export interface EventContext {
	authorProfile?: AuthorProfile;
	userMemory?: {
		found: boolean;
		user?: {
			did: string;
			handle: string | null;
			profile: string | null;
			tier: string | null;
			interaction_count: number;
		};
		recentInteractions?: Array<{
			direction: string;
			type: string;
			summary: string | null;
			created_at: number;
		}>;
	};
	thread?: unknown;
	memorySearch?: {
		users: Array<{ did: string; handle: string | null; profile: string | null }>;
		journal: Array<{
			topic: string;
			content: string;
			created_at: number;
		}>;
	};
}

async function fetchProfile(
	rpc: Client,
	did: string,
): Promise<AuthorProfile | undefined> {
	try {
		const result = await ok(
			rpc.get("app.bsky.actor.getProfile", {
				params: { actor: did as Did },
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
			labels: result.labels?.map((l) => ({ src: l.src, val: l.val })),
		};
	} catch {
		return undefined;
	}
}

function fetchUserMemory(
	sql: SqlFn,
	did: string,
): EventContext["userMemory"] {
	const [user] = sql<{
		did: string;
		handle: string | null;
		profile: string | null;
		tier: string | null;
		interaction_count: number;
	}>`SELECT did, handle, profile, tier, interaction_count FROM users WHERE did = ${did}`;
	if (!user) return { found: false };
	const recentInteractions = sql<{
		direction: string;
		type: string;
		summary: string | null;
		created_at: number;
	}>`SELECT direction, type, summary, created_at FROM interactions WHERE user_did = ${did} ORDER BY created_at DESC LIMIT 20`;
	return { found: true, user, recentInteractions };
}

async function fetchThread(
	rpc: Client,
	uri: string,
): Promise<unknown> {
	try {
		const result = await ok(
			rpc.get("app.bsky.feed.getPostThread", {
				params: { uri: uri as any, depth: 6 },
			}),
		);
		return result.thread;
	} catch {
		return undefined;
	}
}

function searchMemory(
	sql: SqlFn,
	text: string,
): EventContext["memorySearch"] {
	const query = text.replace(/[^\w\s]/g, " ").trim();
	if (!query) return { users: [], journal: [] };
	try {
		const users =
			sql<{ did: string; handle: string | null; profile: string | null }>`SELECT u.did, u.handle, u.profile FROM users_fts f JOIN users u ON f.rowid = u.rowid WHERE users_fts MATCH ${query} LIMIT 5`;
		const journal =
			sql<{ topic: string; content: string; created_at: number }>`SELECT j.topic, j.content, j.created_at FROM journal_fts f JOIN journal j ON f.rowid = j.rowid WHERE journal_fts MATCH ${query} ORDER BY j.created_at DESC LIMIT 5`;
		return { users, journal };
	} catch {
		return { users: [], journal: [] };
	}
}

export async function fetchEventContext(
	event: JetstreamEvent,
	deps: { rpc: Client; sql: SqlFn },
): Promise<EventContext> {
	if (event.kind !== "commit" || !event.commit) return {};

	const { collection, record } = event.commit;

	if (collection === "app.bsky.feed.post" && record) {
		const text = record.text as string;
		const reply = record.reply as
			| { parent?: { uri: string } }
			| undefined;

		const [authorProfile, userMemory, thread, memorySearch] =
			await Promise.all([
				fetchProfile(deps.rpc, event.did),
				fetchUserMemory(deps.sql, event.did),
				reply?.parent?.uri
					? fetchThread(deps.rpc, reply.parent.uri)
					: undefined,
				searchMemory(deps.sql, text),
			]);

		return { authorProfile, userMemory, thread, memorySearch };
	}

	if (
		collection === "app.bsky.graph.follow" ||
		collection === "app.bsky.feed.like"
	) {
		const [authorProfile, userMemory] = await Promise.all([
			fetchProfile(deps.rpc, event.did),
			fetchUserMemory(deps.sql, event.did),
		]);
		return { authorProfile, userMemory };
	}

	return {};
}
