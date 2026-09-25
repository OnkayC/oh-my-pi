import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { BACKEND_MAX_BODY_BYTES, createBackendHandler } from "./http";
import { BackendRpcRuntime } from "./rpc-runtime";
import { SharedSessionHost } from "./session-host";

export interface SharedBackendServer {
	url: string;
	host: SharedSessionHost;
	stop(): Promise<void>;
}
export interface SharedBackendServerOptions {
	token: string;
	port?: number;
	cwd?: string;
	/** Explicit CLI argv prefix for SDK embedding. The omp CLI supplies its current entry. */
	command: string[];
	onError?: (error: unknown) => void;
}

/** Explicit, foreground, loopback-only server. It does not start or replace other servers. */
export async function startSharedBackendServer(options: SharedBackendServerOptions): Promise<SharedBackendServer> {
	const port = options.port ?? 7467;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid backend port");
	if (!options.command.length || options.command.some(arg => !arg)) throw new Error("An agent command is required");
	const cwd = await fs.realpath(options.cwd ?? process.cwd());
	if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Backend cwd must be a directory");
	const sessionRoot = path.join(getAgentDir(), "shared-backend-sessions");
	await fs.mkdir(sessionRoot, { recursive: true, mode: 0o700 });
	const host = new SharedSessionHost((session, emit, exited) => new BackendRpcRuntime({
		command: options.command, cwd, sessionRoot, profile: getActiveProfile() ?? undefined,
	}, session, emit, exited));
	let authority = "";
	const fetch = createBackendHandler(host, { token: options.token, authority: () => authority, onError: options.onError });
	const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 30, maxRequestBodySize: BACKEND_MAX_BODY_BYTES, fetch });
	authority = `127.0.0.1:${server.port}`;
	let stopped: Promise<void> | undefined;
	return {
		url: `http://${authority}`, host,
		stop: () => {
			if (stopped) return stopped;
			// Reject/abort new and waiting HTTP work before reaping the owned runtimes.
			server.stop(true);
			stopped = host.shutdown();
			return stopped;
		},
	};
}
