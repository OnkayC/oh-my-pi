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
	mentalModelMaxRenderChars: 16_000,
};

export type HindsightConfigInput = Partial<Omit<HindsightConfig, "recallTypes">> & {
	recallTypes?: readonly string[];
};

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

/** Resolve validated config without inheriting ambient OMP environment overrides. */
export function resolveHindsightConfig(input: HindsightConfigInput): HindsightConfig {
	return {
		hindsightApiUrl: input.hindsightApiUrl ?? HINDSIGHT_DEFAULTS.hindsightApiUrl,
		hindsightApiToken: input.hindsightApiToken ?? HINDSIGHT_DEFAULTS.hindsightApiToken,
		bankId: input.bankId ?? HINDSIGHT_DEFAULTS.bankId,
		bankIdPrefix: input.bankIdPrefix ?? HINDSIGHT_DEFAULTS.bankIdPrefix,
		scoping: pick(input.scoping, HINDSIGHT_SCOPING_VALUES) ?? HINDSIGHT_DEFAULTS.scoping,
		bankMission: input.bankMission ?? HINDSIGHT_DEFAULTS.bankMission,
		retainMission: input.retainMission ?? HINDSIGHT_DEFAULTS.retainMission,
		autoRecall: input.autoRecall ?? HINDSIGHT_DEFAULTS.autoRecall,
		autoRetain: input.autoRetain ?? HINDSIGHT_DEFAULTS.autoRetain,
		retainMode: pick(input.retainMode, HINDSIGHT_RETAIN_MODES) ?? HINDSIGHT_DEFAULTS.retainMode,
		retainEveryNTurns: input.retainEveryNTurns ?? HINDSIGHT_DEFAULTS.retainEveryNTurns,
		retainOverlapTurns: input.retainOverlapTurns ?? HINDSIGHT_DEFAULTS.retainOverlapTurns,
		retainContext: input.retainContext ?? HINDSIGHT_DEFAULTS.retainContext,
		recallBudget: pick(input.recallBudget, HINDSIGHT_RECALL_BUDGETS) ?? HINDSIGHT_DEFAULTS.recallBudget,
		recallMaxTokens: input.recallMaxTokens ?? HINDSIGHT_DEFAULTS.recallMaxTokens,
		recallTypes: [...(input.recallTypes ?? HINDSIGHT_DEFAULT_RECALL_TYPES)],
		recallContextTurns: input.recallContextTurns ?? HINDSIGHT_DEFAULTS.recallContextTurns,
		recallMaxQueryChars: input.recallMaxQueryChars ?? HINDSIGHT_DEFAULTS.recallMaxQueryChars,
		recallPromptPreamble: input.recallPromptPreamble ?? HINDSIGHT_DEFAULTS.recallPromptPreamble,
		debug: input.debug ?? HINDSIGHT_DEFAULTS.debug,
		requestTimeoutMs: input.requestTimeoutMs ?? HINDSIGHT_DEFAULTS.requestTimeoutMs,
		reflectTimeoutMs: input.reflectTimeoutMs ?? HINDSIGHT_DEFAULTS.reflectTimeoutMs,
		recallTimeoutMs: input.recallTimeoutMs ?? HINDSIGHT_DEFAULTS.recallTimeoutMs,
		retainTimeoutMs: input.retainTimeoutMs ?? HINDSIGHT_DEFAULTS.retainTimeoutMs,
		mentalModelsEnabled: input.mentalModelsEnabled ?? HINDSIGHT_DEFAULTS.mentalModelsEnabled,
		mentalModelAutoSeed: input.mentalModelAutoSeed ?? HINDSIGHT_DEFAULTS.mentalModelAutoSeed,
		mentalModelMaxRenderChars: input.mentalModelMaxRenderChars ?? HINDSIGHT_DEFAULTS.mentalModelMaxRenderChars,
	};
}
