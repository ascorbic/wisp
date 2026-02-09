/**
 * Raw Jetstream WebSocket consumer for Durable Objects.
 * No @atcute/jetstream dependency — just a WebSocket and JSON parsing.
 */

export interface JetstreamEvent {
	did: string;
	time_us: number;
	kind: "commit" | "identity" | "account";
	commit?: {
		rev: string;
		operation: "create" | "update" | "delete";
		collection: string;
		rkey: string;
		record?: Record<string, unknown>;
		cid?: string;
	};
}

export interface JetstreamConfig {
	/** Collections to subscribe to */
	collections: string[];
	/** Cursor to resume from (unix microseconds) */
	cursor?: number;
	/** Called for each event */
	onEvent: (event: JetstreamEvent) => void | Promise<void>;
	/** Called on close (for reconnection scheduling) */
	onClose: () => void;
}

const JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";

export function connectJetstream(config: JetstreamConfig): WebSocket {
	const params = new URLSearchParams();
	for (const c of config.collections) {
		params.append("wantedCollections", c);
	}
	if (config.cursor) {
		// Roll back 10 seconds to avoid gaps on reconnect
		const safetyMargin = 10_000_000; // 10s in microseconds
		params.set("cursor", String(config.cursor - safetyMargin));
	}

	const ws = new WebSocket(`${JETSTREAM_URL}?${params}`);

	ws.addEventListener("message", async (event) => {
		try {
			const msg: JetstreamEvent = JSON.parse(
				typeof event.data === "string" ? event.data : "",
			);
			await config.onEvent(msg);
		} catch (err) {
			console.error("Jetstream message parse error:", err);
		}
	});

	ws.addEventListener("close", () => {
		console.log("Jetstream WebSocket closed");
		config.onClose();
	});

	ws.addEventListener("error", (event) => {
		console.error("Jetstream WebSocket error:", event);
		ws.close();
	});

	return ws;
}
