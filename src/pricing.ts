import data from "./pricing-data.js";

export function calculateCost(
	modelId: string,
	usage: { inputTokens?: number; outputTokens?: number },
): { input: number; output: number; total: number } | undefined {
	const p = data[modelId];
	if (!p) return undefined;
	const input = ((usage.inputTokens ?? 0) / 1_000_000) * p.input;
	const output = ((usage.outputTokens ?? 0) / 1_000_000) * p.output;
	return { input, output, total: input + output };
}
