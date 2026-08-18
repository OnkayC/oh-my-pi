/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { once } from "node:events";
import { type CredentialOrigin, type ImageContent, realizesPriorityServiceTier } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { $env, isRecord, readLines, Snowflake } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionToolApprovalDecision,
	type ExtensionToolApprovalRequest,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import type { LocalProtocolOptions } from "../../internal-urls";
import { type Theme, theme } from "../../modes/theme/theme";
import {
	type PlanModeArtifacts,
	PlanModeController,
	type RpcPlanModeState,
	type RpcPlanReviewDecision,
	type RpcPlanReviewResolution,
} from "../../plan-mode/controller";
import { listPlanFiles, readPlanFile, resolvePlanFilePath } from "../../plan-mode/plan-files";
import type { AgentSession } from "../../session/agent-session";
import {
	fingerprintHostTurnPayload,
	type HostTurnOperation,
	type HostTurnOutcome,
	type HostTurnRollbackInput,
	type HostTurnRollbackResult,
} from "../../session/host-turns";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails, USER_INTERRUPT_LABEL } from "../../session/messages";
import { type AcpBuiltinSlashCommandResult, executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import {
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	RpcFrameDecoder,
	RpcFrameEncoder,
	type RpcFrameEncodingOptions,
} from "./rpc-frame";
import { claimRpcInput } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcApprovalRequestFrame,
	RpcApprovalResolvedFrame,
	RpcAskRequestFrame,
	RpcAuthAccountStatus,
	RpcAuthStatus,
	RpcAuthStatusValue,
	RpcAvailableModel,
	RpcAvailableSkill,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResolvedFrame,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcResponse,
	RpcSemanticCapabilities,
	RpcSemanticCapabilityKey,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

const RPC_SEMANTIC_CAPABILITY_KEYS = [
	"structuredApprovals",
	"runtimePolicy",
	"authStatus",
	"richUserInput",
	"planControl",
	"planReview",
	"hostTurns",
	"modelCatalog",
	"slashCommands",
	"skills",
	"tasks",
	"subagents",
] as const satisfies readonly RpcSemanticCapabilityKey[];

export const RPC_SEMANTIC_CAPABILITIES = Object.freeze({
	structuredApprovals: 1,
	runtimePolicy: 1,
	authStatus: 1,
	richUserInput: 1,
	planControl: 1,
	planReview: 1,
	hostTurns: 1,
	modelCatalog: 1,
	slashCommands: 1,
	skills: 1,
	tasks: 1,
	subagents: 1,
} satisfies RpcSemanticCapabilities);

function semanticCapabilityRevision(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

/** Tracks the semantic revisions explicitly selected for one RPC connection. */
export class RpcCapabilitySelection {
	readonly #offered: RpcSemanticCapabilities;
	#selected: RpcSemanticCapabilities = {};
	#negotiated = false;

	constructor(offered: RpcSemanticCapabilities | Record<string, unknown>) {
		const normalized: RpcSemanticCapabilities = {};
		for (const key of RPC_SEMANTIC_CAPABILITY_KEYS) {
			const revision = semanticCapabilityRevision(Reflect.get(offered, key));
			if (revision !== undefined) normalized[key] = revision;
		}
		this.#offered = normalized;
	}

	get offered(): RpcSemanticCapabilities {
		return { ...this.#offered };
	}

	get selected(): RpcSemanticCapabilities {
		return { ...this.#selected };
	}

	select(requested: unknown): RpcSemanticCapabilities {
		if (this.#negotiated) throw new Error("RPC semantic capabilities were already negotiated");
		if (!isRecord(requested)) throw new Error("RPC semantic capabilities must be a non-null object");
		this.#negotiated = true;
		const selected: RpcSemanticCapabilities = {};
		for (const key of RPC_SEMANTIC_CAPABILITY_KEYS) {
			const offered = this.#offered[key];
			const wanted = semanticCapabilityRevision(Reflect.get(requested, key));
			if (offered !== undefined && wanted !== undefined) selected[key] = Math.min(offered, wanted);
		}
		this.#selected = selected;
		return this.selected;
	}

	has(key: RpcSemanticCapabilityKey, minimumRevision = 1): boolean {
		return (this.#selected[key] ?? 0) >= minimumRevision;
	}

	/** Preserve commands that predate semantic negotiation unless the client explicitly declines their capability. */
	allowsLegacyCommand(key: RpcSemanticCapabilityKey, minimumRevision = 1): boolean {
		if (!this.#negotiated) return true;
		return this.has(key, minimumRevision);
	}
}

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

type RpcApprovalOutput = (
	frame: RpcApprovalRequestFrame | RpcApprovalResolvedFrame,
	options?: RpcFrameEncodingOptions,
) => void;

type PendingRpcApproval = {
	allowedDecisions: ReadonlySet<ExtensionToolApprovalDecision>;
	sessionId: string;
	toolName: string;
	finish: (outcome: RpcApprovalResolvedFrame["outcome"], decision?: ExtensionToolApprovalDecision) => void;
};

type RpcApprovalResponseAttempt = {
	type: "approval_response";
	id: string;
	decision?: unknown;
};

function isExtensionToolApprovalDecision(value: unknown): value is ExtensionToolApprovalDecision {
	return value === "approve_once" || value === "approve_session" || value === "deny" || value === "cancel";
}

/** Owns structured approval request races and emits the authoritative terminal frame. */
export class RpcApprovalInteraction {
	readonly #pending = new Map<string, PendingRpcApproval>();
	readonly #sessionGrants = new Map<string, Set<string>>();

	constructor(private readonly output: RpcApprovalOutput) {}

	request(
		request: ExtensionToolApprovalRequest,
		options: { signal?: AbortSignal; timeout?: number } = {},
	): Promise<ExtensionToolApprovalDecision> {
		const id = Snowflake.next() as string;
		const { promise, resolve } = Promise.withResolvers<ExtensionToolApprovalDecision>();
		let timeoutId: NodeJS.Timeout | undefined;
		let settled = false;
		const onAbort = () => finish("aborted");
		const cleanup = () => {
			clearTimeout(timeoutId);
			options.signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};
		const finish = (outcome: RpcApprovalResolvedFrame["outcome"], decision?: ExtensionToolApprovalDecision) => {
			if (settled) return;
			settled = true;
			cleanup();
			this.output({
				type: "approval_resolved",
				id,
				outcome,
				...(decision ? { decision } : {}),
			});
			resolve(outcome === "accepted" && decision ? decision : outcome === "denied" ? "deny" : "cancel");
		};

		this.#pending.set(id, {
			allowedDecisions: new Set(request.allowedDecisions),
			sessionId: request.sessionId,
			toolName: request.toolName,
			finish,
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeout !== undefined) timeoutId = setTimeout(() => finish("timed_out"), options.timeout);
		if (options.signal?.aborted) {
			finish("aborted");
			return promise;
		}
		try {
			this.output({ type: "approval_request", id, ...request }, { rejectOversizedLogicalFrame: true });
		} catch {
			finish("cancelled");
		}
		return promise;
	}

	handleResponse(response: RpcApprovalResponseAttempt): void {
		const pending = this.#pending.get(response.id);
		if (!pending) {
			this.output({ type: "approval_resolved", id: response.id, outcome: "stale" });
			return;
		}
		if (!isExtensionToolApprovalDecision(response.decision) || !pending.allowedDecisions.has(response.decision)) {
			pending.finish("stale");
			return;
		}
		if (response.decision === "approve_session") {
			const tools = this.#sessionGrants.get(pending.sessionId) ?? new Set<string>();
			tools.add(pending.toolName);
			this.#sessionGrants.set(pending.sessionId, tools);
		}
		const outcome =
			response.decision === "approve_once" || response.decision === "approve_session"
				? "accepted"
				: response.decision === "deny"
					? "denied"
					: "cancelled";
		pending.finish(outcome, response.decision);
	}

	abortAll(): void {
		for (const pending of Array.from(this.#pending.values())) pending.finish("aborted");
	}

	hasSessionGrant(sessionId: string, toolName: string): boolean {
		return this.#sessionGrants.get(sessionId)?.has(toolName) === true;
	}

	clearSessionGrants(): void {
		this.#sessionGrants.clear();
	}
}

type PendingRpcAsk = {
	questions: ExtensionAskDialogQuestion[];
	finish: (outcome: RpcExtensionUIResolvedFrame["outcome"], result?: ExtensionAskDialogResult) => void;
};

function isValidAskResult(
	result: unknown,
	questions: ExtensionAskDialogQuestion[],
): result is ExtensionAskDialogResult {
	if (!isRecord(result) || (result.kind !== "submit" && result.kind !== "chat")) return false;
	if (result.kind === "chat") return true;
	if (!Array.isArray(result.results) || result.results.length !== questions.length) return false;
	for (let index = 0; index < questions.length; index++) {
		const question = questions[index];
		const item = result.results[index];
		if (!question || !isRecord(item)) return false;
		if (item.id !== question.id || item.question !== question.question || item.multi !== (question.multi ?? false)) {
			return false;
		}
		if (!Array.isArray(item.options) || !item.options.every(option => typeof option === "string")) return false;
		const expectedOptions = question.options.map(option => option.label);
		if (
			item.options.length !== expectedOptions.length ||
			item.options.some((option, i) => option !== expectedOptions[i])
		) {
			return false;
		}
		const selectedOptions = item.selectedOptions;
		if (!Array.isArray(selectedOptions) || !selectedOptions.every(option => typeof option === "string")) {
			return false;
		}
		if (!question.multi && selectedOptions.length > 1) return false;
		if (
			selectedOptions.some(
				(option, selectedIndex) =>
					!expectedOptions.includes(option) || selectedOptions.indexOf(option) !== selectedIndex,
			)
		) {
			return false;
		}
		if (item.customInput !== undefined && (!question.allowCustom || typeof item.customInput !== "string"))
			return false;
		if (item.note !== undefined && typeof item.note !== "string") return false;
		if (item.timedOut !== undefined && typeof item.timedOut !== "boolean") return false;
	}
	return true;
}

/** Owns rich ask response races and emits the authoritative terminal frame. */
export class RpcAskInteraction {
	readonly #pending = new Map<string, PendingRpcAsk>();
	readonly #settledIds = new Set<string>();

	constructor(private readonly output: (frame: RpcAskRequestFrame | RpcExtensionUIResolvedFrame) => void) {}

	request(
		questions: ExtensionAskDialogQuestion[],
		options: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void } = {},
	): Promise<ExtensionAskDialogResult | undefined> {
		const id = Snowflake.next() as string;
		const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		let timeoutId: NodeJS.Timeout | undefined;
		let settled = false;
		const onAbort = () => finish("aborted");
		const cleanup = () => {
			clearTimeout(timeoutId);
			options.signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};
		const finish = (outcome: RpcExtensionUIResolvedFrame["outcome"], result?: ExtensionAskDialogResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#rememberSettled(id);
			this.output({
				type: "extension_ui_resolved",
				id,
				method: "ask",
				outcome,
				...(result ? { result } : {}),
			});
			resolve(outcome === "submitted" || outcome === "chat" ? result : undefined);
			if (outcome === "timed_out") options.onTimeout?.();
		};

		this.#pending.set(id, { questions, finish });
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeout !== undefined) timeoutId = setTimeout(() => finish("timed_out"), options.timeout);
		if (options.signal?.aborted) {
			finish("aborted");
			return promise;
		}
		this.output({
			type: "extension_ui_request",
			id,
			method: "ask",
			questions,
			...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
		});
		return promise;
	}

	handleResponse(response: RpcExtensionUIResponse): boolean {
		const pending = this.#pending.get(response.id);
		if (pending) {
			if ("cancelled" in response && response.cancelled) {
				pending.finish(response.timedOut ? "timed_out" : "cancelled");
			} else if ("result" in response && isValidAskResult(response.result, pending.questions)) {
				pending.finish(response.result.kind === "chat" ? "chat" : "submitted", response.result);
			} else {
				pending.finish("stale");
			}
			return true;
		}

		if (this.#settledIds.has(response.id) || "result" in response) {
			this.output({ type: "extension_ui_resolved", id: response.id, method: "ask", outcome: "stale" });
			return true;
		}
		return false;
	}

	abortAll(): void {
		for (const pending of Array.from(this.#pending.values())) pending.finish("aborted");
	}

	#rememberSettled(id: string): void {
		this.#settledIds.add(id);
		if (this.#settledIds.size <= 1024) return;
		const oldest = this.#settledIds.values().next().value;
		if (oldest !== undefined) this.#settledIds.delete(oldest);
	}
}

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcDurableSkillCommandSession = RpcSkillCommandSession &
	Pick<
		AgentSession,
		| "getLastAssistantMessage"
		| "isStreaming"
		| "resumePersistedTurn"
		| "sessionFile"
		| "sessionId"
		| "sessionManager"
		| "subscribe"
	>;
export type RpcSkillCommandResult = { agentInvoked: true };

export interface RpcDurableSkillCommandOptions {
	clientTurnId: string;
	images?: ImageContent[];
	onHostTurnPrepared: () => void;
	queuedOperationIds?: Set<string>;
}

type RpcSkillPromptMessage = {
	customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
	content: string;
	display: true;
	details: SkillPromptDetails & { rpcHostTurnOperationId?: string };
	attribution: "user";
};

async function buildRpcSkillPromptMessage(
	session: RpcSkillCommandSession,
	text: string,
): Promise<RpcSkillPromptMessage | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	return {
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: built.message,
		display: true,
		details: built.details,
		attribution: "user",
	};
}

function bindRpcSkillPromptToOperation(
	message: RpcSkillPromptMessage,
	operation: HostTurnOperation,
): RpcSkillPromptMessage {
	return {
		...message,
		details: { ...message.details, rpcHostTurnOperationId: operation.operationId },
	};
}

function findPersistedRpcSkillPromptEntryId(
	session: RpcDurableSkillCommandSession,
	operation: HostTurnOperation,
	message: RpcSkillPromptMessage,
): string | undefined {
	const branch = session.sessionManager.getBranch();
	const preparedIndex = branch.findIndex(entry => entry.id === operation.preparedEntryId);
	for (let index = preparedIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		const operationId =
			entry?.type === "custom_message" && isRecord(entry.details) ? entry.details.rpcHostTurnOperationId : undefined;
		if (
			entry?.type === "custom_message" &&
			entry.customType === message.customType &&
			entry.content === message.content &&
			entry.attribution === message.attribution &&
			(operationId === undefined || operationId === operation.operationId)
		) {
			return entry.id;
		}
	}
	return undefined;
}

function persistedRpcSkillPromptOutcome(
	session: RpcDurableSkillCommandSession,
	promptEntryId: string,
): HostTurnOutcome | undefined {
	const branch = session.sessionManager.getBranch();
	const promptIndex = branch.findIndex(entry => entry.id === promptEntryId);
	const assistant = branch
		.slice(promptIndex + 1)
		.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
	if (assistant?.type !== "message" || assistant.message.role !== "assistant") return undefined;
	if (assistant.message.stopReason === "toolUse") return undefined;
	if (assistant.message.stopReason === "aborted") return "aborted";
	if (assistant.message.stopReason === "error") return "failed";
	return "completed";
}

function rpcSkillPromptOutcome(session: RpcDurableSkillCommandSession): HostTurnOutcome {
	const assistant = session.getLastAssistantMessage();
	if (assistant?.stopReason === "aborted") return "aborted";
	if (!assistant || assistant.stopReason === "error") return "failed";
	return "completed";
}

async function runDurableRpcSkillPrompt(
	session: RpcDurableSkillCommandSession,
	message: RpcSkillPromptMessage,
	streamingBehavior: "steer" | "followUp",
	options: RpcDurableSkillCommandOptions,
	payloadFingerprint: string,
): Promise<void> {
	const prepared = await session.sessionManager.prepareHostTurnOperationWithStatus({
		clientTurnId: options.clientTurnId,
		kind: "prompt",
		payload: {
			text: message.content,
			synthetic: false,
			attribution: "user",
			rpcSkill: { ...message, streamingBehavior },
		},
		payloadFingerprint,
	});
	options.onHostTurnPrepared();
	message = bindRpcSkillPromptToOperation(message, prepared.operation);
	if (!prepared.created && options.queuedOperationIds?.has(prepared.operation.operationId)) return;
	// Idempotent only after native dispatch/settlement. A still-prepared operation
	// means the prior attempt failed before persistence and must be redriven.
	if (!prepared.created && prepared.operation.status !== "prepared") return;
	const persistedBeforeDispatch = findPersistedRpcSkillPromptEntryId(session, prepared.operation, message);
	if (persistedBeforeDispatch) {
		let outcome = persistedRpcSkillPromptOutcome(session, persistedBeforeDispatch);
		if (!outcome) {
			await session.resumePersistedTurn();
			outcome = persistedRpcSkillPromptOutcome(session, persistedBeforeDispatch);
			if (!outcome) {
				throw new Error(`Host turn ${options.clientTurnId}: resumed skill prompt produced no assistant response`);
			}
		}
		await session.sessionManager.markHostTurnDispatched({
			clientTurnId: prepared.operation.clientTurnId,
			payloadFingerprint: prepared.operation.payloadFingerprint,
			nativeIdentity: {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				entryId: persistedBeforeDispatch,
			},
		});
		await session.sessionManager.settleHostTurnOperation({
			clientTurnId: prepared.operation.clientTurnId,
			payloadFingerprint: prepared.operation.payloadFingerprint,
			outcome,
		});
		return;
	}

	const wasStreaming = session.isStreaming;
	const queuedOperationIds = wasStreaming && streamingBehavior === "followUp" ? options.queuedOperationIds : undefined;
	queuedOperationIds?.add(prepared.operation.operationId);
	const persisted = Promise.withResolvers<string | undefined>();
	const terminal = Promise.withResolvers<void>();
	let sawSkillPrompt = false;
	let cancelled = false;
	const unsubscribe = wasStreaming
		? session.subscribe(event => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === message.customType &&
					event.message.content === message.content &&
					event.message.attribution === message.attribution
				) {
					const entryId = findPersistedRpcSkillPromptEntryId(session, prepared.operation, message);
					if (entryId) {
						sawSkillPrompt = true;
						persisted.resolve(entryId);
					}
				}
				if (sawSkillPrompt && event.type === "agent_end" && event.isTerminal !== false) terminal.resolve();
				if (event.type === "host_turn_cancelled" && event.clientTurnId === prepared.operation.clientTurnId) {
					cancelled = true;
					persisted.resolve(undefined);
					terminal.resolve();
				}
			})
		: undefined;

	let promptError: unknown;
	try {
		await session.promptCustomMessage(message, { streamingBehavior });
	} catch (error) {
		promptError = error;
	}

	try {
		const persistedEntryId =
			findPersistedRpcSkillPromptEntryId(session, prepared.operation, message) ??
			(promptError === undefined && wasStreaming ? await persisted.promise : undefined);
		if (!persistedEntryId) {
			if (cancelled) return;
			if (promptError !== undefined) throw promptError;
			throw new Error(`Host turn ${options.clientTurnId}: durable skill prompt was not persisted`);
		}
		await session.sessionManager.markHostTurnDispatched({
			clientTurnId: prepared.operation.clientTurnId,
			payloadFingerprint: prepared.operation.payloadFingerprint,
			nativeIdentity: {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				entryId: persistedEntryId,
			},
		});
		if (promptError === undefined && wasStreaming) await terminal.promise;
		if (cancelled) return;
		await session.sessionManager.settleHostTurnOperation({
			clientTurnId: prepared.operation.clientTurnId,
			payloadFingerprint: prepared.operation.payloadFingerprint,
			outcome: promptError === undefined ? rpcSkillPromptOutcome(session) : "failed",
		});
		if (promptError !== undefined) throw promptError;
	} finally {
		queuedOperationIds?.delete(prepared.operation.operationId);
		unsubscribe?.();
	}
}

export function tryRunRpcSkillCommand(
	session: RpcDurableSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp",
	durable: RpcDurableSkillCommandOptions,
): Promise<RpcSkillCommandResult | false>;
export function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior?: "steer" | "followUp",
): Promise<RpcSkillCommandResult | false>;
export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
	durable?: RpcDurableSkillCommandOptions,
): Promise<RpcSkillCommandResult | false> {
	if (durable) {
		const durableSession = session as RpcDurableSkillCommandSession;
		const payloadFingerprint = fingerprintHostTurnPayload("prompt", {
			text,
			images: durable.images,
			streamingBehavior,
		});
		const existing = durableSession.sessionManager
			.getHostTurnOperations()
			.find(operation => operation.clientTurnId === durable.clientTurnId);
		if (!existing && durableSession.isStreaming && streamingBehavior !== "followUp") {
			throw new Error('Durable skill prompts submitted during an active turn require streamingBehavior "followUp"');
		}
		if (existing && isRecord(existing.payload) && isRecord(existing.payload.rpcSkill)) {
			// Dispatched/settled skill ops short-circuit; prepared ops redispatch only
			// when the skill prompt has not already been persisted (still in-flight).
			if (existing.status === "dispatched" || existing.status === "settled") {
				await durableSession.sessionManager.prepareHostTurnOperationWithStatus({
					clientTurnId: durable.clientTurnId,
					kind: "prompt",
					payload: existing.payload,
					payloadFingerprint,
				});
				durable.onHostTurnPrepared();
				return { agentInvoked: true };
			}
			const rpcSkill = existing.payload.rpcSkill;
			if (
				typeof rpcSkill.customType === "string" &&
				typeof rpcSkill.content === "string" &&
				rpcSkill.display === true &&
				rpcSkill.attribution === "user" &&
				isRecord(rpcSkill.details)
			) {
				const message: RpcSkillPromptMessage = {
					customType: rpcSkill.customType as typeof SKILL_PROMPT_MESSAGE_TYPE,
					content: rpcSkill.content,
					display: true,
					details: rpcSkill.details as unknown as RpcSkillPromptMessage["details"],
					attribution: "user",
				};
				if (findPersistedRpcSkillPromptEntryId(durableSession, existing, message)) {
					// The first attempt already journaled the skill prompt and is still
					// running; treat lost-response retries as idempotent acceptance.
					await durableSession.sessionManager.prepareHostTurnOperationWithStatus({
						clientTurnId: durable.clientTurnId,
						kind: "prompt",
						payload: existing.payload,
						payloadFingerprint,
					});
					durable.onHostTurnPrepared();
					return { agentInvoked: true };
				}
				await runDurableRpcSkillPrompt(durableSession, message, streamingBehavior, durable, payloadFingerprint);
				return { agentInvoked: true };
			}
		}

		const message = await buildRpcSkillPromptMessage(session, text);
		if (!message) return false;
		await runDurableRpcSkillPrompt(durableSession, message, streamingBehavior, durable, payloadFingerprint);
		return { agentInvoked: true };
	}

	const message = await buildRpcSkillPromptMessage(session, text);
	if (!message) return false;
	await session.promptCustomMessage(message, { streamingBehavior });
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/** Start a durable prompt and resolve only after its host-turn preparation is authoritative. */
export async function acceptDurableRpcPrompt(input: {
	startPrompt: (onHostTurnPrepared: () => void) => Promise<boolean>;
	onLocalResult: (agentInvoked: false) => void;
	onAsyncError: (error: Error) => void;
	extensionUserMessageTracker?: RpcExtensionUserMessageTracker;
}): Promise<void> {
	const prepared = Promise.withResolvers<void>();
	const tracker = input.extensionUserMessageTracker ?? new RpcExtensionUserMessageTracker();
	const trackedPrompt = tracker.watchPrompt(() => input.startPrompt(prepared.resolve));
	let acknowledged = false;
	let deferredError: Error | undefined;

	reportLocalOnlyPromptResult({
		id: undefined,
		prompt: trackedPrompt.prompt,
		output: () => setTimeout(() => input.onLocalResult(false), 0),
		onError: error => {
			if (acknowledged) setTimeout(() => input.onAsyncError(error), 0);
			else deferredError = error;
		},
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});

	const outcome = await Promise.race([
		prepared.promise.then(() => "prepared" as const),
		trackedPrompt.prompt.then(() => "completed" as const),
	]);
	if (outcome === "completed") throw new Error("Durable prompt completed before host-turn preparation");
	acknowledged = true;
	if (deferredError) {
		const error = deferredError;
		setTimeout(() => input.onAsyncError(error), 0);
	}
}

function parseRpcExecutionModel(
	value: unknown,
): Extract<RpcPlanReviewDecision, { action: "execute" }>["executionModel"] {
	if (!isRecord(value)) throw new Error("Invalid plan review decision: executionModel must be an object");
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
	if (!provider || !modelId) {
		throw new Error("Invalid plan review decision: executionModel requires non-empty provider and modelId");
	}
	if (value.thinkingLevel !== undefined && (typeof value.thinkingLevel !== "string" || !value.thinkingLevel.trim())) {
		throw new Error("Invalid plan review decision: executionModel.thinkingLevel must be a non-empty string");
	}
	return {
		provider,
		modelId,
		thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
	};
}

/** Parse the complete untrusted RPC plan-review decision before controller mutation begins. */
export function parseRpcPlanReviewDecision(value: unknown): RpcPlanReviewDecision {
	if (!isRecord(value)) throw new Error("Invalid plan review decision: expected an object");
	if (value.action === "cancel") return { action: "cancel" };
	if (value.replacementPlanMarkdown !== undefined && typeof value.replacementPlanMarkdown !== "string") {
		throw new Error("Invalid plan review decision: replacementPlanMarkdown must be a string");
	}
	const clientTurnId = typeof value.clientTurnId === "string" ? value.clientTurnId.trim() : "";
	if (!clientTurnId) throw new Error("Invalid plan review decision: clientTurnId must be a non-empty string");
	const replacementPlanMarkdown =
		typeof value.replacementPlanMarkdown === "string" ? value.replacementPlanMarkdown : undefined;

	if (value.action === "execute") {
		if (value.context !== "fresh" && value.context !== "preserve" && value.context !== "compact") {
			throw new Error("Invalid plan review decision: execute.context must be fresh, preserve, or compact");
		}
		return {
			action: "execute",
			context: value.context,
			executionModel: value.executionModel === undefined ? undefined : parseRpcExecutionModel(value.executionModel),
			replacementPlanMarkdown,
			clientTurnId,
		};
	}
	if (value.action === "refine") {
		if (typeof value.feedback !== "string") {
			throw new Error("Invalid plan review decision: refine.feedback must be a string");
		}
		return { action: "refine", feedback: value.feedback, replacementPlanMarkdown, clientTurnId };
	}
	throw new Error(`Invalid plan review decision: unsupported action ${String(value.action)}`);
}

/** Validate an untrusted plan-review response before invoking its mutating controller path. */
export async function respondToRpcPlanReview(input: {
	controller: Pick<PlanModeController, "respondToReview">;
	requestId: unknown;
	decision: unknown;
}): Promise<RpcPlanReviewResolution> {
	const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
	if (!requestId) throw new Error("Invalid plan review requestId: expected a non-empty string");
	return await input.controller.respondToReview({
		requestId,
		decision: parseRpcPlanReviewDecision(input.decision),
	});
}

/** Resolve aggregate auth status without letting stale stored rows hide an effective external credential. */
export function resolveRpcAuthProviderStatus(input: {
	credentialOrigin: CredentialOrigin | undefined;
	accounts: readonly RpcAuthAccountStatus[];
	hasDisabledCredentials: boolean;
}): RpcAuthStatusValue {
	if (
		input.credentialOrigin !== undefined &&
		input.credentialOrigin.kind !== "oauth" &&
		input.credentialOrigin.kind !== "api_key"
	) {
		return "authenticated";
	}
	if (input.accounts.some(account => account.status === "authenticated")) return "authenticated";
	if (input.accounts.some(account => account.status === "expired")) return "expired";
	if (input.hasDisabledCredentials) return "error";
	return "unauthenticated";
}

/** Apply RPC plan-mode validation and the same goal/vibe exclusion used by interactive mode. */
export async function setRpcPlanModeAtBoundary(input: {
	controller: Pick<PlanModeController, "setMode">;
	session: {
		getGoalModeState(): unknown;
		getVibeModeState(): { enabled?: unknown } | undefined;
	};
	status: unknown;
	workflow?: unknown;
	planFilePath?: unknown;
}): Promise<RpcPlanModeState> {
	if (input.status !== "off" && input.status !== "active" && input.status !== "paused") {
		throw new Error(`Invalid plan mode status: ${String(input.status)}`);
	}
	if (input.workflow !== undefined && input.workflow !== "parallel" && input.workflow !== "iterative") {
		throw new Error(`Invalid plan workflow: ${String(input.workflow)}`);
	}
	if (input.planFilePath !== undefined) {
		if (typeof input.planFilePath !== "string") throw new Error("Invalid plan file path: expected a string");
		if (!input.planFilePath.trim()) throw new Error("Invalid plan file path: expected a non-empty string");
	}
	if (input.status === "active") {
		if (input.session.getGoalModeState() !== undefined) throw new Error("Exit goal mode first.");
		if (input.session.getVibeModeState()?.enabled === true) throw new Error("Exit vibe mode first.");
	}
	return await input.controller.setMode({
		status: input.status,
		workflow: input.workflow,
		planFilePath: input.planFilePath,
	});
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onApprovalResponse?: (frame: RpcApprovalResponseAttempt) => void;
	onExtensionUIResponse?: (frame: RpcExtensionUIResponse) => boolean;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

function isRpcApprovalResponseAttempt(value: unknown): value is RpcApprovalResponseAttempt {
	return isRecord(value) && value.type === "approval_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcApprovalResponseAttempt(parsed)) {
		deps.onApprovalResponse?.(parsed);
		return true;
	}

	if (isRpcExtensionUIResponse(parsed)) {
		if (deps.onExtensionUIResponse?.(parsed)) return true;
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// `bash` can run for a long time. Dispatch it in the background so a
	// subsequent `abort_bash` frame can be read and handled without waiting
	// for the shell command to finish on its own. The response is emitted
	// when `handleCommand` resolves; clients correlate via `command.id`.
	if (command.type === "bash") {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, "bash", message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (command.type === "bash") {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSessionTransitionCommitted = () => void | Promise<void>;
export type RpcPlanSessionTransition = Pick<
	PlanModeController,
	"prepareSessionTransition" | "reconcileSessionTransition"
>;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	onSessionTransitionCommitted?: RpcSessionTransitionCommitted,
	planTransition?: RpcPlanSessionTransition,
): Promise<RpcSessionChangeResult> {
	await planTransition?.prepareSessionTransition();
	try {
		switch (command.type) {
			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				if (!cancelled) await onSessionTransitionCommitted?.();
				return { type: "new_session", data: { cancelled } };
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				if (!cancelled) await onSessionTransitionCommitted?.();
				return { type: "switch_session", data: { cancelled } };
			}

			case "branch": {
				const result = await session.branch(command.entryId);
				if (!result.cancelled) await onSessionTransitionCommitted?.();
				return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
			}
		}
		throw new Error("Unsupported RPC session change command");
	} finally {
		await planTransition?.reconcileSessionTransition();
	}
}

export type RpcHostTurnRollbackSession = Pick<
	AgentSession,
	"sessionId" | "sessionFile" | "rollbackHostTurns" | "validateHostTurnRollback"
>;

/**
 * Roll back durable host turns. When the active session identity changes
 * (cross-lineage parent activation), run the same committed-session-transition
 * cleanup used by new/switch/branch so child subagent registry/events do not leak.
 *
 * Busy/suffix validation runs first so a rejected rollback never suspends plan
 * runtime. Plan runtime is then suspended before the identity change and
 * reconciled after, matching the new/switch/branch transition contract.
 */
export async function handleRpcRollbackTurns(
	session: RpcHostTurnRollbackSession,
	input: HostTurnRollbackInput,
	onSessionTransitionCommitted?: RpcSessionTransitionCommitted,
	planTransition?: RpcPlanSessionTransition,
): Promise<HostTurnRollbackResult> {
	// Fail closed before touching plan runtime (busy or bad suffix).
	await session.validateHostTurnRollback(input);
	await planTransition?.prepareSessionTransition();
	try {
		const previousSessionId = session.sessionId;
		const previousSessionFile = session.sessionFile;
		const rollback = await session.rollbackHostTurns(input);
		if (rollback.sessionId !== previousSessionId || rollback.sessionFile !== previousSessionFile) {
			await onSessionTransitionCommitted?.();
		}
		return rollback;
	} finally {
		await planTransition?.reconcileSessionTransition();
	}
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			resolve(parseResponse(response));
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}

/** Bind plan artifact IO to the session context active when each operation begins. */
export function createRpcPlanModeArtifacts(context: {
	getArtifactsDir(): string | null;
	getSessionId(): string;
	getCwd(): string;
}): PlanModeArtifacts {
	const localProtocolOptions: LocalProtocolOptions = {
		getArtifactsDir: () => context.getArtifactsDir(),
		getSessionId: () => context.getSessionId(),
	};
	return {
		read: planFilePath => readPlanFile(planFilePath, { localProtocolOptions, cwd: context.getCwd() }),
		write: async (planFilePath, markdown) => {
			await Bun.write(resolvePlanFilePath(planFilePath, { localProtocolOptions, cwd: context.getCwd() }), markdown);
		},
		list: () => listPlanFiles({ localProtocolOptions }),
		pin: planFilePath => {
			const artifactsDir = context.getArtifactsDir();
			const sessionId = context.getSessionId();
			const cwd = context.getCwd();
			const pinnedLocalProtocolOptions: LocalProtocolOptions = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => sessionId,
			};
			const resolvedPath = resolvePlanFilePath(planFilePath, {
				localProtocolOptions: pinnedLocalProtocolOptions,
				cwd,
			});
			return {
				read: () => readPlanFile(planFilePath, { localProtocolOptions: pinnedLocalProtocolOptions, cwd }),
				write: async markdown => {
					await Bun.write(resolvedPath, markdown);
				},
			};
		},
	};
}

const RPC_DURABLE_LOCAL_BUILTINS: Record<string, true> = { fast: true, rename: true };

function isSpecialPreparedHostTurn(operation: { payload: unknown }): boolean {
	return (
		isRecord(operation.payload) && (isRecord(operation.payload.rpcBuiltin) || isRecord(operation.payload.rpcSkill))
	);
}

/**
 * Recover prepared durable host turns in journal order so special skill/builtin
 * operations and ordinary prompts/follow-ups cannot cross.
 */
export async function recoverPreparedHostTurnsInOrder(
	session: AgentSession,
	runtime: Parameters<typeof executeAcpBuiltinSlashCommand>[1],
): Promise<string[]> {
	const recovered: string[] = [];
	for (const operation of session.sessionManager.getHostTurnOperations()) {
		if (operation.status !== "prepared") continue;
		if (operation.kind !== "prompt" && operation.kind !== "follow_up") continue;
		if (isSpecialPreparedHostTurn(operation)) {
			const special = await recoverOnePreparedSpecialHostTurn(session, runtime, operation);
			if (special) recovered.push(special);
			continue;
		}
		const ordinary = await session.recoverPreparedHostTurn(operation.clientTurnId);
		if (ordinary) recovered.push(ordinary);
	}
	return recovered;
}

/**
 * Restore prepared durable `/skill` and local builtin (`/fast`, `/rename`) host turns
 * through their special dispatch paths instead of generic `prompt()` recovery.
 */
export async function recoverPreparedSpecialHostTurns(
	session: AgentSession,
	runtime: Parameters<typeof executeAcpBuiltinSlashCommand>[1],
): Promise<string[]> {
	const recovered: string[] = [];
	for (const operation of session.sessionManager.getHostTurnOperations()) {
		if (operation.status !== "prepared" || operation.kind !== "prompt" || !isRecord(operation.payload)) continue;
		const id = await recoverOnePreparedSpecialHostTurn(session, runtime, operation);
		if (id) recovered.push(id);
	}
	return recovered;
}

async function recoverOnePreparedSpecialHostTurn(
	session: AgentSession,
	runtime: Parameters<typeof executeAcpBuiltinSlashCommand>[1],
	operation: HostTurnOperation,
): Promise<string | undefined> {
	if (!isRecord(operation.payload)) return undefined;

	if (isRecord(operation.payload.rpcSkill)) {
		const rpcSkill = operation.payload.rpcSkill;
		if (
			typeof rpcSkill.customType !== "string" ||
			typeof rpcSkill.content !== "string" ||
			rpcSkill.display !== true ||
			rpcSkill.attribution !== "user" ||
			!isRecord(rpcSkill.details)
		) {
			throw new Error(`Host turn ${operation.clientTurnId}: prepared skill payload is invalid`);
		}
		const streamingBehavior =
			rpcSkill.streamingBehavior === "followUp" || rpcSkill.streamingBehavior === "steer"
				? rpcSkill.streamingBehavior
				: "steer";
		const message: RpcSkillPromptMessage = {
			customType: rpcSkill.customType as typeof SKILL_PROMPT_MESSAGE_TYPE,
			content: rpcSkill.content,
			display: true,
			details: rpcSkill.details as unknown as RpcSkillPromptMessage["details"],
			attribution: "user",
		};
		await runDurableRpcSkillPrompt(
			session,
			message,
			streamingBehavior,
			{
				clientTurnId: operation.clientTurnId,
				images: Array.isArray(operation.payload.images) ? (operation.payload.images as ImageContent[]) : undefined,
				onHostTurnPrepared: () => {},
			},
			operation.payloadFingerprint,
		);
		return operation.clientTurnId;
	}

	if (!isRecord(operation.payload.rpcBuiltin) || typeof operation.payload.rpcBuiltin.name !== "string") {
		return undefined;
	}
	const builtinName = operation.payload.rpcBuiltin.name;
	if (RPC_DURABLE_LOCAL_BUILTINS[builtinName] !== true) {
		throw new Error(`Host turn ${operation.clientTurnId}: unsupported durable builtin /${builtinName}`);
	}
	const text =
		typeof operation.payload.text === "string" && operation.payload.text.length > 0
			? operation.payload.text
			: `/${builtinName}`;
	await session.sessionManager.markHostTurnDispatched({
		clientTurnId: operation.clientTurnId,
		payloadFingerprint: operation.payloadFingerprint,
		nativeIdentity: {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			entryId: operation.preparedEntryId,
		},
	});
	let result: AcpBuiltinSlashCommandResult;
	try {
		result = await executeAcpBuiltinSlashCommand(text, runtime);
	} catch (cause) {
		await session.sessionManager.settleHostTurnOperation({
			clientTurnId: operation.clientTurnId,
			payloadFingerprint: operation.payloadFingerprint,
			outcome: "failed",
		});
		throw cause;
	}
	if (result === false || "prompt" in result) {
		await session.sessionManager.settleHostTurnOperation({
			clientTurnId: operation.clientTurnId,
			payloadFingerprint: operation.payloadFingerprint,
			outcome: "failed",
		});
		throw new Error(`/${builtinName} did not settle as a local builtin during recovery`);
	}
	await session.sessionManager.settleHostTurnOperation({
		clientTurnId: operation.clientTurnId,
		payloadFingerprint: operation.payloadFingerprint,
		outcome: "completed",
	});
	return operation.clientTurnId;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";
	const capabilitySelection = new RpcCapabilitySelection(RPC_SEMANTIC_CAPABILITIES);
	const queuedRpcSkillOperations = new Set<string>();

	const frameEncoder = new RpcFrameEncoder();
	let protocolV2Enabled = false;
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	writeFrames(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			capabilities: capabilitySelection.offered,
		}),
	);
	let onCapabilityNegotiationResponseWritten: (() => void) | undefined;
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object, options?: RpcFrameEncodingOptions) => {
		writeFrames(frameEncoder.encodeFrames(obj, options));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true) {
			protocolV2Enabled = true;
			frameEncoder.setProtocolVersion(2);
		}
		if (
			isRecord(obj) &&
			obj.type === "response" &&
			obj.command === "negotiate_capabilities" &&
			obj.success === true
		) {
			const negotiationWrite = stdoutQueue;
			void negotiationWrite.then(() => onCapabilityNegotiationResponseWritten?.());
		}
	};
	const planArtifacts = createRpcPlanModeArtifacts({
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
		getCwd: () => session.sessionManager.getCwd(),
	});
	let subagentRegistry: RpcSubagentRegistry | undefined;
	const onSessionTransitionCommitted = () => subagentRegistry?.clear();
	const planController = new PlanModeController({
		session,
		artifacts: planArtifacts,
		onSessionTransitionCommitted,
		onModeChanged: state => {
			if (capabilitySelection.has("planControl")) output({ type: "plan_mode_changed", ...state });
		},
		onReviewRequested: request => {
			if (capabilitySelection.has("planReview")) output({ type: "plan_review_request", ...request });
		},
		onReviewResolved: resolution => {
			if (capabilitySelection.has("planReview")) output({ type: "plan_review_resolved", ...resolution });
		},
		onWarning: message => output({ type: "notice", level: "warning", message, source: "plan-review" }),
	});
	let planRuntimeInitialized = false;
	async function ensureRpcPlanRuntime(): Promise<RpcPlanModeState> {
		if (planRuntimeInitialized) return planController.state;
		const restored = planController.synchronizeFromSession();
		const state =
			restored.status === "active" && !capabilitySelection.has("planReview")
				? await planController.setMode({ status: "off" })
				: await planController.reconcileSessionTransition();
		planRuntimeInitialized = true;
		return state;
	}
	const rpcPlanTransition: RpcPlanSessionTransition = {
		prepareSessionTransition: async () => {
			const state = await planController.prepareSessionTransition();
			planRuntimeInitialized = false;
			return state;
		},
		reconcileSessionTransition: ensureRpcPlanRuntime,
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const approvalInteractions = new RpcApprovalInteraction(output);
	const askInteractions = new RpcAskInteraction(output);
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		get askDialog(): ExtensionUIContext["askDialog"] {
			if (!capabilitySelection.has("richUserInput")) return undefined;
			return (questions, dialogOptions) =>
				askInteractions.request(questions, {
					signal: dialogOptions?.signal,
					timeout: dialogOptions?.timeout,
					onTimeout: dialogOptions?.onTimeout,
				});
		}

		get requestToolApproval(): ExtensionUIContext["requestToolApproval"] {
			if (!capabilitySelection.has("structuredApprovals")) return undefined;
			return (request, dialogOptions) =>
				approvalInteractions.request(request, {
					signal: dialogOptions?.signal,
					timeout: dialogOptions?.timeout,
				});
		}

		hasToolApprovalGrant(sessionId: string, toolName: string): boolean {
			return (
				capabilitySelection.has("structuredApprovals") && approvalInteractions.hasSessionGrant(sessionId, toolName)
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext(rpcUiContext, true);
	let hostTurnRecovery: Promise<void> | undefined;
	let planReviewRecovery: Promise<void> | undefined;

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
		sessionActions: {
			newSession: async newOptions => {
				const result = await handleRpcSessionChange(
					session,
					{
						type: "new_session",
						...(newOptions?.parentSession ? { parentSession: newOptions.parentSession } : {}),
					},
					onSessionTransitionCommitted,
					rpcPlanTransition,
				);
				if (!result.data.cancelled) {
					if (newOptions?.setup) await newOptions.setup(session.sessionManager);
					await reconcileRpcSessionTransition();
				}
				return result.data;
			},
			branch: async entryId => {
				const result = await handleRpcSessionChange(
					session,
					{ type: "branch", entryId },
					onSessionTransitionCommitted,
					rpcPlanTransition,
				);
				if (!result.data.cancelled) await reconcileRpcSessionTransition();
				return { cancelled: result.data.cancelled };
			},
			switchSession: async sessionPath => {
				const result = await handleRpcSessionChange(
					session,
					{ type: "switch_session", sessionPath },
					onSessionTransitionCommitted,
					rpcPlanTransition,
				);
				if (!result.data.cancelled) await reconcileRpcSessionTransition();
				return result.data;
			},
		},
	});

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	async function getAvailableCommands() {
		return await buildAvailableSlashCommands(session);
	}
	async function reloadPluginState() {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await emitAvailableCommandsUpdate();
	}
	async function emitAvailableCommandsUpdate() {
		// Legacy clients that never negotiated still get updates; an explicit
		// decline of slashCommands still suppresses.
		if (!capabilitySelection.allowsLegacyCommand("slashCommands")) return;
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	}
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();
	let capabilityRecoveryBarrier: Promise<void> = Promise.resolve();
	let startCapabilityRecovery: (() => Promise<void>) | undefined;
	function recoverPreparedHostTurns(): Promise<void> {
		if (!capabilitySelection.has("hostTurns")) return Promise.resolve();
		if (hostTurnRecovery) return hostTurnRecovery;
		const recoveryRuntime = {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: (text: string) => output({ type: "command_output", text }),
			refreshCommands: emitAvailableCommandsUpdate,
			reloadPlugins: reloadPluginState,
			notifyTitleChanged: async () => {
				output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
			},
			notifyConfigChanged: async () => {
				output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
			},
		};
		const task = recoverPreparedHostTurnsInOrder(session, recoveryRuntime).then(
			() => {},
			cause => {
				const message = cause instanceof Error ? cause.message : String(cause);
				output({ type: "notice", level: "error", message, source: "host-turn-recovery" });
			},
		);
		const tracked = task.finally(() => {
			if (hostTurnRecovery === tracked) hostTurnRecovery = undefined;
		});
		hostTurnRecovery = tracked;
		return tracked;
	}
	function recoverPendingPlanReviews(): Promise<void> {
		if (!capabilitySelection.has("planReview")) return Promise.resolve();
		if (planReviewRecovery) return planReviewRecovery;
		const task = planController.recoverPendingReviews().then(
			() => {},
			cause => {
				const message = cause instanceof Error ? cause.message : String(cause);
				output({ type: "notice", level: "error", message, source: "plan-review-recovery" });
			},
		);
		const tracked = task.finally(() => {
			if (planReviewRecovery === tracked) planReviewRecovery = undefined;
		});
		planReviewRecovery = tracked;
		return tracked;
	}
	async function reconcileRpcSessionTransition(): Promise<void> {
		approvalInteractions.abortAll();
		askInteractions.abortAll();
		approvalInteractions.clearSessionGrants();
		await recoverPendingPlanReviews();
		await recoverPreparedHostTurns();
		await emitAvailableCommandsUpdate();
	}
	// Recovery starts only after the negotiate_capabilities response has drained
	// from stdoutQueue. The barrier also prevents a queued command from overtaking
	// durable recovery while side-channel responses remain dispatchable.
	onCapabilityNegotiationResponseWritten = () => {
		const start = startCapabilityRecovery;
		startCapabilityRecovery = undefined;
		void start?.();
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		if (command.type !== "negotiate_protocol" && command.type !== "negotiate_capabilities") {
			await ensureRpcPlanRuntime();
		}
		if (
			command.type !== "negotiate_protocol" &&
			command.type !== "negotiate_capabilities" &&
			command.type !== "abort"
		) {
			await capabilityRecoveryBarrier;
		}

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			case "negotiate_capabilities": {
				const capabilities = capabilitySelection.select(command.capabilities);
				await ensureRpcPlanRuntime();
				if (capabilitySelection.has("slashCommands")) await emitAvailableCommandsUpdate();
				if (!capabilitySelection.has("subagents")) subagentRegistry?.setSubscriptionLevel("off");
				const recovery = Promise.withResolvers<void>();
				capabilityRecoveryBarrier = recovery.promise;
				startCapabilityRecovery = async () => {
					try {
						await recoverPendingPlanReviews();
						await recoverPreparedHostTurns();
					} finally {
						recovery.resolve();
					}
				};
				return success(id, "negotiate_capabilities", { capabilities });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				if (command.clientTurnId !== undefined) {
					if (typeof command.clientTurnId !== "string" || !command.clientTurnId.trim()) {
						return error(id, "prompt", "prompt requires non-empty clientTurnId");
					}
					if (!capabilitySelection.has("hostTurns")) {
						return error(id, "prompt", "hostTurns capability was not selected", "capability_not_selected");
					}
				}
				const dispatchAgentPrompt = async (
					startPrompt: (onHostTurnPrepared?: () => void) => Promise<boolean>,
				): Promise<void> => {
					if (command.clientTurnId !== undefined) {
						await acceptDurableRpcPrompt({
							startPrompt: onHostTurnPrepared => startPrompt(onHostTurnPrepared),
							onLocalResult: agentInvoked => output({ type: "prompt_result", id, agentInvoked }),
							onAsyncError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return;
					}
					watchAndReportLocalOnlyPromptResult({
						id,
						startPrompt: () => startPrompt(),
						output,
						onError: promptError => output(error(id, "prompt", promptError.message)),
						extensionUserMessageTracker,
					});
				};
				const durableClientTurnId = command.clientTurnId;
				const parsedSkillInvocation = parseSkillInvocation(command.message);
				const recognizedSkillInvocation =
					session.skillsSettings?.enableSkillCommands === true &&
					parsedSkillInvocation !== undefined &&
					session.skills.some(skill => skill.name === parsedSkillInvocation.name);
				const existingDurableSkillInvocation =
					durableClientTurnId === undefined
						? undefined
						: session.sessionManager
								.getHostTurnOperations()
								.find(
									operation =>
										operation.clientTurnId === durableClientTurnId &&
										isRecord(operation.payload) &&
										isRecord(operation.payload.rpcSkill),
								);
				if (
					durableClientTurnId !== undefined &&
					(existingDurableSkillInvocation !== undefined || recognizedSkillInvocation)
				) {
					await dispatchAgentPrompt(onHostTurnPrepared => {
						if (!onHostTurnPrepared) throw new Error("Durable skill prompt preparation callback is unavailable");
						return tryRunRpcSkillCommand(session, command.message, command.streamingBehavior ?? "steer", {
							clientTurnId: durableClientTurnId,
							images: command.images,
							onHostTurnPrepared,
							queuedOperationIds: queuedRpcSkillOperations,
						}).then(result => result !== false);
					});
					return success(id, "prompt");
				}
				if (recognizedSkillInvocation) {
					await dispatchAgentPrompt(() =>
						tryRunRpcSkillCommand(session, command.message, command.streamingBehavior).then(
							result => result !== false,
						),
					);
					return success(id, "prompt");
				}
				const parsedBuiltin = parseSlashCommand(command.message);
				const builtin = parsedBuiltin ? lookupBuiltinSlashCommand(parsedBuiltin.name) : undefined;
				const durableBuiltinName = builtin?.handle ? builtin.name : undefined;
				if (
					durableClientTurnId !== undefined &&
					durableBuiltinName !== undefined &&
					RPC_DURABLE_LOCAL_BUILTINS[durableBuiltinName] !== true
				) {
					return error(
						id,
						"prompt",
						`/${durableBuiltinName} cannot be retried safely with clientTurnId`,
						"durable_builtin_not_supported",
					);
				}
				const builtinRuntime = {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: (text: string) => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				};
				if (
					durableClientTurnId !== undefined &&
					durableBuiltinName !== undefined &&
					RPC_DURABLE_LOCAL_BUILTINS[durableBuiltinName] === true
				) {
					const payload = {
						text: command.message,
						synthetic: false,
						attribution: "user",
						images: command.images,
						rpcBuiltin: { name: durableBuiltinName },
					};
					const prepared = await session.sessionManager.prepareHostTurnOperationWithStatus({
						clientTurnId: durableClientTurnId,
						kind: "prompt",
						payload,
					});
					if (!prepared.created) {
						if (prepared.operation.status === "settled") {
							if (prepared.operation.outcome === "completed") {
								return success(id, "prompt", { agentInvoked: false });
							}
							throw new Error(
								`Host turn ${durableClientTurnId}: durable builtin previously settled as ${prepared.operation.outcome}`,
							);
						}
						// Still prepared: prior attempt never acquired a native identity —
						// replay through the same safe recovery path as scheduled restart.
						if (prepared.operation.status === "prepared") {
							await recoverOnePreparedSpecialHostTurn(session, builtinRuntime, prepared.operation);
							return success(id, "prompt", { agentInvoked: false });
						}
						// Dispatched without settlement: fail closed (ambiguous mid-handler state).
						await session.sessionManager.settleHostTurnOperation({
							clientTurnId: durableClientTurnId,
							payloadFingerprint: prepared.operation.payloadFingerprint,
							outcome: "failed",
						});
						throw new Error(
							`Host turn ${durableClientTurnId}: durable builtin dispatch was interrupted and will not be replayed`,
						);
					}
					await session.sessionManager.markHostTurnDispatched({
						clientTurnId: durableClientTurnId,
						payloadFingerprint: prepared.operation.payloadFingerprint,
						nativeIdentity: {
							sessionId: session.sessionId,
							sessionFile: session.sessionFile,
							entryId: prepared.operation.preparedEntryId,
						},
					});
					let result: AcpBuiltinSlashCommandResult;
					try {
						result = await executeAcpBuiltinSlashCommand(command.message, builtinRuntime);
					} catch (cause) {
						await session.sessionManager.settleHostTurnOperation({
							clientTurnId: durableClientTurnId,
							payloadFingerprint: prepared.operation.payloadFingerprint,
							outcome: "failed",
						});
						throw cause;
					}
					if (result === false || "prompt" in result) {
						await session.sessionManager.settleHostTurnOperation({
							clientTurnId: durableClientTurnId,
							payloadFingerprint: prepared.operation.payloadFingerprint,
							outcome: "failed",
						});
						throw new Error(`/${durableBuiltinName} did not settle as a local builtin`);
					}
					await session.sessionManager.settleHostTurnOperation({
						clientTurnId: durableClientTurnId,
						payloadFingerprint: prepared.operation.payloadFingerprint,
						outcome: "completed",
					});
					return success(id, "prompt", { agentInvoked: false });
				}
				const builtinResult = await executeAcpBuiltinSlashCommand(command.message, builtinRuntime);
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						await dispatchAgentPrompt(onHostTurnPrepared =>
							session.prompt(builtinResult.prompt, {
								images: command.images,
								clientTurnId: command.clientTurnId,
								onHostTurnPrepared,
							}),
						);
						return success(id, "prompt");
					}
					return success(id, "prompt", { agentInvoked: false });
				}

				// Don't await the full turn: events stream after durable preparation is authoritative.
				await dispatchAgentPrompt(onHostTurnPrepared =>
					session.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						clientTurnId: command.clientTurnId,
						onHostTurnPrepared,
					}),
				);
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				const hasHostTurnIdentity =
					command.clientTurnId !== undefined ||
					command.optionFingerprint !== undefined ||
					command.turnOptions !== undefined;
				if (!hasHostTurnIdentity) {
					await session.followUp(command.message, command.images);
					return success(id, "follow_up");
				}
				if (!capabilitySelection.has("hostTurns")) {
					return error(id, "follow_up", "hostTurns capability was not selected", "capability_not_selected");
				}
				if (!command.clientTurnId || typeof command.clientTurnId !== "string" || !command.clientTurnId.trim()) {
					return error(id, "follow_up", "follow_up requires non-empty clientTurnId");
				}
				if (
					!command.optionFingerprint ||
					typeof command.optionFingerprint !== "string" ||
					!command.optionFingerprint.trim()
				) {
					return error(id, "follow_up", "follow_up requires non-empty optionFingerprint");
				}
				await session.followUp(command.message, command.images, {
					clientTurnId: command.clientTurnId,
					optionFingerprint: command.optionFingerprint,
					turnOptions: command.turnOptions,
				});
				return success(id, "follow_up");
			}

			case "abort": {
				approvalInteractions.abortAll();
				askInteractions.abortAll();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				approvalInteractions.abortAll();
				askInteractions.abortAll();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				const result = await handleRpcSessionChange(
					session,
					command,
					onSessionTransitionCommitted,
					rpcPlanTransition,
				);
				if (!result.data.cancelled) await reconcileRpcSessionTransition();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					...(capabilitySelection.has("runtimePolicy")
						? { approvalMode: session.settings.get("tools.approvalMode") }
						: {}),
					...(capabilitySelection.has("planControl") ? { planMode: planController.state } : {}),
					...(capabilitySelection.has("planReview")
						? { pendingPlanReviews: planController.getPendingReviewSummaries() }
						: {}),
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
				};
				return success(id, "get_state", state);
			}

			case "set_plan_mode": {
				if (!capabilitySelection.has("planControl")) {
					return error(id, "set_plan_mode", "planControl capability was not selected", "capability_not_selected");
				}
				if (command.status === "active" && !capabilitySelection.has("planReview")) {
					return error(id, "set_plan_mode", "planReview capability was not selected", "capability_not_selected");
				}
				const state = await setRpcPlanModeAtBoundary({
					controller: planController,
					session,
					status: command.status,
					workflow: command.workflow,
					planFilePath: command.planFilePath,
				});
				return success(id, "set_plan_mode", state);
			}

			case "respond_to_plan_review": {
				if (!capabilitySelection.has("planReview")) {
					return error(
						id,
						"respond_to_plan_review",
						"planReview capability was not selected",
						"capability_not_selected",
					);
				}
				const resolution = await respondToRpcPlanReview({
					controller: planController,
					requestId: command.requestId,
					decision: command.decision,
				});
				return success(id, "respond_to_plan_review", resolution);
			}

			case "get_turns": {
				if (!capabilitySelection.has("hostTurns")) {
					return error(id, "get_turns", "hostTurns capability was not selected", "capability_not_selected");
				}
				return success(id, "get_turns", { turns: await session.getHostTurns() });
			}

			case "rollback_turns": {
				if (!capabilitySelection.has("hostTurns")) {
					return error(id, "rollback_turns", "hostTurns capability was not selected", "capability_not_selected");
				}
				const rollback = await handleRpcRollbackTurns(
					session,
					{
						count: command.count,
						expectedClientTurnIds: command.expectedClientTurnIds,
					},
					onSessionTransitionCommitted,
					rpcPlanTransition,
				);
				if (capabilitySelection.has("planReview")) await planController.recoverPendingReview();
				return success(id, "rollback_turns", {
					removedClientTurnIds: rollback.removedClientTurnIds,
					turns: rollback.remainingTurns,
					sessionId: rollback.sessionId,
					sessionFile: rollback.sessionFile,
				});
			}

			case "cancel_follow_up": {
				if (!capabilitySelection.has("hostTurns")) {
					return error(id, "cancel_follow_up", "hostTurns capability was not selected", "capability_not_selected");
				}
				if (!command.clientTurnId || typeof command.clientTurnId !== "string" || !command.clientTurnId.trim()) {
					return error(id, "cancel_follow_up", "cancel_follow_up requires non-empty clientTurnId");
				}
				const cancelled = await session.cancelQueuedHostTurn(command.clientTurnId);
				return success(id, "cancel_follow_up", { cancelled });
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "get_available_commands": {
				if (!capabilitySelection.allowsLegacyCommand("slashCommands")) {
					return error(
						id,
						"get_available_commands",
						"slashCommands capability was not selected",
						"capability_not_selected",
					);
				}
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_runtime_policy": {
				if (!capabilitySelection.has("runtimePolicy")) {
					return error(
						id,
						"set_runtime_policy",
						"runtimePolicy capability was not selected",
						"capability_not_selected",
					);
				}
				if (!(["always-ask", "write", "yolo"] as const).includes(command.approvalMode)) {
					return error(id, "set_runtime_policy", `Invalid approval mode: ${String(command.approvalMode)}`);
				}
				session.settings.override("tools.approvalMode", command.approvalMode);
				return success(id, "set_runtime_policy", { approvalMode: command.approvalMode });
			}

			case "get_auth_status": {
				if (!capabilitySelection.has("authStatus")) {
					return error(id, "get_auth_status", "authStatus capability was not selected", "capability_not_selected");
				}
				const authStorage = session.modelRegistry.authStorage;
				await authStorage.reload();
				const snapshot = authStorage.exportSnapshot();
				const disabledCredentials = await authStorage.listDisabledCredentials();
				const entriesByProvider = new Map<string, typeof snapshot.credentials>();
				for (const entry of snapshot.credentials) {
					const entries = entriesByProvider.get(entry.provider) ?? [];
					entries.push(entry);
					entriesByProvider.set(entry.provider, entries);
				}
				const disabledByProvider = new Map<string, typeof disabledCredentials>();
				for (const entry of disabledCredentials) {
					const entries = disabledByProvider.get(entry.provider) ?? [];
					entries.push(entry);
					disabledByProvider.set(entry.provider, entries);
				}
				const providers = new Set(session.getAvailableModels().map(model => model.provider));
				for (const provider of authStorage.list()) providers.add(provider);
				for (const provider of disabledByProvider.keys()) providers.add(provider);
				const now = Date.now();
				const status: RpcAuthStatus = {
					providers: [...providers].sort().map(provider => {
						const accounts: RpcAuthAccountStatus[] = (entriesByProvider.get(provider) ?? []).map(
							({ credential }) => {
								if (credential.type === "api_key") {
									return { type: "api_key", status: "authenticated" };
								}
								return {
									type: "oauth",
									status: credential.expires <= now ? "expired" : "authenticated",
									...(credential.accountId ? { accountId: credential.accountId } : {}),
									...(credential.email ? { email: credential.email } : {}),
									...(credential.projectId ? { projectId: credential.projectId } : {}),
									...(credential.enterpriseUrl ? { enterpriseUrl: credential.enterpriseUrl } : {}),
									...(credential.orgId ? { orgId: credential.orgId } : {}),
									...(credential.orgName ? { orgName: credential.orgName } : {}),
								};
							},
						);
						const disabled = disabledByProvider.get(provider) ?? [];
						for (const credential of disabled) {
							accounts.push({
								type: credential.type,
								status: "error",
								...(credential.accountId ? { accountId: credential.accountId } : {}),
								...(credential.email ? { email: credential.email } : {}),
								...(credential.orgId ? { orgId: credential.orgId } : {}),
								...(credential.orgName ? { orgName: credential.orgName } : {}),
							});
						}
						const providerStatus = resolveRpcAuthProviderStatus({
							credentialOrigin: authStorage.getCredentialOrigin(provider),
							accounts,
							hasDisabledCredentials: disabled.length > 0,
						});
						return {
							provider,
							status: providerStatus,
							accounts,
							...(disabled.length > 0 ? { error: "One or more credentials are disabled" } : {}),
						};
					}),
				};
				return success(id, "get_auth_status", status);
			}

			case "get_available_skills": {
				if (!capabilitySelection.has("skills")) {
					return error(
						id,
						"get_available_skills",
						"skills capability was not selected",
						"capability_not_selected",
					);
				}
				const skills: RpcAvailableSkill[] = session.skills.map(skill => ({
					name: skill.name,
					description: skill.description,
					source: skill.source,
				}));
				return success(id, "get_available_skills", { skills });
			}

			case "set_todos": {
				if (!capabilitySelection.allowsLegacyCommand("tasks")) {
					return error(id, "set_todos", "tasks capability was not selected", "capability_not_selected");
				}
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!capabilitySelection.allowsLegacyCommand("subagents")) {
					return error(
						id,
						"set_subagent_subscription",
						"subagents capability was not selected",
						"capability_not_selected",
					);
				}
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!capabilitySelection.allowsLegacyCommand("subagents")) {
					return error(id, "get_subagents", "subagents capability was not selected", "capability_not_selected");
				}
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!capabilitySelection.allowsLegacyCommand("subagents")) {
					return error(
						id,
						"get_subagent_messages",
						"subagents capability was not selected",
						"capability_not_selected",
					);
				}
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					// Model not in the current catalog. Wait for in-flight
					// background discovery before declaring it missing: on cold
					// start, discovery-backed providers (proxy / ollama / etc.)
					// populate seconds after session ready. Models already in
					// the bundled catalog skip this await entirely so the RPC
					// queue is not stalled behind unrelated discovery.
					await session.modelRegistry.awaitBackgroundRefresh();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				if (!capabilitySelection.has("modelCatalog")) {
					return success(id, "get_available_models", { models });
				}
				const enriched: RpcAvailableModel[] = models.map(model => ({
					...model,
					thinkingEfforts: model.reasoning ? [...getSupportedEfforts(model)] : [],
					fastModeSupported: realizesPriorityServiceTier("priority", model),
				}));
				return success(id, "get_available_models", { models: enriched });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			approvalInteractions.abortAll();
			askInteractions.abortAll();
			approvalInteractions.clearSessionGrants();
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			await session.dispose();
			await stdoutQueue;
			process.exit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onApprovalResponse: frame => {
			if (capabilitySelection.has("structuredApprovals")) approvalInteractions.handleResponse(frame);
		},
		onExtensionUIResponse: frame =>
			capabilitySelection.has("richUserInput") ? askInteractions.handleResponse(frame) : false,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it. Each physical line is
	// bounded before decoding. Protocol v2 chunk sequences are reassembled into
	// one logical command only after negotiation; malformed input is reported and
	// resets the decoder so later commands can still run (issue #5194).
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let frameDecoder = new RpcFrameDecoder();
	for await (const line of readLines(input ?? Bun.stdin.stream())) {
		if (line.byteLength + 1 > MAX_RPC_FRAME_BYTES) {
			output(error(undefined, "parse", `RPC physical frame exceeds ${MAX_RPC_FRAME_BYTES} bytes`));
			frameDecoder = new RpcFrameDecoder();
			continue;
		}
		let parsed: unknown;
		try {
			const text = decoder.decode(line).trim();
			if (!text) continue;
			parsed = JSON.parse(text);
			if (isRecord(parsed) && parsed.type === "rpc_chunk" && !protocolV2Enabled) {
				throw new Error("RPC chunk received before protocol v2 negotiation");
			}
			const frame = frameDecoder.push(parsed);
			if (frame) inputDispatcher.dispatch(frame);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			output(error(undefined, "parse", `Failed to parse command: ${message}`));
			frameDecoder = new RpcFrameDecoder();
		}
	}

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	approvalInteractions.abortAll();
	askInteractions.abortAll();
	approvalInteractions.clearSessionGrants();
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	const startRecovery = startCapabilityRecovery;
	startCapabilityRecovery = undefined;
	if (startRecovery) await startRecovery();
	else await capabilityRecoveryBarrier;
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await session.dispose();
	await stdoutQueue;
	process.exit(0);
}
