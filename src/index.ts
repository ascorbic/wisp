export { Wisp } from "./agent.js";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Route all requests to the single Wisp DO instance
		const id = env.WISP.idFromName("wisp");
		const stub = env.WISP.get(id);
		return stub.fetch(request);
	},
};
