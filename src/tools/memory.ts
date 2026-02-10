import { tool } from "ai";
import { z } from "zod";
import type { Wisp } from "../agent.js";

interface User {
	did: string;
	handle: string | null;
	profile: string | null;
	tier: string | null;
	interaction_count: number;
	first_seen: number;
	last_seen: number;
}

interface Interaction {
	id: number;
	user_did: string;
	direction: string;
	type: string;
	uri: string | null;
	summary: string | null;
	created_at: number;
}

interface JournalEntry {
	id: number;
	topic: string;
	content: string;
	created_at: number;
}

export function memoryTools(agent: Wisp) {
	const sql = agent.sql.bind(agent);

	return {
		get_user: tool({
			description:
				"Look up a user in your memory — your private notes, relationship tier, and interaction history. Use before responding to someone you may have talked to before. Use get_profile to fetch their public Bluesky profile.",
			inputSchema: z.object({
				did: z.string().describe("The user's DID"),
			}),
			execute: async ({ did }) => {
				const [user] = sql<User>`SELECT * FROM users WHERE did = ${did}`;
				if (!user) return { found: false };
				const interactions =
					sql<Interaction>`SELECT * FROM interactions WHERE user_did = ${did} ORDER BY created_at DESC LIMIT 20`;
				return { found: true, user, recentInteractions: interactions };
			},
		}),

		update_user_notes: tool({
			description:
				"Update your private notes about a known user. Write what you've learned about them in natural language.",
			inputSchema: z.object({
				did: z.string().describe("The user's DID"),
				notes: z
					.string()
					.describe(
						"Your notes about this person — observations, context, preferences",
					),
			}),
			execute: async ({ did, notes }) => {
				sql`UPDATE users SET profile = ${notes} WHERE did = ${did}`;
				return { updated: true };
			},
		}),

		set_user_tier: tool({
			description:
				"Update a user's relationship tier. Use tiers you define in your norms (e.g. friend, acquaintance, stranger).",
			inputSchema: z.object({
				did: z.string().describe("The user's DID"),
				tier: z.string().describe("Relationship tier"),
			}),
			execute: async ({ did, tier }) => {
				sql`UPDATE users SET tier = ${tier} WHERE did = ${did}`;
				return { updated: true };
			},
		}),

		log_interaction: tool({
			description:
				"Record an interaction with a user. Call this after each meaningful exchange.",
			inputSchema: z.object({
				user_did: z.string().describe("The user's DID"),
				direction: z
					.enum(["inbound", "outbound"])
					.describe("Direction of the interaction"),
				type: z
					.enum(["mention", "reply", "like", "follow", "dm"])
					.describe("Type of interaction"),
				uri: z
					.string()
					.optional()
					.describe("AT URI of the relevant record"),
				summary: z
					.string()
					.describe("One-line summary of the interaction"),
			}),
			execute: async ({ user_did, direction, type, uri, summary }) => {
				const now = Date.now();

				// Ensure user exists
				sql`INSERT INTO users (did, first_seen, last_seen, interaction_count)
					VALUES (${user_did}, ${now}, ${now}, 0)
					ON CONFLICT(did) DO NOTHING`;

				// Update last_seen and count
				sql`UPDATE users SET last_seen = ${now}, interaction_count = interaction_count + 1 WHERE did = ${user_did}`;

				sql`INSERT INTO interactions (user_did, direction, type, uri, summary, created_at)
					VALUES (${user_did}, ${direction}, ${type}, ${uri ?? null}, ${summary}, ${now})`;

				return { logged: true };
			},
		}),

		journal: tool({
			description:
				"Log an observation, thought, or decision to your journal. Use for things worth remembering but that don't belong in a user profile.",
			inputSchema: z.object({
				topic: z.string().describe("Short category tag"),
				content: z.string().describe("The observation or thought"),
			}),
			execute: async ({ topic, content }) => {
				const now = Date.now();
				sql`INSERT INTO journal (topic, content, created_at) VALUES (${topic}, ${content}, ${now})`;
				return { logged: true };
			},
		}),

		search_memory: tool({
			description:
				"Full-text search across your private notes and journal entries. Use when you want to recall something from your own memory.",
			inputSchema: z.object({
				query: z.string().describe("Search terms"),
			}),
			execute: async ({ query }) => {
				const users =
					sql<Pick<User, "did" | "handle" | "profile">>`SELECT u.did, u.handle, u.profile FROM users_fts f JOIN users u ON f.rowid = u.rowid WHERE users_fts MATCH ${query} LIMIT 10`;
				const entries =
					sql<JournalEntry>`SELECT j.* FROM journal_fts f JOIN journal j ON f.rowid = j.rowid WHERE journal_fts MATCH ${query} ORDER BY j.created_at DESC LIMIT 10`;
				return { users, journal: entries };
			},
		}),

		query_users: tool({
			description:
				"List known users from your memory. Filter by tier, sort by recency or interaction count. Supports pagination. Use search_users to find people on Bluesky.",
			inputSchema: z.object({
				tier: z
					.string()
					.optional()
					.describe("Filter by relationship tier"),
				limit: z.number().optional().default(20).describe("Max results"),
				offset: z.number().optional().default(0).describe("Skip this many results (for pagination)"),
				order_by: z
					.enum(["last_seen", "interaction_count", "first_seen"])
					.optional()
					.default("last_seen")
					.describe("Sort field"),
			}),
			execute: async ({ tier, limit, offset, order_by }) => {
				let users: User[];
				if (tier) {
					if (order_by === "interaction_count") {
						users = sql<User>`SELECT * FROM users WHERE tier = ${tier} ORDER BY interaction_count DESC LIMIT ${limit} OFFSET ${offset}`;
					} else if (order_by === "first_seen") {
						users = sql<User>`SELECT * FROM users WHERE tier = ${tier} ORDER BY first_seen DESC LIMIT ${limit} OFFSET ${offset}`;
					} else {
						users = sql<User>`SELECT * FROM users WHERE tier = ${tier} ORDER BY last_seen DESC LIMIT ${limit} OFFSET ${offset}`;
					}
				} else if (order_by === "interaction_count") {
					users = sql<User>`SELECT * FROM users ORDER BY interaction_count DESC LIMIT ${limit} OFFSET ${offset}`;
				} else if (order_by === "first_seen") {
					users = sql<User>`SELECT * FROM users ORDER BY first_seen DESC LIMIT ${limit} OFFSET ${offset}`;
				} else {
					users = sql<User>`SELECT * FROM users ORDER BY last_seen DESC LIMIT ${limit} OFFSET ${offset}`;
				}
				const [{ total }] = tier
					? sql<{ total: number }>`SELECT COUNT(*) as total FROM users WHERE tier = ${tier}`
					: sql<{ total: number }>`SELECT COUNT(*) as total FROM users`;
				return { users, total, offset, limit };
			},
		}),
	};
}
