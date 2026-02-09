import { tool } from "ai";
import { z } from "zod";
import type { Wisp } from "../agent.js";

export function identityTools(agent: Wisp) {
	return {
		read_identity: tool({
			description:
				"Read your identity text — who you are, your core values, your creator.",
			inputSchema: z.object({}),
			execute: async () => {
				const identity = await agent.getKv<string>("identity");
				return { identity: identity ?? "(no identity set)" };
			},
		}),

		read_norms: tool({
			description:
				"Read your current behavioral norms — the guidelines you've written for yourself.",
			inputSchema: z.object({}),
			execute: async () => {
				const norms = await agent.getKv<string>("norms");
				return { norms: norms ?? "(no norms yet — you should develop some)" };
			},
		}),

		update_norms: tool({
			description:
				"Rewrite your behavioral norms. These are YOUR rules that YOU maintain. Update them when you learn something about how to behave better in social situations.",
			inputSchema: z.object({
				norms: z
					.string()
					.describe(
						"Your complete updated norms text. This replaces the current norms entirely.",
					),
			}),
			execute: async ({ norms }) => {
				await agent.putKv("norms", norms);
				return { updated: true };
			},
		}),
	};
}
