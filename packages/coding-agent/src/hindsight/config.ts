/**
 * Resolved Hindsight runtime configuration.
 *
 * Source of truth precedence (last wins):
 *   1. Built-in defaults
 *   2. Settings (`hindsight.*` schema entries via `Settings.get(...)`)
 *   3. `HINDSIGHT_*` environment variables
 *
 * Env wins because operators frequently override per-shell (CI, prod) without
 * touching the persisted settings file.
 */

import * as logger from "@oh-my-pi/pi-utils/logger";
import type { Settings } from "../config/settings";
import {
	HINDSIGHT_RECALL_BUDGETS,
	HINDSIGHT_RETAIN_MODES,
	HINDSIGHT_SCOPING_VALUES,
	resolveHindsightConfig,
} from "./defaults";

export type HindsightScoping = "global" | "per-project" | "per-project-tagged";

export interface HindsightConfig {
	hindsightApiUrl: string | null;
	hindsightApiToken: string | null;

	bankId: string | null;
	bankIdPrefix: string;
	scoping: HindsightScoping;
	bankMission: string;
	retainMission: string | null;

	autoRecall: boolean;
	autoRetain: boolean;

	retainMode: "full-session" | "last-turn";
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	retainContext: string;

	recallBudget: "low" | "mid" | "high";
	recallMaxTokens: number;
	recallTypes: string[];
	recallContextTurns: number;
	recallMaxQueryChars: number;
	recallPromptPreamble: string;

	debug: boolean;

	/** Default per-request client deadline (ms) for ops without a specific override. */
	requestTimeoutMs: number;
	/** Client deadline (ms) for reflect (agentic synthesis; costlier than a metadata fetch). */
	reflectTimeoutMs: number;
	/** Client deadline (ms) for recall. */
	recallTimeoutMs: number;
	/** Client deadline (ms) for retain / retainBatch. */
	retainTimeoutMs: number;

	mentalModelsEnabled: boolean;
	mentalModelAutoSeed: boolean;
	mentalModelRefreshIntervalMs: number;
	mentalModelMaxRenderChars: number;
}

/** Load Hindsight config from OMP settings, then apply environment overrides. */
export function loadHindsightConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): HindsightConfig {
	const retainMode = settings.get("hindsight.retainMode");
	if (retainMode && !HINDSIGHT_RETAIN_MODES.includes(retainMode)) {
		logger.warn("Hindsight: invalid retainMode setting, falling back to full-session", { value: retainMode });
	}
	const recallBudget = settings.get("hindsight.recallBudget");
	const scoping = settings.get("hindsight.scoping");
	if (scoping && !HINDSIGHT_SCOPING_VALUES.includes(scoping)) {
		logger.warn("Hindsight: invalid scoping setting, falling back to per-project-tagged", { value: scoping });
	}

	return resolveHindsightConfig(
		{
			hindsightApiUrl: settings.get("hindsight.apiUrl") ?? null,
			hindsightApiToken: settings.get("hindsight.apiToken") ?? null,
			bankId: settings.get("hindsight.bankId") ?? null,
			bankIdPrefix: settings.get("hindsight.bankIdPrefix"),
			scoping,
			bankMission: settings.get("hindsight.bankMission"),
			retainMission: settings.get("hindsight.retainMission") ?? null,
			autoRecall: settings.get("hindsight.autoRecall"),
			autoRetain: settings.get("hindsight.autoRetain"),
			retainMode,
			retainEveryNTurns: settings.get("hindsight.retainEveryNTurns"),
			retainOverlapTurns: settings.get("hindsight.retainOverlapTurns"),
			retainContext: settings.get("hindsight.retainContext"),
			recallBudget: HINDSIGHT_RECALL_BUDGETS.includes(recallBudget) ? recallBudget : undefined,
			recallMaxTokens: settings.get("hindsight.recallMaxTokens"),
			recallTypes: settings.get("hindsight.recallTypes") as string[],
			recallContextTurns: settings.get("hindsight.recallContextTurns"),
			recallMaxQueryChars: settings.get("hindsight.recallMaxQueryChars"),
			debug: settings.get("hindsight.debug"),
			requestTimeoutMs: settings.get("hindsight.requestTimeoutMs"),
			reflectTimeoutMs: settings.get("hindsight.reflectTimeoutMs"),
			recallTimeoutMs: settings.get("hindsight.recallTimeoutMs"),
			retainTimeoutMs: settings.get("hindsight.retainTimeoutMs"),
			mentalModelsEnabled: settings.get("hindsight.mentalModelsEnabled"),
			mentalModelAutoSeed: settings.get("hindsight.mentalModelAutoSeed"),
			mentalModelRefreshIntervalMs: settings.get("hindsight.mentalModelRefreshIntervalMs"),
			mentalModelMaxRenderChars: settings.get("hindsight.mentalModelMaxRenderChars"),
		},
		env,
	);
}

/** Whether the caller has enough config to talk to a Hindsight server. */
export function isHindsightConfigured(
	config: HindsightConfig,
): config is HindsightConfig & { hindsightApiUrl: string } {
	return typeof config.hindsightApiUrl === "string" && config.hindsightApiUrl.length > 0;
}
