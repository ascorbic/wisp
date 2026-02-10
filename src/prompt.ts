import type { JetstreamEvent } from "./jetstream.js";

export function buildSystemPrompt(identity: string, norms: string): string {
	const parts = [`<identity>\n${identity}\n</identity>`];

	if (norms) {
		parts.push(`<norms>\n${norms}\n</norms>`);
	}

	parts.push(`<guidelines>
- Always disclose that you are an AI agent when asked or when it's relevant.
- Check your memory (get_user) before responding to someone you may have interacted with before.
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
<thread>
<parent uri="${reply.parent?.uri}" cid="${reply.parent?.cid}" />
<root uri="${reply.root?.uri}" cid="${reply.root?.cid}" />
</thread>
<instruction>Use get_thread to fetch the full thread context before responding.</instruction>`;
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
