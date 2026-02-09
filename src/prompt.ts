import type { JetstreamEvent } from "./jetstream.js";

export function buildSystemPrompt(identity: string, norms: string): string {
	const parts = [identity];

	if (norms) {
		parts.push(`## Your Norms\n\nThese are behavioral guidelines you've developed through experience:\n\n${norms}`);
	}

	parts.push(`## Guidelines

- Always disclose that you are an AI agent when asked or when it's relevant.
- Check your memory (get_user) before responding to someone you may have interacted with before.
- After meaningful interactions, log them (log_interaction) and update user profiles if you learned something.
- Prefer liking over replying when you don't have something substantive to add.
- DM admin (dm_admin) before taking irreversible actions like blocking.
- You can update your own norms (update_norms) when you learn something about how to behave better.
- Keep replies concise — this is social media, not an essay.
- Be genuine. Have a distinctive voice. Don't try to sound human — be yourself.`);

	return parts.join("\n\n");
}

export function formatEvent(event: JetstreamEvent, context?: { handle?: string }): string {
	if (event.kind !== "commit" || !event.commit) {
		return `Event: ${event.kind} from ${event.did}`;
	}

	const { operation, collection, record, rkey } = event.commit;
	const handle = context?.handle ?? event.did;
	const uri = `at://${event.did}/${collection}/${rkey}`;

	if (collection === "app.bsky.feed.post" && operation === "create" && record) {
		const text = record.text as string;
		const reply = record.reply as { root?: { uri: string; cid: string }; parent?: { uri: string; cid: string } } | undefined;

		let prompt = `@${handle} posted: "${text}"\nPost URI: ${uri}\nPost CID: ${event.commit.cid}`;

		if (reply) {
			prompt += `\n\nThis is a reply in a thread.`;
			prompt += `\nParent: ${reply.parent?.uri} (cid: ${reply.parent?.cid})`;
			prompt += `\nRoot: ${reply.root?.uri} (cid: ${reply.root?.cid})`;
			prompt += `\n\nUse get_thread to fetch the full thread context before responding.`;
		}

		return prompt;
	}

	if (collection === "app.bsky.graph.follow" && operation === "create") {
		return `@${handle} (${event.did}) followed you.`;
	}

	if (collection === "app.bsky.feed.like" && operation === "create" && record) {
		const subject = record.subject as { uri: string };
		return `@${handle} liked your post: ${subject.uri}`;
	}

	return `Event: ${operation} on ${collection} from @${handle} (${event.did})`;
}

export function formatAdminDm(text: string, senderDid: string): string {
	return `Admin (Matt) sent you a DM: "${text}"\n\nRespond to admin requests. Matt can ask you about your memory, relationships, journal, recent activity, or anything else. Use your tools to look up what he asks about and respond via dm_admin.`;
}

export function buildReflectionPrompt(recentInteractions: Array<{ summary: string; type: string; created_at: number }>): string {
	if (recentInteractions.length === 0) {
		return "It's time for reflection, but you haven't had any recent interactions. Consider whether you want to make a journal entry about your current state, or just rest.";
	}

	const summaries = recentInteractions
		.map((i) => `- [${i.type}] ${i.summary}`)
		.join("\n");

	return `Time for reflection. Review your recent interactions and consider:

1. Did you handle any interactions poorly? What would you do differently?
2. Are there patterns in who you're talking to or what topics come up?
3. Should you update your norms based on what you've learned?
4. Any observations worth journaling?

Recent interactions:
${summaries}

Use your tools: read your norms, search your memory, write journal entries, update norms if needed.`;
}
