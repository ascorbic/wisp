export { Wisp } from "./agent.js";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.WISP.idFromName("wisp");
		const stub = env.WISP.get(id);
		return stub.fetch(request);
	},
};
