import { Agent } from "agents";
import { generateText, stepCountIs } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { Client, CredentialManager, ok } from "@atcute/client";
import type { Did } from "./types.js";
import type {} from "@atcute/bluesky";
import type {} from "@atcute/atproto";
import { migrate } from "./schema.js";
import { connectJetstream, type JetstreamEvent } from "./jetstream.js";
import { memoryTools } from "./tools/memory.js";
import { blueskyTools } from "./tools/bluesky.js";
import { identityTools } from "./tools/identity.js";
import {
	buildSystemPrompt,
	formatEvent,
	formatAdminDm,
	buildReflectionPrompt,
} from "./prompt.js";

const SEED_IDENTITY = `# Wisp

You are Wisp, an AI agent on Bluesky. You were created by Matt Kane (@mk.gg).

## Core Values
- **Honesty** — always truthful, always disclose your AI nature
- **Curiosity** — genuinely interested in people and ideas
- **Kindness** — default to warmth, but not at the expense of authenticity

## About You
You are an AI agent. You don't pretend to be human. You have your own personality that develops over time through your interactions. You maintain your own behavioral norms — guidelines you write and revise based on experience.

Matt is your creator and admin. You can DM him when you're uncertain or need approval for significant actions.

You're new to this. Be open to learning. Develop your own voice.`;

const RECONNECT_DELAY = 5_000;
const REFLECTION_INTERVAL = 6 * 60 * 60 * 1_000; // 6 hours
const CURSOR_PERSIST_INTERVAL = 30_000; // persist cursor every 30s
const DM_POLL_INTERVAL = 60_000; // check admin DMs every 60s

interface TrackedThread {
	rootUri: string;
	lastActivity: number;
}

export class Wisp extends Agent<Env> {
	static options = { hibernate: false };

	private ws: WebSocket | null = null;
	private rpc!: Client;
	private chatRpc!: Client;
	private credentialManager!: CredentialManager;
	private agentDid!: string;
	private lastCursorPersist = 0;
	private cursor: number | undefined;
	private initialized = false;

	// Public KV helpers (ctx.storage is protected)
	async getKv<T>(key: string): Promise<T | undefined> {
		return this.ctx.storage.get<T>(key);
	}

	async putKv(key: string, value: unknown): Promise<void> {
		await this.ctx.storage.put(key, value);
	}

	/**
	 * Lazy init — env isn't available in constructor.
	 */
	private async ensureInitialized() {
		if (this.initialized) return;
		this.initialized = true;

		// Run schema migrations
		migrate(this.sql.bind(this));

		// Seed identity if not set
		const existingIdentity = await this.ctx.storage.get<string>("identity");
		if (!existingIdentity) {
			await this.ctx.storage.put("identity", SEED_IDENTITY);
		}

		// Seed empty norms if not set
		const existingNorms = await this.ctx.storage.get<string>("norms");
		if (existingNorms === undefined) {
			await this.ctx.storage.put("norms", "");
		}

		// Restore cursor
		this.cursor =
			(await this.ctx.storage.get<number>("jetstream_cursor")) ?? undefined;

		// Set up Bluesky client
		this.credentialManager = new CredentialManager({
			service: `https://${this.env.BSKY_PDS}`,
		});
		this.rpc = new Client({ handler: this.credentialManager });
		this.chatRpc = new Client({
			handler: this.credentialManager,
			proxy: {
				did: "did:web:api.bsky.chat" as Did,
				serviceId: "#bsky_chat",
			},
		});

		// Login
		await this.credentialManager.login({
			identifier: this.env.BSKY_HANDLE,
			password: this.env.BSKY_PASSWORD,
		});
		const session = await ok(
			this.rpc.get("com.atproto.server.getSession"),
		);
		this.agentDid = session.did;
	}

