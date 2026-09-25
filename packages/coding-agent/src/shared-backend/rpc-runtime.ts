import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import { type RpcAgentProcess, RpcClient } from "../modes/rpc/rpc-client";
import { RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../modes/rpc/rpc-types";
import { type BackendRuntime, type BackendSessionOptions, type BackendUiResponse } from "./session-host";
import { BackendUiBroker } from "./ui-broker";

export interface BackendRpcOptions {
	command: string[];
	cwd: string;
	sessionRoot: string;
	profile?: string;
}

/** Reuses the normal RPC command/lifecycle implementation; only the UI transport is bridged. */
export class BackendRpcRuntime implements BackendRuntime {
	#client: RpcClient;
	#child?: RpcAgentProcess;
	#ui: BackendUiBroker;
	#observer?: Promise<void>;
	#observerAbort = new AbortController();
	#sessionDir: string;

	constructor(options: BackendRpcOptions, session: BackendSessionOptions, emit: (event: unknown) => void, exited: () => void) {
		this.#sessionDir = path.join(options.sessionRoot, session.id);
		this.#ui = new BackendUiBroker(response => this.#respond(response), emit);
		this.#client = new RpcClient({
			cwd: options.cwd, sessionDir: this.#sessionDir, provider: session.provider, model: session.model,
			args: options.profile ? ["--profile", options.profile] : [],
			spawn: args => {
				const env = { ...Bun.env };
				// The agent needs provider credentials, not the backend's administrative bearer token.
				delete env.OMP_SERVER_TOKEN;
				const child = ptree.spawn([...options.command, ...args], { cwd: options.cwd, env, stdin: "pipe" });
				const [stdout, uiStream] = child.stdout.tee();
				const transport: RpcAgentProcess = {
					stdin: child.stdin, stdout, peekStderr: () => child.peekStderr(),
					kill: (signal, graceMs) => child.kill(signal, graceMs), exited: child.exited,
				};
				this.#child = transport;
				void child.exited.then(exited, exited);
				this.#observer = this.#observe(uiStream).catch(() => {
					if (!this.#observerAbort.signal.aborted) {
						exited();
						try { child.kill(); } catch { /* The worker may already be reaped. */ }
					}
				});
				return transport;
			},
		});
		this.#client.onSessionEvent(emit);
		this.#client.onPromptResult(emit);
		this.#client.onSessionSettled(() => emit({ type: "session_settled" }));
		this.#client.onSubagentLifecycle(payload => emit({ type: "subagent_lifecycle", payload }));
		this.#client.onSubagentProgress(payload => emit({ type: "subagent_progress", payload }));
	}

	async start(): Promise<void> {
		// Exclusive creation prevents accidentally adopting another live session directory.
		await fs.mkdir(this.#sessionDir, { mode: 0o700 });
		try {
			await this.#client.start();
			await this.#client.setSubagentSubscription("progress");
		} catch (error) { await this.stop(); throw error; }
	}
	async stop(): Promise<void> {
		this.#ui.dispose();
		this.#observerAbort.abort();
		await this.#client.stop();
		await this.#observer;
		this.#child = undefined;
	}
	prompt(message: string): Promise<string> { return this.#client.prompt(message); }
	abort(): Promise<void> { return this.#client.abort(); }
	getState(): Promise<unknown> { return this.#client.getState(); }
	getMessagesPage(options: { cursor?: string; limit?: number }): Promise<unknown> { return this.#client.getMessagesPage(options); }
	getPendingUi(): unknown[] { return this.#ui.list(); }
	respondUi(response: BackendUiResponse): Promise<void> { return this.#ui.respond(response); }

	async #observe(stream: ReadableStream<Uint8Array>): Promise<void> {
		// RpcClient currently exposes UI callbacks only within login(). Decode this second
		// branch with the SAME framing and stream helpers, rather than a second RPC dispatcher.
		const decoder = new RpcFrameDecoder();
		for await (const line of readJsonl(stream, this.#observerAbort.signal)) {
			const frame = decoder.push(line);
			if (isRecord(frame) && frame.type === "extension_ui_request")
				this.#ui.observe(frame as unknown as RpcExtensionUIRequest);
		}
	}
	async #respond(response: RpcExtensionUIResponse): Promise<void> {
		if (!this.#child) throw new Error("RPC worker is not connected");
		const stdin = this.#child.stdin;
		stdin.write(`${JSON.stringify(response)}\n`);
		if ("flush" in stdin) await (stdin as FileSink).flush();
	}
}
