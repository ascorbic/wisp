# Wisp

Autonomous AI agent on Bluesky, running on Cloudflare Workers + Durable Objects.

## Stack

- **Cloudflare Agents SDK** (`agents`) — single DO with built-in scheduling, SQLite, WebSocket
- **Vercel AI SDK v6** (`ai`) — model-agnostic tool loop via `generateText` + `stopWhen`
- **Cloudflare AI Gateway** (`ai-gateway-provider`) — unified provider with stored BYOK keys. Model configurable via `MODEL` env var (e.g. `google-ai-studio/gemini-2.5-flash`)
- **atcute** (`@atcute/client`, `@atcute/bluesky`, `@atcute/atproto`) — lightweight ATProto client

## Architecture

Single Durable Object (`Wisp`) handles everything:
- Jetstream WebSocket consumer (raw WS, not `@atcute/jetstream` — partysocket doesn't fit DO lifecycle)
- LLM tool loop: prompt -> model -> execute tool calls -> loop (max 8 steps)
- SQLite for structured state (users, interactions, journal, tracked_threads)
- DO KV for simple state (identity, norms, jetstream cursor)
- Alarm-based scheduling: reconnect, reflection (6h cron), admin DM polling (60s)

All requests route through a single DO instance (`env.WISP.idFromName("wisp")`).

## Key files

- `src/agent.ts` — main DO class, event handling, tool loop
- `src/index.ts` — worker entry point, routes to DO
- `src/jetstream.ts` — raw WebSocket Jetstream consumer
- `src/prompt.ts` — system prompt builder, event formatters
- `src/schema.ts` — SQLite schema migrations (FTS5 for search)
- `src/tools/bluesky.ts` — Bluesky action tools (reply, post, like, follow, block, DM)
- `src/tools/memory.ts` — SQLite memory tools (users, interactions, journal, search)
- `src/tools/identity.ts` — identity and norms read/write tools
- `src/types.ts` — branded ATProto types (`Did`, `AtUri`)

## Types

Run `wrangler types` after changing `wrangler.jsonc`. Output goes to `worker-configuration.d.ts` (included in tsconfig). No manual `env.ts` — `Env` is generated.

## Secrets

All config is in `.dev.vars` (gitignored). Push to Cloudflare with:

```
npx wrangler secret bulk .dev.vars
```

## Dev

```
pnpm dev        # wrangler dev
pnpm deploy     # wrangler deploy
```

Hit `/start` to connect Jetstream and begin scheduling. `/status` for diagnostics.
