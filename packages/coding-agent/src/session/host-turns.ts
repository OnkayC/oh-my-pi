import { isRecord } from "@oh-my-pi/pi-utils";
import type { CustomEntry, SessionEntry } from "./session-entries";

export const HOST_TURN_OPERATION_CUSTOM_TYPE = "host_turn_operation";
export const HOST_TURN_CUSTOM_TYPE = "host_turn";

export type HostTurnKind = "prompt" | "follow_up" | "plan_execute" | "plan_refine";
export type HostTurnOperationStatus = "prepared" | "dispatched" | "settled";
export type HostTurnOutcome = "completed" | "cancelled" | "aborted" | "failed";

export interface HostTurnOptions {
	provider?: string;
	modelId: string;
	thinkingLevel?: string;
	fastMode?: boolean;
}

export interface HostTurnNativeIdentity {
	sessionId: string;
	entryId?: string;
	sessionFile?: string;
}

export interface HostTurnLineage {
	sessionId: string;
	sessionFile?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
}

export interface HostTurnOperation {
	schemaVersion: 1;
	operationId: string;
	clientTurnId: string;
	kind: HostTurnKind;
	payload: unknown;
	payloadFingerprint: string;
	optionFingerprint?: string;
	turnOptions?: HostTurnOptions;
	status: HostTurnOperationStatus;
	preparedAt: string;
	dispatchedAt?: string;
	settledAt?: string;
	nativeIdentity?: HostTurnNativeIdentity;
	outcome?: HostTurnOutcome;
	lineage: HostTurnLineage;
	journalEntryId: string;
	preparedEntryId: string;
}

export interface PrepareHostTurnOperationInput {
	clientTurnId: string;
	kind: HostTurnKind;
	payload: unknown;
	payloadFingerprint?: string;
	optionFingerprint?: string;
	turnOptions?: HostTurnOptions;
	lineage?: Partial<HostTurnLineage>;
}

export interface MarkHostTurnDispatchedInput {
	clientTurnId: string;
	payloadFingerprint: string;
	nativeIdentity: HostTurnNativeIdentity;
}

export interface SettleHostTurnOperationInput {
	clientTurnId: string;
	payloadFingerprint: string;
	outcome: HostTurnOutcome;
}

export interface CancelPreparedHostTurnOperationInput {
	clientTurnId: string;
	payloadFingerprint: string;
	outcome: "cancelled" | "aborted";
}

export interface HostTurnBoundary {
	clientTurnId: string;
	kind: HostTurnKind;
	payloadFingerprint: string;
	status: HostTurnOperationStatus;
	outcome?: HostTurnOutcome;
	preparedAt: string;
	dispatchedAt?: string;
	settledAt?: string;
	nativeIdentity?: HostTurnNativeIdentity;
	lineage: HostTurnLineage;
	operationId: string;
	preparedEntryId: string;
}

export interface HostTurnRollbackInput {
	count: number;
	expectedClientTurnIds: string[];
}

export interface HostTurnRollbackResult {
	removedClientTurnIds: string[];
	remainingTurns: HostTurnBoundary[];
	sessionId: string;
	sessionFile?: string;
}

interface HostTurnOperationData extends Omit<HostTurnOperation, "journalEntryId" | "preparedEntryId"> {
	preparedEntryId?: string;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (item !== undefined) result[key] = canonicalize(item);
	}
	return result;
}

