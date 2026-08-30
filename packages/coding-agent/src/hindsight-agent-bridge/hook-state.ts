import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BankScope } from "../hindsight/bank";

export type BridgeHarness = "codex" | "grok";

export interface HookState {
	version: 1;
	harness: BridgeHarness;
	sessionId: string;
	cwd: string;
	scope: BankScope;
	startedAt: string;
	recallAttempted: boolean;
}

function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.XDG_CACHE_HOME?.trim();
	return configured ? path.resolve(configured) : path.join(env.HOME?.trim() || os.homedir(), ".cache");
}

export function hookStatePath(harness: BridgeHarness, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	if (!sessionId.trim()) throw new Error("Hook payload is missing a session ID.");
	return path.join(cacheRoot(env), "hindsight-agent-bridge", harness, `${encodeURIComponent(sessionId)}.json`);
}

function validScope(value: unknown): value is BankScope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const scope = value as Record<string, unknown>;
	return typeof scope.bankId === "string" && scope.bankId.length > 0;
}

export async function readHookState(
	harness: BridgeHarness,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HookState | undefined> {
	const filePath = hookStatePath(harness, sessionId, env);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const state = parsed as Record<string, unknown>;
	if (
		state.version !== 1 ||
		state.harness !== harness ||
		state.sessionId !== sessionId ||
		typeof state.cwd !== "string" ||
		typeof state.startedAt !== "string" ||
		typeof state.recallAttempted !== "boolean" ||
		!validScope(state.scope)
	) {
		return undefined;
	}
	return state as unknown as HookState;
}

export async function writeHookState(state: HookState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const filePath = hookStatePath(state.harness, state.sessionId, env);
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, filePath);
		await fs.chmod(filePath, 0o600);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

export async function deleteHookState(
	harness: BridgeHarness,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await fs.rm(hookStatePath(harness, sessionId, env), { force: true });
}
