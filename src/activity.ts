const ACTIVITY_WINDOW = 60 * 60 * 1_000; // 1 hour

interface ToolCall {
	toolName: string;
	args?: Record<string, unknown>;
	input?: unknown;
}

type SqlFn = <T = Record<string, string | number | boolean | null>>(
	strings: TemplateStringsArray,
	...values: (string | number | boolean | null)[]
) => T[];

/** Summarize a tool call into a compact one-liner, or null to skip. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string | null {
	switch (name) {
		// Actions
		case "like":
			return `Liked ${(args.subject as { uri?: string })?.uri ?? "a post"}`;
		case "reply":
			return `Replied: ${truncate(args.text as string, 80)}`;
		case "post":
			return `Posted: ${truncate(args.text as string, 80)}`;
		case "dm_admin":
			return `DMd admin: ${truncate(args.message as string, 80)}`;
		case "follow":
			return `Followed ${args.subject}`;
		case "unfollow":
			return `Unfollowed rkey:${args.rkey}`;
		case "block":
			return `Blocked ${args.subject}`;
		case "delete_post":
			return `Deleted post rkey:${args.rkey}`;
		case "update_profile":
			return "Updated profile";
		case "update_norms":
			return "Updated norms";
		case "put_record":
			return `Put record ${args.collection}/${args.rkey}`;

		// Memory writes
		case "journal":
			return `Journaled: ${args.topic}`;
		case "note_to_self":
			return `Noted to self: ${args.topic}`;
		case "resolve_note":
			return `Resolved note #${args.id}`;
		case "log_interaction":
			return `Logged ${args.direction} ${args.type}`;
		case "update_user_notes":
			return `Updated notes on ${args.did}`;
		case "set_user_tier":
			return `Set ${args.did} to tier ${args.tier}`;

		// Reads worth noting (shows what the agent was investigating)
		case "get_timeline":
			return "Browsed timeline";
		case "get_feed":
			return `Browsed feed ${args.feed}`;
		case "get_thread":
			return `Fetched thread ${args.uri}`;
		case "get_profile":
			return `Looked up ${args.actor}`;
		case "search_posts":
			return `Searched posts: ${args.q}`;
		case "search_users":
			return `Searched users: ${args.q}`;
		case "search_memory":
			return `Searched memory: ${args.query}`;
		case "get_user":
			return `Looked up user ${args.did}`;
		case "get_record":
			return `Read record ${args.collection}/${args.rkey}`;
		case "list_records":
			return `Listed ${args.collection} records`;
		case "describe_repo":
			return `Described repo ${args.repo}`;
		case "resolve_standard_site_url":
			return `Resolved URL ${args.url}`;

		// Skip routine internal reads
		case "read_identity":
		case "read_norms":
		case "get_notes_to_self":
		case "query_users":
			return null;

		default:
			return `${name}(${Object.keys(args).join(", ")})`;
	}
}

/** Record tool calls from a completed generateText result. */
export function recordActivity(sql: SqlFn, steps: Array<{ toolCalls: ToolCall[] }>): void {
	const now = Date.now();

	// Prune old entries
	sql`DELETE FROM activity_log WHERE created_at < ${now - ACTIVITY_WINDOW}`;

	for (const step of steps) {
		for (const call of step.toolCalls) {
			const args = (call.args ?? call.input ?? {}) as Record<string, unknown>;
			const summary = summarizeToolCall(call.toolName, args);
			if (summary) {
				sql`INSERT INTO activity_log (summary, created_at) VALUES (${summary}, ${now})`;
			}
		}
	}
}

/** Format recent activity for inclusion in prompts. Returns empty string if nothing recent. */
export function formatRecentActivity(sql: SqlFn): string {
	const since = Date.now() - ACTIVITY_WINDOW;
	const entries = sql<{ summary: string; created_at: number }>`
		SELECT summary, created_at FROM activity_log
		WHERE created_at > ${since}
		ORDER BY created_at ASC`;

	if (entries.length === 0) return "";

	const now = Date.now();
	const lines = entries.map((e) => {
		const ago = formatAge(now - e.created_at);
		return `<action time="${ago}">${e.summary}</action>`;
	});

	return `<recent-activity>\n${lines.join("\n")}\n</recent-activity>`;
}

function truncate(s: string, max: number): string {
	if (!s) return "";
	return s.length <= max ? s : s.slice(0, max) + "...";
}

function formatAge(ms: number): string {
	if (ms < 60_000) return "just now";
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ago`;
}
