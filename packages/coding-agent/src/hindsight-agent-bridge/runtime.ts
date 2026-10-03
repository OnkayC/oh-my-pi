import * as path from "node:path";
import { type BankScope, computeBankScope, ensureBankExists } from "../hindsight/bank";
import { createHindsightClient, type HindsightApi, type MentalModelSummary } from "../hindsight/client";
import { ensureMentalModels, mentalModelVisibleForTags, resolveSeedsForScope } from "../hindsight/mental-models";
import { resolvePrimaryProjectRoot } from "../hindsight/project-root";
import type { BridgeConfig } from "./config";
import { type BridgeHarness, readHookState } from "./hook-state";

export interface BridgeRuntime {
	config: BridgeConfig;
	cwd: string;
	primaryRoot: string;
	scope: BankScope;
	client: HindsightApi;
	banksSet: Set<string>;
}

export async function createBridgeRuntime(config: BridgeConfig, cwd: string): Promise<BridgeRuntime> {
	const requestedCwd = cwd.trim();
	if (!path.isAbsolute(requestedCwd)) throw new Error("Bridge runtime requires an absolute working directory.");
	const resolvedCwd = path.resolve(requestedCwd);
	return {
		config,
		cwd: resolvedCwd,
		primaryRoot: resolvePrimaryProjectRoot(resolvedCwd) ?? resolvedCwd,
		scope: computeBankScope(config.hindsight, resolvedCwd),
		client: createHindsightClient({ ...config.hindsight, hindsightApiUrl: config.apiUrl }),
		banksSet: new Set<string>(),
	};
}

export async function resolveBridgeToolRuntime(
	config: BridgeConfig,
	harness: BridgeHarness,
	binding: { session_id?: string; cwd: string },
): Promise<BridgeRuntime> {
	const runtime = await createBridgeRuntime(config, binding.cwd);
	if (!binding.session_id) {
		if (harness === "codex")
			throw new Error("Codex memory tools require the session_id from the latest hook binding.");
		// Grok/Amp may not expose hook context to the agent. Explicit cwd still
		// provides deterministic per-call project scope, without inventing provenance.
		return runtime;
	}
	const state = await readHookState(harness, binding.session_id);
	if (!state) {
		throw new Error("No hook state for this session. Run the matching SessionStart or UserPromptSubmit hook first.");
	}
	if (
		runtime.cwd !== state.cwd ||
		runtime.primaryRoot !== state.primaryRoot ||
		JSON.stringify(runtime.scope) !== JSON.stringify(state.scope)
	) {
		throw new Error(
			"Stale Hindsight session scope. Use the latest hook binding after the host updates its working directory.",
		);
	}
	return runtime;
}

export async function ensureBridgeBankAndModels(runtime: BridgeRuntime): Promise<void> {
	await ensureBankExists(runtime.client, runtime.scope.bankId, runtime.config.hindsight, runtime.banksSet);
	if (!runtime.config.hindsight.mentalModelsEnabled || !runtime.config.hindsight.mentalModelAutoSeed) return;
	const seeds = resolveSeedsForScope(runtime.scope, runtime.config.hindsight.scoping);
	if (seeds.length > 0) {
		await ensureMentalModels(runtime.client, runtime.scope.bankId, seeds, runtime.config.hindsight.debug);
	}
}

export async function listVisibleMentalModels(runtime: BridgeRuntime): Promise<MentalModelSummary[]> {
	const response = await runtime.client.listMentalModels(runtime.scope.bankId, { detail: "metadata" });
	return (response.items ?? []).filter(model => mentalModelVisibleForTags(model, runtime.scope.recallTags));
}