export function hostTurnOptionsEqual(left: HostTurnOptions | undefined, right: HostTurnOptions | undefined): boolean {
	return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function fingerprintHostTurnPayload(kind: HostTurnKind, payload: unknown): string {
	const canonical = JSON.stringify(canonicalize({ kind, payload }));
	return Bun.hash(canonical).toString(16).padStart(16, "0");
}

function isHostTurnKind(value: unknown): value is HostTurnKind {
	return value === "prompt" || value === "follow_up" || value === "plan_execute" || value === "plan_refine";
}

function isHostTurnOperationStatus(value: unknown): value is HostTurnOperationStatus {
	return value === "prepared" || value === "dispatched" || value === "settled";
}

function isHostTurnOutcome(value: unknown): value is HostTurnOutcome {
	return value === "completed" || value === "cancelled" || value === "aborted" || value === "failed";
}

function parseNativeIdentity(value: unknown): HostTurnNativeIdentity | undefined {
	if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
	return {
		sessionId: value.sessionId,
		entryId: typeof value.entryId === "string" ? value.entryId : undefined,
		sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
	};
}

function parseTurnOptions(value: unknown): HostTurnOptions | undefined {
	if (!isRecord(value) || typeof value.modelId !== "string") return undefined;
	if (value.provider !== undefined && typeof value.provider !== "string") return undefined;
	if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") return undefined;
	if (value.fastMode !== undefined && typeof value.fastMode !== "boolean") return undefined;
	return {
		provider: value.provider,
		modelId: value.modelId,
		thinkingLevel: value.thinkingLevel,
		fastMode: value.fastMode,
	};
}

function parseLineage(value: unknown): HostTurnLineage | undefined {
	if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
	return {
		sessionId: value.sessionId,
		sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
		parentSessionId: typeof value.parentSessionId === "string" ? value.parentSessionId : undefined,
		parentSessionFile: typeof value.parentSessionFile === "string" ? value.parentSessionFile : undefined,
	};
}

export function parseHostTurnOperationEntry(entry: SessionEntry): HostTurnOperation | undefined {
	if (entry.type !== "custom" || entry.customType !== HOST_TURN_OPERATION_CUSTOM_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	const data = entry.data;
	if (
		data.schemaVersion !== 1 ||
		typeof data.operationId !== "string" ||
		typeof data.clientTurnId !== "string" ||
		!isHostTurnKind(data.kind) ||
		typeof data.payloadFingerprint !== "string" ||
		!isHostTurnOperationStatus(data.status) ||
		typeof data.preparedAt !== "string"
	) {
		return undefined;
	}
	const lineage = parseLineage(data.lineage);
	if (!lineage) return undefined;
	const turnOptions = parseTurnOptions(data.turnOptions);
	// Present-but-invalid turnOptions must fail the whole entry (like lineage/outcome).
	if (data.turnOptions !== undefined && turnOptions === undefined) return undefined;
	const outcome = data.outcome === undefined ? undefined : isHostTurnOutcome(data.outcome) ? data.outcome : undefined;
	if (data.outcome !== undefined && outcome === undefined) return undefined;
	return {
		schemaVersion: 1,
		operationId: data.operationId,
		clientTurnId: data.clientTurnId,
		kind: data.kind,
		payload: data.payload,
		payloadFingerprint: data.payloadFingerprint,
		optionFingerprint: typeof data.optionFingerprint === "string" ? data.optionFingerprint : undefined,
		turnOptions,
		status: data.status,
		preparedAt: data.preparedAt,
		dispatchedAt: typeof data.dispatchedAt === "string" ? data.dispatchedAt : undefined,
		settledAt: typeof data.settledAt === "string" ? data.settledAt : undefined,
		nativeIdentity: parseNativeIdentity(data.nativeIdentity),
		outcome,
		lineage,
		journalEntryId: entry.id,
		preparedEntryId:
			typeof data.preparedEntryId === "string" && data.preparedEntryId.length > 0 ? data.preparedEntryId : entry.id,
	};
}

export function foldHostTurnOperations(entries: readonly SessionEntry[]): HostTurnOperation[] {
	const byClientTurnId = new Map<string, HostTurnOperation>();
	for (const entry of entries) {
		const operation = parseHostTurnOperationEntry(entry);
		if (operation) byClientTurnId.set(operation.clientTurnId, operation);
	}
	return [...byClientTurnId.values()];
}

export function hostTurnOperationData(operation: HostTurnOperation): HostTurnOperationData {
	return {
		schemaVersion: 1,
		operationId: operation.operationId,
		clientTurnId: operation.clientTurnId,
		kind: operation.kind,
		payload: operation.payload,
		payloadFingerprint: operation.payloadFingerprint,
		optionFingerprint: operation.optionFingerprint,
		turnOptions: operation.turnOptions,
		status: operation.status,
		preparedAt: operation.preparedAt,
		dispatchedAt: operation.dispatchedAt,
		settledAt: operation.settledAt,
		nativeIdentity: operation.nativeIdentity,
		outcome: operation.outcome,
		lineage: operation.lineage,
		preparedEntryId: operation.preparedEntryId || undefined,
	};
}

export function isHostTurnOperationEntry(entry: SessionEntry): entry is CustomEntry<HostTurnOperationData> {
	return parseHostTurnOperationEntry(entry) !== undefined;
}
