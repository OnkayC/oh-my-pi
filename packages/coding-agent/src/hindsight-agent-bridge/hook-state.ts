import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BankScope } from "../hindsight/bank";
import { resolvePrimaryProjectRoot } from "../hindsight/project-root";

export type BridgeHarness = "amp" | "codex" | "grok";

export interface TranscriptCursor {
	source: string;
	messageCount: number;
	prefixKey: string;
}

export interface HookState {
	version: 2;
	harness: BridgeHarness;
	sessionId: string;
	cwd: string;
	primaryRoot: string;
	scope: BankScope;
	startedAt: string;
	recallAttempted: boolean;
	segment: number;
	pendingProjectContext?: boolean;
	cursor?: TranscriptCursor;
	needsBoundary: boolean;
	transcript: string;
	userTurns: number;
	retainedTurns: number;
	messageCount: number;
	retainedMessageCount: number;
}

export function hookDocumentId(state: HookState): string {
	return `bridge:${state.harness}:${encodeURIComponent(state.sessionId)}:${state.segment}`;
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
	const strings = (item: unknown): boolean =>
		item === undefined || (Array.isArray(item) && item.every(tag => typeof tag === "string"));
	return (
		typeof scope.bankId === "string" &&
		scope.bankId.length > 0 &&
		strings(scope.retainTags) &&
		strings(scope.recallTags) &&
		(scope.recallTagsMatch === undefined ||
			["any", "all", "any_strict", "all_strict"].includes(String(scope.recallTagsMatch))) &&
		(scope.observationScopes === undefined ||
			(Array.isArray(scope.observationScopes) &&
				scope.observationScopes.every(tags => Array.isArray(tags) && strings(tags))))
	);
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCursor(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const cursor = value as Record<string, unknown>;
	return (
		typeof cursor.source === "string" &&
		nonnegativeInteger(cursor.messageCount) &&
		typeof cursor.prefixKey === "string"
	);
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
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid bridge session state: ${filePath}`);
	}
	const state = parsed as Record<string, unknown>;
	if (
		state.harness !== harness ||
		state.sessionId !== sessionId ||
		typeof state.cwd !== "string" ||
		!path.isAbsolute(state.cwd) ||
		typeof state.startedAt !== "string" ||
		typeof state.recallAttempted !== "boolean" ||
		!validScope(state.scope)
	) {
		throw new Error(`Invalid bridge session state: ${filePath}`);
	}
	if (state.version === 1) {
		// Old caches have no transcript boundary. Preserve the latch, but never
		// attribute their unknown historical transcript to the current project.
		return {
			version: 2,
			harness,
			sessionId,
			cwd: state.cwd,
			primaryRoot: resolvePrimaryProjectRoot(state.cwd) ?? state.cwd,
			scope: state.scope,
			startedAt: state.startedAt,
			recallAttempted: state.recallAttempted,
			segment: 0,
			needsBoundary: true,
			transcript: "",
			userTurns: 0,
			retainedTurns: 0,
			messageCount: 0,
			retainedMessageCount: 0,
		};
	}
	if (
		state.version !== 2 ||
		typeof state.primaryRoot !== "string" ||
		!nonnegativeInteger(state.segment) ||
		(state.pendingProjectContext !== undefined && typeof state.pendingProjectContext !== "boolean") ||
		!validCursor(state.cursor) ||
		typeof state.needsBoundary !== "boolean" ||
		typeof state.transcript !== "string" ||
		!nonnegativeInteger(state.userTurns) ||
		!nonnegativeInteger(state.retainedTurns) ||
		!nonnegativeInteger(state.messageCount) ||
		!nonnegativeInteger(state.retainedMessageCount)
	) {
		throw new Error(`Invalid bridge session state: ${filePath}`);
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
