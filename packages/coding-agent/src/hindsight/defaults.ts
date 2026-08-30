import type { HindsightConfig } from "./config";

export const HINDSIGHT_RETAIN_MODES = ["full-session", "last-turn"] as const;
export const HINDSIGHT_RECALL_BUDGETS = ["low", "mid", "high"] as const;
export const HINDSIGHT_SCOPING_VALUES = ["global", "per-project", "per-project-tagged"] as const;

export const HINDSIGHT_DEFAULT_RECALL_TYPES: string[] = ["world", "experience"];
export const HINDSIGHT_DEFAULT_PREAMBLE =
	"Relevant memories from past conversations (prioritize recent when conflicting). " +
	"Only use memories that are directly useful to continue this conversation; ignore the rest:";

export const HINDSIGHT_DEFAULTS: HindsightConfig = {
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "per-project-tagged",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: HINDSIGHT_DEFAULT_RECALL_TYPES,
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: HINDSIGHT_DEFAULT_PREAMBLE,
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 120_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 60_000,
	mentalModelsEnabled: true,
	mentalModelAutoSeed: true,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
};

export type HindsightConfigInput = Partial<Omit<HindsightConfig, "recallTypes">> & {
	recallTypes?: readonly string[];
};

function envBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["true", "1", "yes"].includes(value.toLowerCase());
}

function envInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function envString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

export function resolveHindsightConfig(
	input: HindsightConfigInput,
	env: NodeJS.ProcessEnv = process.env,
): HindsightConfig {
	return {
		hindsightApiUrl: envString(env.HINDSIGHT_API_URL) ?? input.hindsightApiUrl ?? HINDSIGHT_DEFAULTS.hindsightApiUrl,
		hindsightApiToken:
			envString(env.HINDSIGHT_API_TOKEN) ?? input.hindsightApiToken ?? HINDSIGHT_DEFAULTS.hindsightApiToken,
		bankId: envString(env.HINDSIGHT_BANK_ID) ?? input.bankId ?? HINDSIGHT_DEFAULTS.bankId,
		bankIdPrefix: input.bankIdPrefix ?? HINDSIGHT_DEFAULTS.bankIdPrefix,
		scoping:
			pick(env.HINDSIGHT_SCOPING, HINDSIGHT_SCOPING_VALUES) ??
			pick(input.scoping, HINDSIGHT_SCOPING_VALUES) ??
			HINDSIGHT_DEFAULTS.scoping,
		bankMission: envString(env.HINDSIGHT_BANK_MISSION) ?? input.bankMission ?? HINDSIGHT_DEFAULTS.bankMission,
		retainMission: input.retainMission ?? HINDSIGHT_DEFAULTS.retainMission,
		autoRecall: envBool(env.HINDSIGHT_AUTO_RECALL) ?? input.autoRecall ?? HINDSIGHT_DEFAULTS.autoRecall,
		autoRetain: envBool(env.HINDSIGHT_AUTO_RETAIN) ?? input.autoRetain ?? HINDSIGHT_DEFAULTS.autoRetain,
		retainMode:
			pick(env.HINDSIGHT_RETAIN_MODE, HINDSIGHT_RETAIN_MODES) ??
			pick(input.retainMode, HINDSIGHT_RETAIN_MODES) ??
			HINDSIGHT_DEFAULTS.retainMode,
		retainEveryNTurns:
			envInt(env.HINDSIGHT_RETAIN_EVERY_N_TURNS) ?? input.retainEveryNTurns ?? HINDSIGHT_DEFAULTS.retainEveryNTurns,
		retainOverlapTurns: input.retainOverlapTurns ?? HINDSIGHT_DEFAULTS.retainOverlapTurns,
		retainContext: input.retainContext ?? HINDSIGHT_DEFAULTS.retainContext,
		recallBudget:
			pick(env.HINDSIGHT_RECALL_BUDGET, HINDSIGHT_RECALL_BUDGETS) ??
			pick(input.recallBudget, HINDSIGHT_RECALL_BUDGETS) ??
			HINDSIGHT_DEFAULTS.recallBudget,
		recallMaxTokens:
			envInt(env.HINDSIGHT_RECALL_MAX_TOKENS) ?? input.recallMaxTokens ?? HINDSIGHT_DEFAULTS.recallMaxTokens,
		recallTypes: [...(input.recallTypes ?? HINDSIGHT_DEFAULT_RECALL_TYPES)],
		recallContextTurns:
			envInt(env.HINDSIGHT_RECALL_CONTEXT_TURNS) ??
			input.recallContextTurns ??
			HINDSIGHT_DEFAULTS.recallContextTurns,
		recallMaxQueryChars:
			envInt(env.HINDSIGHT_RECALL_MAX_QUERY_CHARS) ??
			input.recallMaxQueryChars ??
			HINDSIGHT_DEFAULTS.recallMaxQueryChars,
		recallPromptPreamble: input.recallPromptPreamble ?? HINDSIGHT_DEFAULTS.recallPromptPreamble,
		debug: envBool(env.HINDSIGHT_DEBUG) ?? input.debug ?? HINDSIGHT_DEFAULTS.debug,
		requestTimeoutMs:
			envInt(env.HINDSIGHT_REQUEST_TIMEOUT_MS) ?? input.requestTimeoutMs ?? HINDSIGHT_DEFAULTS.requestTimeoutMs,
		reflectTimeoutMs:
			envInt(env.HINDSIGHT_REFLECT_TIMEOUT_MS) ?? input.reflectTimeoutMs ?? HINDSIGHT_DEFAULTS.reflectTimeoutMs,
		recallTimeoutMs:
			envInt(env.HINDSIGHT_RECALL_TIMEOUT_MS) ?? input.recallTimeoutMs ?? HINDSIGHT_DEFAULTS.recallTimeoutMs,
		retainTimeoutMs:
			envInt(env.HINDSIGHT_RETAIN_TIMEOUT_MS) ?? input.retainTimeoutMs ?? HINDSIGHT_DEFAULTS.retainTimeoutMs,
		mentalModelsEnabled: input.mentalModelsEnabled ?? HINDSIGHT_DEFAULTS.mentalModelsEnabled,
		mentalModelAutoSeed: input.mentalModelAutoSeed ?? HINDSIGHT_DEFAULTS.mentalModelAutoSeed,
		mentalModelRefreshIntervalMs:
			input.mentalModelRefreshIntervalMs ?? HINDSIGHT_DEFAULTS.mentalModelRefreshIntervalMs,
		mentalModelMaxRenderChars: input.mentalModelMaxRenderChars ?? HINDSIGHT_DEFAULTS.mentalModelMaxRenderChars,
	};
}
