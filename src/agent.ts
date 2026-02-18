import { env } from "cloudflare:workers";
import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { Client, CredentialManager, ok } from "@atcute/client";
import type { Did } from "@atcute/lexicons";
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
	buildThinkingPrompt,
} from "./prompt.js";
import SEED_IDENTITY from "./seed-identity.txt" with { type: "txt" };

const REFLECTION_INTERVAL = 6 * 60 * 60 * 1_000; // 6 hours
const THINKING_INTERVAL = 2 * 60 * 60 * 1_000; // 2 hours
const CURSOR_PERSIST_INTERVAL = 30_000; // persist cursor every 30s
const DM_POLL_INTERVAL = 60_000; // check admin DMs every 60s

interface TrackedThread {
	rootUri: string;
	lastActivity: number;
}

const credentialManager = new CredentialManager({
	service: `https://${env.BSKY_PDS}`,
});

const rpc = new Client({ handler: credentialManager });

const chatRpc = new Client({
	handler: credentialManager,
	proxy: {
		did: "did:web:api.bsky.chat" as Did,
		serviceId: "#bsky_chat",
	},
});

const aigateway = createAiGateway({
	accountId: env.CF_ACCOUNT_ID,
	gateway: env.CF_AIG_GATEWAY_ID,
	apiKey: env.CF_API_TOKEN,
});

const unified = createUnified();

export class Wisp extends DurableObject<Env> {
	private ws: WebSocket | null = null;
	private agentDid!: string;
	private lastCursorPersist = 0;
	private cursor: number | undefined;
	private initialized = false;
	private eventsReceived = 0;
	private eventsHandled = 0;
	private connectedAt: number | undefined;
	private epsWindowStart = 0;
	private epsWindowCount = 0;
	private epsPrevRate = 0;

	/** Tagged template wrapper around ctx.storage.sql.exec. Values are bound as numbered parameters (?1, ?2, ...), never interpolated. */
	sql<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[] {
		const cursor = this.ctx.storage.sql.exec(
			strings.reduce((q, s, i) => q + `?${i}` + s),
			...values,
		);
		return [...cursor] as T[];
	}

	private async ensureInitialized() {
		if (this.initialized) return;
		this.initialized = true;

		migrate(this.sql.bind(this));

		const existingIdentity = await this.ctx.storage.get<string>("identity");
		if (!existingIdentity) {
			await this.ctx.storage.put("identity", SEED_IDENTITY);
		}

		const existingNorms = await this.ctx.storage.get<string>("norms");
		if (existingNorms === undefined) {
			await this.ctx.storage.put("norms", "");
		}

		this.cursor =
			(await this.ctx.storage.get<number>("jetstream_cursor")) ?? undefined;

		await credentialManager.login({
			identifier: env.BSKY_HANDLE,
			password: env.BSKY_PASSWORD,
		});
		const session = await ok(rpc.get("com.atproto.server.getSession"));
		this.agentDid = session.did;
	}

	// Public KV helpers (ctx.storage is protected)
	async getKv<T>(key: string): Promise<T | undefined> {
		return this.ctx.storage.get<T>(key);
	}