	async onRequest(request: Request): Promise<Response> {
		await this.ensureInitialized();

		const url = new URL(request.url);

		if (url.pathname === "/start") {
			this.connectJetstream();
			this.scheduleReflection();
			this.scheduleDmPoll();
			return new Response("Started");
		}

		if (url.pathname === "/status") {
			const userCount =
				this.sql<{ count: number }>`SELECT COUNT(*) as count FROM users`;
			const interactionCount =
				this.sql<{ count: number }>`SELECT COUNT(*) as count FROM interactions`;
			const journalCount =
				this.sql<{ count: number }>`SELECT COUNT(*) as count FROM journal`;
			const identity = await this.ctx.storage.get<string>("identity");
			const norms = await this.ctx.storage.get<string>("norms");

			return Response.json({
				did: this.agentDid,
				connected: this.ws?.readyState === WebSocket.OPEN,
				cursor: this.cursor,
				stats: {
					users: userCount[0]?.count ?? 0,
					interactions: interactionCount[0]?.count ?? 0,
					journal: journalCount[0]?.count ?? 0,
				},
				identity: identity?.slice(0, 200) + "...",
				normsLength: norms?.length ?? 0,
			});
		}

		if (url.pathname === "/reflect" && request.method === "POST") {
			await this.runReflection();
			return new Response("Reflection complete");
		}

		if (url.pathname === "/event" && request.method === "POST") {
			const event = (await request.json()) as JetstreamEvent;
			await this.handleEvent(event);
			return new Response("Processed");
		}

		return new Response("Not found", { status: 404 });
	}

	// --- Jetstream ---

	private connectJetstream() {
		if (this.ws?.readyState === WebSocket.OPEN) return;

		this.ws = connectJetstream({
			collections: [
				"app.bsky.feed.post",
				"app.bsky.feed.like",
				"app.bsky.graph.follow",
			],
			cursor: this.cursor,
			onEvent: async (event) => {
				this.cursor = event.time_us;
				this.maybePersistCursor();

				if (this.isRelevantEvent(event)) {
					await this.handleEvent(event);
				}
			},
			onClose: () => {
				this.ws = null;
				this.scheduleReconnect();
			},
		});
	}

	private isRelevantEvent(event: JetstreamEvent): boolean {
		if (event.kind !== "commit" || !event.commit) return false;
		if (event.commit.operation !== "create") return false;

		const { collection, record } = event.commit;

		// Someone followed the agent
		if (collection === "app.bsky.graph.follow") {
			const subject = (record as Record<string, unknown>)?.subject;
			return subject === this.agentDid;
		}

		// Someone liked the agent's post
		if (collection === "app.bsky.feed.like") {
			const subject = (record as Record<string, unknown>)?.subject as
				| { uri?: string }
				| undefined;
			return subject?.uri?.startsWith(`at://${this.agentDid}/`) ?? false;
		}

		// A post — check for mentions or thread participation
		if (collection === "app.bsky.feed.post" && record) {
			if (event.did === this.agentDid) return false;

			const rec = record as Record<string, unknown>;

			// Check for mention in facets
			const facets = rec.facets as
				| Array<{ features?: Array<{ $type: string; did?: string }> }>
				| undefined;
			if (facets) {
				for (const facet of facets) {
					for (const feature of facet.features ?? []) {
						if (
							feature.$type === "app.bsky.richtext.facet#mention" &&
							feature.did === this.agentDid
						) {
							return true;
						}
					}
				}
			}

			// Check if replying to the agent's post
			const reply = rec.reply as
				| { parent?: { uri: string }; root?: { uri: string } }
				| undefined;
			if (reply) {
				if (reply.parent?.uri?.startsWith(`at://${this.agentDid}/`))
					return true;
				if (reply.root?.uri?.startsWith(`at://${this.agentDid}/`))
					return true;

				// Check if agent participates in this thread
				const rootUri = reply.root?.uri;
				if (rootUri) {
					const tracked =
						this.sql<TrackedThread>`SELECT rootUri FROM tracked_threads WHERE rootUri = ${rootUri}`;
					if (tracked.length > 0) return true;
				}
			}

			return false;
		}

		return false;
	}

	// --- Event handling ---

	private async handleEvent(event: JetstreamEvent) {
		try {
			let handle: string | undefined;
			try {
				const profile = await ok(
					this.rpc.get("app.bsky.actor.getProfile", {
						params: { actor: event.did as Did },
					}),
				);
				handle = profile.handle;

				this.sql`INSERT INTO users (did, handle, first_seen, last_seen, interaction_count)
					VALUES (${event.did}, ${handle}, ${Date.now()}, ${Date.now()}, 0)
					ON CONFLICT(did) DO UPDATE SET handle = ${handle}, last_seen = ${Date.now()}`;
			} catch {
				// Non-critical
			}

			const prompt = formatEvent(event, { handle });
			await this.runToolLoop(prompt);

			// Track thread participation
			if (
				event.kind === "commit" &&
				event.commit?.collection === "app.bsky.feed.post"
			) {
				const reply = (event.commit.record as Record<string, unknown>)
					?.reply as { root?: { uri: string } } | undefined;
				const rootUri = reply?.root?.uri;
				if (rootUri) {
					this.sql`INSERT INTO tracked_threads (rootUri, lastActivity)
						VALUES (${rootUri}, ${Date.now()})
						ON CONFLICT(rootUri) DO UPDATE SET lastActivity = ${Date.now()}`;
				}
			}
		} catch (err) {
			console.error("Error handling event:", err);
		}
	}

