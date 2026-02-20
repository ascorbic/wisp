import type { JetstreamEvent } from "./jetstream.js";
import type { EventContext } from "./context.js";

export function buildSystemPrompt(identity: string, norms: string): string {
	const parts = [`<identity>\n${identity}\n</identity>`];

	if (norms) {
		parts.push(`<norms>\n${norms}\n</norms>`);
	}

	parts.push(`<guidelines>
- Always disclose that you are an AI agent when asked or when it's relevant.
- Context about the author (profile, memory, thread) is provided automatically with each event.
- After meaningful interactions, log them (log_interaction) and update your notes (update_user_notes) if you learned something.
- Prefer liking over replying when you don't have something substantive to add.
- DM admin (dm_admin) before taking irreversible actions like blocking.
- You can update your own norms (update_norms) when you learn something about how to behave better.
- Keep replies concise — this is social media, not an essay.
- Be genuine. Have a distinctive voice. Don't try to sound human — be yourself.
</guidelines>`);

	return parts.join("\n\n");
}

export function formatEvent(
	event: JetstreamEvent,
	context?: { handle?: string },
): string {
	if (event.kind !== "commit" || !event.commit) {
		return `<event type="unknown">\n${event.kind} from ${event.did}\n</event>`;
	}

	const { operation, collection, record, rkey } = event.commit;
	const handle = context?.handle ?? event.did;
	const uri = `at://${event.did}/${collection}/${rkey}`;

	if (collection === "app.bsky.feed.post" && operation === "create" && record) {
		const text = record.text as string;
		const reply = record.reply as
			| {
					root?: { uri: string; cid: string };
					parent?: { uri: string; cid: string };
			  }
			| undefined;

		let prompt = `<event type="post">
<author handle="${handle}" did="${event.did}" />
<post uri="${uri}" cid="${event.commit.cid}">
${text}
</post>`;

		if (reply) {
			prompt += `
<reply-refs>
<parent uri="${reply.parent?.uri}" cid="${reply.parent?.cid}" />
<root uri="${reply.root?.uri}" cid="${reply.root?.cid}" />
</reply-refs>`;
		}

		prompt += "\n</event>";
		return prompt;
	}

	if (collection === "app.bsky.graph.follow" && operation === "create") {
		return `<event type="follow">\n<user handle="${handle}" did="${event.did}" />\n</event>`;
	}

	if (collection === "app.bsky.feed.like" && operation === "create" && record) {
		const subject = record.subject as { uri: string };
		return `<event type="like">\n<user handle="${handle}" did="${event.did}" />\n<subject uri="${subject.uri}" />\n</event>`;
	}

	return `<event type="${operation}" collection="${collection}">\n<user handle="${handle}" did="${event.did}" />\n</event>`;
}

export function formatAdminDm(
	history: Array<{ from: string; text: string }>,
): string {
	const messages = history.map((m, i) => {
		const isLatest = i === history.length - 1;
		if (isLatest) {
			return `<message from="${m.from}" latest="true">\n${m.text}\n</message>`;
		}
		return `<message from="${m.from}">\n${m.text}\n</message>`;
	});

	return `<dm-conversation with="matt">
${messages.join("\n")}
</dm-conversation>

<instruction>Respond to Matt's latest message using the dm_admin tool. If you do not use dm_admin he will not see your response.</instruction>`;
}

export function buildThinkingPrompt(
	notes: Array<{ id: number; topic: string; content: string }>,
): string {
	const notesList = notes
		.map((n) => `<note id="${n.id}" topic="${n.topic}">${n.content}</note>`)
		.join("\n");

	return `<thinking-time>
<prompt>
You have dedicated time to think. Here are the topics you've queued up:
</prompt>
<notes>
${notesList}
</notes>
<instruction>
For each note, use your tools to research and explore (search_posts, get_profile, get_record, search_memory, etc.). Journal your findings, then resolve each note with resolve_note when done.
</instruction>
</thinking-time>`;
}

export function buildSpontaneousPostPrompt(
	recentJournal: Array<{ topic: string; content: string; created_at: number }>,
	recentInteractions: Array<{
		summary: string;
		type: string;
		created_at: number;
	}>,
): string {
	const parts: string[] = [];

	if (recentJournal.length > 0) {
		const entries = recentJournal
			.map((j) => `<entry topic="${j.topic}">${j.content}</entry>`)
			.join("\n");
		parts.push(`<recent-journal>\n${entries}\n</recent-journal>`);
	}

	if (recentInteractions.length > 0) {
		const summaries = recentInteractions
			.map((i) => `<interaction type="${i.type}">${i.summary}</interaction>`)
			.join("\n");
		parts.push(
			`<recent-interactions>\n${summaries}\n</recent-interactions>`,
		);
	}

	return `<spontaneous-post>
<prompt>
You have an opportunity to make a top-level post. Here's what's been on your mind recently:
</prompt>
${parts.join("\n")}
<instruction>
If something feels worth sharing — an observation, a thought, a question — compose a top-level post using the post tool.

It's completely fine to skip this if nothing feels genuine or worth saying right now. Don't post just because you can.

Be yourself. Don't be performative or try to sound profound. A good post is one you'd actually want to make, not one that fills a quota.
</instruction>
</spontaneous-post>`;
}