	async putKv(key: string, value: unknown): Promise<void> {
		await this.ctx.storage.put(key, value);
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureInitialized();
		const url = new URL(request.url);

		if (url.pathname === "/start") {
			this.connectJetstream();
			this.scheduleNextAlarm();
			return new Response("Started");
		}

		if (url.pathname === "/status") {
			const userCount = this.sql<{
				count: number;
			}>`SELECT COUNT(*) as count FROM users`;
			const interactionCount = this.sql<{
				count: number;
			}>`SELECT COUNT(*) as count FROM interactions`;
			const journalCount = this.sql<{
				count: number;
			}>`SELECT COUNT(*) as count FROM journal`;
			const identity = await this.ctx.storage.get<string>("identity");
			const norms = await this.ctx.storage.get<string>("norms");

			const cursorAge = this.cursor
				? Math.round((Date.now() * 1000 - this.cursor) / 1_000_000)
				: undefined;

			return Response.json({
				did: this.agentDid,
				jetstream: {
					connected: this.ws?.readyState === WebSocket.OPEN,
					connectedFor: this.connectedAt
						? Math.round((Date.now() - this.connectedAt) / 1000)
						: undefined,
					cursorAge,
					eventsReceived: this.eventsReceived,
					eventsHandled: this.eventsHandled,
					eventsPerSecond: Math.round(this.getEps() * 100) / 100,
				},
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

	// --- Alarm ---

	async alarm() {
		await this.ensureInitialized();

		// Reconnect if needed
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.connectJetstream();
		}

		// Poll admin DMs
		await this.pollAdminDms();

		// Check if reflection is due
		const lastReflection =
			(await this.ctx.storage.get<number>("last_reflection")) ?? 0;
		if (Date.now() - lastReflection > REFLECTION_INTERVAL) {
			await this.ctx.storage.put("last_reflection", Date.now());
			await this.runReflection();
		}

		// Check if thinking time is due
		const lastThinking =
			(await this.ctx.storage.get<number>("last_thinking")) ?? 0;
		if (Date.now() - lastThinking > THINKING_INTERVAL) {
			await this.runThinkingTime();
		}

		this.scheduleNextAlarm();
	}

	private scheduleNextAlarm() {
		this.ctx.storage.setAlarm(Date.now() + DM_POLL_INTERVAL);
	}

	// --- Jetstream ---

	private connectJetstream() {
		if (this.ws?.readyState === WebSocket.OPEN) return;

		this.connectedAt = Date.now();
		this.eventsReceived = 0;
		this.eventsHandled = 0;
		this.ws = connectJetstream({
			collections: [
				"app.bsky.feed.post",
				"app.bsky.feed.like",
				"app.bsky.graph.follow",
			],
			cursor: this.cursor,
			onEvent: async (event) => {
				this.cursor = event.time_us;
				this.eventsReceived++;
				this.tickEps();
				this.maybePersistCursor();

				if (this.isRelevantEvent(event)) {
					this.eventsHandled++;
					await this.handleEvent(event);
				}
			},
			onClose: () => {
				this.ws = null;
				this.connectedAt = undefined;
			},
		});
	}

	private isRelevantEvent(event: JetstreamEvent): boolean {
		if (event.kind !== "commit" || !event.commit) return false;
		if (event.commit.operation !== "create") return false;

		const { collection, record } = event.commit;

		if (collection === "app.bsky.graph.follow") {
			return record?.subject === this.agentDid;
		}

		if (collection === "app.bsky.feed.like") {
			const subject = record?.subject as { uri?: string } | undefined;
			return subject?.uri?.startsWith(`at://${this.agentDid}/`) ?? false;
		}

		if (collection === "app.bsky.feed.post" && record) {
			if (event.did === this.agentDid) return false;

			const facets = record.facets as
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

			const reply = record.reply as
				| { parent?: { uri: string }; root?: { uri: string } }
				| undefined;
			if (reply) {
				if (reply.parent?.uri?.startsWith(`at://${this.agentDid}/`))
					return true;
				if (reply.root?.uri?.startsWith(`at://${this.agentDid}/`)) return true;

				const rootUri = reply.root?.uri;
				if (rootUri) {
					const tracked = this
						.sql<TrackedThread>`SELECT rootUri FROM tracked_threads WHERE rootUri = ${rootUri}`;
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
					rpc.get("app.bsky.actor.getProfile", {
						params: { actor: event.did as Did },
					}),
				);
				handle = profile.handle;

				this
					.sql`INSERT INTO users (did, handle, first_seen, last_seen, interaction_count)
					VALUES (${event.did}, ${handle}, ${Date.now()}, ${Date.now()}, 0)
					ON CONFLICT(did) DO UPDATE SET handle = ${handle}, last_seen = ${Date.now()}`;
			} catch {
				// Non-critical
			}

			const prompt = formatEvent(event, { handle });
			await this.runToolLoop(prompt);

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

		const tools = {
			...memoryTools(this),
			...blueskyTools({
				rpc,
				chatRpc,
				did: this.agentDid,
			}),
			...identityTools(this),
		};

		try {
			console.log("Tool loop start:", prompt.slice(0, 200));

			const result = await generateText({
				model: aigateway(unified(env.MODEL)),
				system,
				prompt,
				tools,
				stopWhen: stepCountIs(8),
			});

			for (const step of result.steps) {
				for (const call of step.toolCalls) {
					console.log(
						`Tool call: ${call.toolName}(${JSON.stringify("args" in call ? call.args : {})})`,
					);
				}
				for (const toolResult of step.toolResults) {
					const output = JSON.stringify("result" in toolResult ? toolResult.result : {});
					console.log(
						`Tool result: ${toolResult.toolName} → ${output.slice(0, 500)}`,
					);
				}
				if (step.text) {
					console.log("Step text:", step.text.slice(0, 500));
				}
			}

			console.log(
				`Tool loop done: ${result.steps.length} steps, ${result.usage.inputTokens ?? 0}in/${result.usage.outputTokens ?? 0}out (${result.usage.totalTokens} total)`,
			);
		} catch (err) {
			console.error("Tool loop error:", err);
		}
	}

	// --- Admin DM polling ---

	private async pollAdminDms() {
		try {
			const convo = await ok(
				chatRpc.get("chat.bsky.convo.getConvoForMembers", {
					params: { members: [env.ADMIN_DID as Did] },
				}),
			);

			const lastChecked =
				(await this.ctx.storage.get<string>("last_dm_check")) ?? undefined;

			const messages = await ok(
				chatRpc.get("chat.bsky.convo.getMessages", {
					params: {
						convoId: convo.convo.id,
						limit: 10,
					},
				}),
			);

			const hasUnread = messages.messages.some((msg) => {
				if (msg.$type !== "chat.bsky.convo.defs#messageView") return false;
				if (msg.sender.did !== env.ADMIN_DID) return false;
				if (lastChecked && msg.sentAt <= lastChecked) return false;
				return true;
			});

			if (hasUnread) {
				const history = messages.messages
					.filter(
						(m): m is typeof m & { text: string } =>
							m.$type === "chat.bsky.convo.defs#messageView",
					)
					.reverse()
					.map((m) => ({
						from: m.sender.did === this.agentDid ? "wisp" : "matt",
						text: m.text,
					}));

				const prompt = formatAdminDm(history);
				await this.runToolLoop(prompt);

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

	private async runThinkingTime() {
		const notes = this.sql<{
			id: number;
			topic: string;
			content: string;
		}>`SELECT id, topic, content FROM notes_to_self WHERE status = 'pending' ORDER BY created_at ASC`;

		if (notes.length === 0) return;

		await this.ctx.storage.put("last_thinking", Date.now());
		const prompt = buildThinkingPrompt(notes);
		await this.runToolLoop(prompt);
	}

	// --- EPS tracking ---

	private tickEps() {
		this.epsWindowCount++;
		if (this.epsWindowStart === 0) {
			this.epsWindowStart = Date.now();
		} else if (this.epsWindowCount % 1000 === 0) {
			const now = Date.now();
			if (now - this.epsWindowStart >= 60_000) {
				this.epsPrevRate = this.epsWindowCount / ((now - this.epsWindowStart) / 1000);
				this.epsWindowCount = 0;
				this.epsWindowStart = now;
			}
		}
	}

	private getEps(): number {
		const now = Date.now();
		if (this.epsWindowStart === 0) return 0;
		const elapsed = (now - this.epsWindowStart) / 1000;
		if (elapsed < 5) return this.epsPrevRate;
		return this.epsWindowCount / elapsed;
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
