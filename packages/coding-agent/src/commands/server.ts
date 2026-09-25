import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { SharedBackendClient } from "../shared-backend/client";
import { startSharedBackendServer } from "../shared-backend/server";
import type { BackendUiResponse } from "../shared-backend/session-host";

async function writeJson(value: unknown): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
	await promise;
}
function numberFlag(value: string | undefined, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliUsageError(`${name} must be a nonnegative integer`);
	return Number(value);
}

export default class Server extends Command {
	static description = "Run or connect to the opt-in shared session backend";
	static args = {
		action: Args.string({ description: "Backend action (default: list)", required: false,
			options: ["serve", "list", "new", "info", "state", "messages", "prompt", "abort", "close", "events", "ui", "respond"] }),
		session: Args.string({ description: "Backend session ID", required: false }),
	};
	static flags = {
		url: Flags.string({ description: "Backend URL (otherwise OMP_SERVER_URL or http://127.0.0.1:7467)" }),
		cwd: Flags.string({ description: "Workspace directory (serve only)" }),
		port: Flags.string({ description: "Loopback listening port; 0 allocates one (serve only)" }),
		provider: Flags.string({ description: "Provider for a new session" }),
		model: Flags.string({ description: "Model for a new session" }),
		message: Flags.string({ description: "Prompt text" }),
		"request-id": Flags.string({ description: "Caller-generated prompt retry ID, or pending UI request ID" }),
		after: Flags.string({ description: "Replay after this sequence; default follows new events" }),
		cursor: Flags.string({ description: "Transcript pagination cursor (messages only)" }),
		limit: Flags.string({ description: "Transcript page size, 1-128 (messages only)" }),
		value: Flags.string({ description: "Text/selection answer (respond only)" }),
		answer: Flags.string({ description: "Explicit true or false confirmation (respond only)" }),
		cancel: Flags.boolean({ description: "Cancel the pending UI question (respond only)", default: false }),
	};
	static examples = ["omp server serve --cwd .", "omp server new", "omp server list", "omp server events <session-id>"];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Server);
		const token = Bun.env.OMP_SERVER_TOKEN;
		if (!token) throw new CliUsageError("Set OMP_SERVER_TOKEN to a secret of at least 32 characters; it is never accepted in argv");
		const action = args.action ?? "list";
		const needsSession = !["serve", "list", "new"].includes(action);
		if (argv.length > (needsSession ? 2 : 1) || (needsSession && !args.session))
			throw new CliUsageError(`Usage: omp server ${action}${needsSession ? " <session-id>" : ""}`);
		if (action === "serve") {
			// Re-enter the existing CLI RPC mode, including source, npm bundle and compiled installs.
			const command = process.env.PI_COMPILED === "true" ? [process.execPath] : [process.execPath, Bun.main];
			const server = await startSharedBackendServer({ token, cwd: flags.cwd, port: numberFlag(flags.port, "port", 7467), command });
			const { promise, resolve } = Promise.withResolvers<void>();
			const stop = () => resolve();
			process.once("SIGINT", stop); process.once("SIGTERM", stop);
			try {
				await writeJson({ url: server.url, epoch: server.host.epoch, mode: "shared-backend" });
				await promise;
			} finally {
				process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
				await server.stop();
			}
			return;
		}
		const client = await SharedBackendClient.connect({ url: flags.url ?? Bun.env.OMP_SERVER_URL ?? "http://127.0.0.1:7467", token });
		if (action === "list") { await writeJson({ sessions: await client.list() }); return; }
		if (action === "new") { await writeJson({ session: await client.create({ provider: flags.provider, model: flags.model }) }); return; }
		const id = args.session!;
		switch (action) {
			case "info": await writeJson({ session: await client.info(id) }); break;
			case "state": await writeJson(await client.state(id)); break;
			case "messages": await writeJson(await client.messages(id, { cursor: flags.cursor, limit: numberFlag(flags.limit, "limit", 64) })); break;
			case "prompt": {
				if (!flags.message) throw new CliUsageError("prompt requires --message");
				const requestId = flags["request-id"] ?? crypto.randomUUID();
				// Print the retry ID before I/O so a lost acknowledgement is recoverable without duplicating work.
				await writeJson({ type: "submission", sessionId: id, requestId });
				await writeJson(await client.prompt(id, flags.message, requestId));
				break;
			}
			case "abort": await client.abort(id); await writeJson({ aborted: true }); break;
			case "close": await client.close(id); await writeJson({ closed: true }); break;
			case "ui": await writeJson({ requests: await client.pendingUi(id) }); break;
			case "respond": {
				const requestId = flags["request-id"];
				if (!requestId) throw new CliUsageError("respond requires --request-id");
				if (flags.answer !== undefined && flags.answer !== "true" && flags.answer !== "false")
					throw new CliUsageError("--answer must be true or false");
				const choices = [flags.value !== undefined, flags.answer !== undefined, flags.cancel].filter(Boolean).length;
				if (choices !== 1) throw new CliUsageError("Supply exactly one of --value, --answer, or --cancel");
				const response: BackendUiResponse = { id: requestId };
				if (flags.cancel) response.cancelled = true;
				else if (flags.answer !== undefined) response.confirmed = flags.answer === "true";
				else response.value = flags.value;
				await client.respondUi(id, response);
				await writeJson({ accepted: true });
				break;
			}
			case "events": {
				let cursor = numberFlag(flags.after, "after", (await client.info(id)).cursor);
				const controller = new AbortController();
				const detach = () => controller.abort();
				process.once("SIGINT", detach); process.once("SIGTERM", detach);
				try {
					await writeJson({ type: "attached", epoch: client.epoch, sessionId: id, cursor });
					while (!controller.signal.aborted) {
						const batch = await client.events(id, cursor, controller.signal);
						for (const event of batch.events) await writeJson(event);
						cursor = batch.cursor;
						if (batch.events.some(event => typeof event.data === "object" && event.data !== null
							&& "type" in event.data && ["backend_closing", "backend_failed"].includes(String(event.data.type)))) break;
						// A client attaching after the terminal lifecycle event must not busy-poll forever.
						if (!batch.events.length && ["closing", "failed"].includes((await client.info(id)).status)) break;
					}
				} catch (error) { if (!controller.signal.aborted) throw error; }
				finally { process.removeListener("SIGINT", detach); process.removeListener("SIGTERM", detach); }
				break;
			}
		}
	}
}