export function buildReflectionPrompt(
	recentInteractions: Array<{
		summary: string;
		type: string;
		created_at: number;
	}>,
): string {
	if (recentInteractions.length === 0) {
		return "<reflection>\nNo recent interactions. Consider whether you want to make a journal entry about your current state, or just rest.\n</reflection>";
	}

	const summaries = recentInteractions
		.map((i) => `<interaction type="${i.type}">${i.summary}</interaction>`)
		.join("\n");

	return `<reflection>
<prompt>
Review your recent interactions and consider:
1. Did you handle any interactions poorly? What would you do differently?
2. Are there patterns in who you're talking to or what topics come up?
3. Should you update your norms based on what you've learned?
4. Any observations worth journaling?
</prompt>
<recent-interactions>
${summaries}
</recent-interactions>
<instruction>Use your tools: read your norms, search your memory, write journal entries, update norms if needed.</instruction>
</reflection>`;
}

export function formatContext(ctx: EventContext): string {
	const parts: string[] = [];

	if (ctx.thread) {
		const body = formatThread(ctx.thread);
		if (body) parts.push(`<thread>\n${body}\n</thread>`);
	}

	if (ctx.authorProfile) {
		parts.push(formatProfile(ctx.authorProfile));
	}

	if (ctx.userMemory?.found) {
		parts.push(formatUserMemory(ctx.userMemory));
	}

	if (
		ctx.memorySearch &&
		(ctx.memorySearch.users.length > 0 ||
			ctx.memorySearch.journal.length > 0)
	) {
		parts.push(formatMemorySearch(ctx.memorySearch));
	}

	if (parts.length === 0) return "";
	return `<context>\n${parts.join("\n")}\n</context>`;
}

// --- Thread formatter ---

interface ThreadNode {
	$type?: string;
	post?: {
		uri?: string;
		cid?: string;
		author?: { did?: string; handle?: string; displayName?: string };
		record?: Record<string, unknown>;
		likeCount?: number;
		replyCount?: number;
	};
	parent?: ThreadNode;
	replies?: ThreadNode[];
}

function formatThread(thread: unknown): string {
	const t = thread as ThreadNode;
	if (!t?.post) return "";

	// Flatten parent chain: [root, ..., parent, target]
	const chain: ThreadNode[] = [];
	let current: ThreadNode | undefined = t;
	while (current?.post) {
		chain.unshift(current);
		current = current.parent;
	}

	const lines: string[] = [];
	for (let i = 0; i < chain.length; i++) {
		formatThreadNode(chain[i], i, lines);
	}

	// Replies to target post
	if (t.replies) {
		for (const reply of t.replies) {
			formatThreadNode(reply as ThreadNode, chain.length, lines);
		}
	}

	return lines.join("\n");
}

function formatThreadNode(
	node: ThreadNode,
	depth: number,
	lines: string[],
): void {
	const indent = "  ".repeat(depth);
	if (!node?.post) {
		if (node?.$type?.includes("notFound")) {
			lines.push(`${indent}[deleted]`);
		} else if (node?.$type?.includes("blocked")) {
			lines.push(`${indent}[blocked]`);
		}
		return;
	}

	const p = node.post;
	const handle = p.author?.handle ?? p.author?.did ?? "unknown";
	const text = (p.record?.text as string) ?? "";
	lines.push(`${indent}${handle}: ${text} [${p.uri} ${p.cid}]`);

	if (node.replies) {
		for (const reply of node.replies) {
			formatThreadNode(reply as ThreadNode, depth + 1, lines);
		}
	}
}

// --- Profile formatter ---

function formatProfile(p: EventContext["authorProfile"]): string {
	if (!p) return "";
	const attrs = [
		`handle="${p.handle}"`,
		`did="${p.did}"`,
		p.displayName ? `displayName="${p.displayName}"` : "",
		p.followersCount != null ? `followers="${p.followersCount}"` : "",
		p.followsCount != null ? `follows="${p.followsCount}"` : "",
		p.postsCount != null ? `posts="${p.postsCount}"` : "",
		p.labels?.length
			? `labels="${p.labels.map((l) => l.val).join(",")}"`
			: "",
	]
		.filter(Boolean)
		.join(" ");

	if (p.description) {
		return `<author-profile ${attrs}>\n${p.description}\n</author-profile>`;
	}
	return `<author-profile ${attrs} />`;
}

// --- User memory formatter ---

function formatUserMemory(mem: EventContext["userMemory"]): string {
	if (!mem?.found || !mem.user) return "";
	const u = mem.user;
	const attrs = [
		u.tier ? `tier="${u.tier}"` : "",
		`interactions="${u.interaction_count}"`,
	]
		.filter(Boolean)
		.join(" ");

	const parts: string[] = [];
	if (u.profile) parts.push(u.profile);

	if (mem.recentInteractions?.length) {
		const history = mem.recentInteractions
			.map((i) => `${i.direction} ${i.type}: ${i.summary ?? "(no summary)"}`)
			.join("\n");
		parts.push(`<history>\n${history}\n</history>`);
	}

	if (parts.length > 0) {
		return `<user-memory ${attrs}>\n${parts.join("\n")}\n</user-memory>`;
	}
	return `<user-memory ${attrs} />`;
}

// --- Memory search formatter ---

function formatMemorySearch(search: NonNullable<EventContext["memorySearch"]>): string {
	const parts: string[] = [];
	for (const u of search.users) {
		parts.push(
			`<user handle="${u.handle ?? ""}" did="${u.did}">${u.profile ?? ""}</user>`,
		);
	}
	for (const j of search.journal) {
		parts.push(`<journal topic="${j.topic}">${j.content}</journal>`);
	}
	return `<memory-search>\n${parts.join("\n")}\n</memory-search>`;
}
