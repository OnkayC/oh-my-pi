/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import {
	HINDSIGHT_DEFAULT_RECALL_TYPES,
	HINDSIGHT_DEFAULTS,
	HINDSIGHT_RECALL_BUDGETS,
	HINDSIGHT_RETAIN_MODES,
	HINDSIGHT_SCOPING_VALUES,
} from "./defaults";

/** Integer `HINDSIGHT_*` variables: base-10 `parseInt` prefix (`5000ms` → 5000, `2.5` → 2); other text is unset. */
function parseEnvInteger(raw: string): number | undefined {
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : undefined;
}

// Hindsight (https://hindsight.vectorize.io)
export const cfgHindsightApiUrl = register({
	id: "hindsight.apiUrl",
	env: "HINDSIGHT_API_URL",
	type: "string",
	default: HINDSIGHT_DEFAULTS.hindsightApiUrl ?? undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight API URL",
		description: "Hindsight server URL (Cloud or self-hosted)",
		condition: "hindsightActive",
	},
});

export const cfgHindsightApiToken = register({
	id: "hindsight.apiToken",
	env: "HINDSIGHT_API_TOKEN",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight API Token",
		description: "Bearer token for authenticated Hindsight servers",
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankId = register({
	id: "hindsight.bankId",
	env: "HINDSIGHT_BANK_ID",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Bank ID",
		description: "Memory bank identifier (default: project name)",
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankIdPrefix = register({ id: "hindsight.bankIdPrefix", type: "string", default: undefined });

export const cfgHindsightScoping = register({
	id: "hindsight.scoping",
	env: "HINDSIGHT_SCOPING",
	type: "enum",
	values: HINDSIGHT_SCOPING_VALUES,
	default: HINDSIGHT_DEFAULTS.scoping,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Scoping",
		description:
			"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
		options: [
			{
				value: "global",
				label: "Global",
				description: "One shared bank — every project sees the same memories",
			},
			{
				value: "per-project",
				label: "Per project",
				description: "Isolated bank per cwd basename — projects cannot see each other's memories",
			},
			{
				value: "per-project-tagged",
				label: "Per project (tagged)",
				description:
					"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
			},
		],
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankMission = register({
	id: "hindsight.bankMission",
	env: "HINDSIGHT_BANK_MISSION",
	type: "string",
	default: undefined,
});

export const cfgHindsightRetainMission = register({
	id: "hindsight.retainMission",
	type: "string",
	default: undefined,
});

export const cfgHindsightAutoRecall = register({
	id: "hindsight.autoRecall",
	env: "HINDSIGHT_AUTO_RECALL",
	type: "boolean",
	default: HINDSIGHT_DEFAULTS.autoRecall,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Auto Recall",
		description: "Recall memories on the first turn of each session",
		condition: "hindsightActive",
	},
});

export const cfgHindsightAutoRetain = register({
	id: "hindsight.autoRetain",
	env: "HINDSIGHT_AUTO_RETAIN",
	type: "boolean",
	default: HINDSIGHT_DEFAULTS.autoRetain,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Auto Retain",
		description: "Retain transcript every N turns and at session boundaries",
		condition: "hindsightActive",
	},
});

export const cfgHindsightRetainMode = register({
	id: "hindsight.retainMode",
	env: "HINDSIGHT_RETAIN_MODE",
	type: "enum",
	values: HINDSIGHT_RETAIN_MODES,
	default: HINDSIGHT_DEFAULTS.retainMode,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Retain Mode",
		description: "full-session = upsert one document per session, last-turn = chunked",
		options: [
			{
				value: "full-session",
				label: "Full session",
				description: "Upsert one document per session (recommended)",
			},
			{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
		],
		condition: "hindsightActive",
	},
});

export const cfgHindsightRetainEveryNTurns = register({
	id: "hindsight.retainEveryNTurns",
	env: { name: "HINDSIGHT_RETAIN_EVERY_N_TURNS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.retainEveryNTurns,
});

export const cfgHindsightRetainOverlapTurns = register({
	id: "hindsight.retainOverlapTurns",
	type: "number",
	default: HINDSIGHT_DEFAULTS.retainOverlapTurns,
});

export const cfgHindsightRetainContext = register({
	id: "hindsight.retainContext",
	type: "string",
	default: HINDSIGHT_DEFAULTS.retainContext,
});

export const cfgHindsightRecallBudget = register({
	id: "hindsight.recallBudget",
	env: "HINDSIGHT_RECALL_BUDGET",
	type: "enum",
	values: HINDSIGHT_RECALL_BUDGETS,
	default: HINDSIGHT_DEFAULTS.recallBudget,
});

export const cfgHindsightRecallMaxTokens = register({
	id: "hindsight.recallMaxTokens",
	env: { name: "HINDSIGHT_RECALL_MAX_TOKENS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.recallMaxTokens,
});

export const cfgHindsightRecallContextTurns = register({
	id: "hindsight.recallContextTurns",
	env: { name: "HINDSIGHT_RECALL_CONTEXT_TURNS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.recallContextTurns,
});

export const cfgHindsightRecallMaxQueryChars = register({
	id: "hindsight.recallMaxQueryChars",
	env: { name: "HINDSIGHT_RECALL_MAX_QUERY_CHARS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.recallMaxQueryChars,
});

export const cfgHindsightRecallTypes = register({
	id: "hindsight.recallTypes",
	type: "array",
	default: HINDSIGHT_DEFAULT_RECALL_TYPES,
});

export const cfgHindsightDebug = register({
	id: "hindsight.debug",
	env: "HINDSIGHT_DEBUG",
	type: "boolean",
	default: HINDSIGHT_DEFAULTS.debug,
});

export const cfgHindsightRequestTimeoutMs = register({
	id: "hindsight.requestTimeoutMs",
	env: { name: "HINDSIGHT_REQUEST_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.requestTimeoutMs,
});

export const cfgHindsightReflectTimeoutMs = register({
	id: "hindsight.reflectTimeoutMs",
	env: { name: "HINDSIGHT_REFLECT_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.reflectTimeoutMs,
});

export const cfgHindsightRecallTimeoutMs = register({
	id: "hindsight.recallTimeoutMs",
	env: { name: "HINDSIGHT_RECALL_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.recallTimeoutMs,
});

export const cfgHindsightRetainTimeoutMs = register({
	id: "hindsight.retainTimeoutMs",
	env: { name: "HINDSIGHT_RETAIN_TIMEOUT_MS", parse: parseEnvInteger },
	type: "number",
	default: HINDSIGHT_DEFAULTS.retainTimeoutMs,
});

export const cfgHindsightMentalModelsEnabled = register({
	id: "hindsight.mentalModelsEnabled",
	type: "boolean",
	default: HINDSIGHT_DEFAULTS.mentalModelsEnabled,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Mental Models",
		description:
			"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
		condition: "hindsightActive",
	},
});

export const cfgHindsightMentalModelAutoSeed = register({
	id: "hindsight.mentalModelAutoSeed",
	type: "boolean",
	default: HINDSIGHT_DEFAULTS.mentalModelAutoSeed,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Mental Model Auto-Seed",
		description:
			"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
		condition: "hindsightActive",
	},
});

export const cfgHindsightMentalModelMaxRenderChars = register({
	id: "hindsight.mentalModelMaxRenderChars",
	type: "number",
	default: HINDSIGHT_DEFAULTS.mentalModelMaxRenderChars,
});