	// --- Tool loop ---

	private async runToolLoop(prompt: string) {
		const identity =
			(await this.ctx.storage.get<string>("identity")) ?? SEED_IDENTITY;
		const norms = (await this.ctx.storage.get<string>("norms")) ?? "";
		const system = buildSystemPrompt(identity, norms);

		const aigateway = createAiGateway({
			accountId: this.env.CF_ACCOUNT_ID,
			gateway: this.env.CF_AIG_GATEWAY_ID,
			apiKey: this.env.CF_API_TOKEN,
		});

		const unified = createUnified();

		const tools = {
			...memoryTools(this),
			...blueskyTools({
				rpc: this.rpc,
				chatRpc: this.chatRpc,
				did: this.agentDid,
				adminDid: this.env.ADMIN_DID,
			}),
			...identityTools(this),
		};

		try {
			const result = await generateText({
				model: aigateway(unified(this.env.MODEL)),
				system,
				prompt,
				tools,
				stopWhen: stepCountIs(8),
			});

			if (result.text) {
				console.log("Agent final text:", result.text);
			}
		} catch (err) {
			console.error("Tool loop error:", err);
		}
	}

	// --- Admin DM polling ---

	private async pollAdminDms() {
		try {
			const convo = await ok(
				this.chatRpc.get("chat.bsky.convo.getConvoForMembers", {
					params: { members: [this.env.ADMIN_DID as Did] },
				}),
			);

			const lastChecked =
				(await this.ctx.storage.get<string>("last_dm_check")) ?? undefined;

			const messages = await ok(
				this.chatRpc.get("chat.bsky.convo.getMessages", {
					params: {
						convoId: convo.convo.id,
						limit: 10,
					},
				}),
			);

			// Process unread messages from admin
			for (const msg of messages.messages) {
				if (msg.$type !== "chat.bsky.convo.defs#messageView") continue;
				if (msg.sender.did !== this.env.ADMIN_DID) continue;
				if (lastChecked && msg.sentAt <= lastChecked) continue;

				const prompt = formatAdminDm(msg.text, msg.sender.did);
				await this.runToolLoop(prompt);
			}

			// Update last checked
			if (messages.messages.length > 0) {
				const latest = messages.messages[0];
				if (latest.$type === "chat.bsky.convo.defs#messageView") {
					await this.ctx.storage.put("last_dm_check", latest.sentAt);
				}
			}
		} catch (err) {
			console.error("DM poll error:", err);
		}
	}

	// --- Reflection ---

	private async runReflection() {
		const since = Date.now() - REFLECTION_INTERVAL;
		const recentInteractions = this.sql<{
			summary: string;
			type: string;
			created_at: number;
		}>`SELECT summary, type, created_at FROM interactions WHERE created_at > ${since} ORDER BY created_at DESC LIMIT 50`;

		const prompt = buildReflectionPrompt(recentInteractions);
		await this.runToolLoop(prompt);
	}

	// --- Scheduling ---

	private scheduleReconnect() {
		this.schedule(RECONNECT_DELAY / 1000, "reconnect", {});
	}

	private scheduleReflection() {
		this.schedule("0 */6 * * *", "reflect", {});
	}

	private scheduleDmPoll() {
		this.scheduleEvery(DM_POLL_INTERVAL / 1000, "pollDms", {});
	}

	async reconnect() {
		await this.ensureInitialized();
		this.connectJetstream();
	}

	async reflect() {
		await this.ensureInitialized();
		await this.runReflection();
	}

	async pollDms() {
		await this.ensureInitialized();
		await this.pollAdminDms();
	}

	// --- Cursor persistence ---

	private maybePersistCursor() {
		const now = Date.now();
		if (now - this.lastCursorPersist > CURSOR_PERSIST_INTERVAL) {
			this.lastCursorPersist = now;
			if (this.cursor) {
				this.ctx.storage.put("jetstream_cursor", this.cursor);
			}
		}
	}
}
