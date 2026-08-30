import { randomUUID } from "node:crypto";
import { type BankScope, computeBankScope, ensureBankExists } from "../hindsight/bank";
import { createHindsightClient, type HindsightApi, type MentalModelSummary } from "../hindsight/client";
import { ensureMentalModels, mentalModelVisibleForTags, resolveSeedsForScope } from "../hindsight/mental-models";
import { resolvePrimaryProjectRoot } from "../hindsight/project-root";
import type { BridgeConfig } from "./config";

export interface BridgeRuntime {
	config: BridgeConfig;
	cwd: string;
	primaryRoot: string;
	scope: BankScope;
	client: HindsightApi;
	banksSet: Set<string>;
	processSessionId: string;
}

export async function createBridgeRuntime(config: BridgeConfig, cwd: string): Promise<BridgeRuntime> {
	const resolvedCwd = cwd.trim();
	if (!resolvedCwd) throw new Error("Bridge runtime requires a working directory.");
	return {
		config,
		cwd: resolvedCwd,
		primaryRoot: resolvePrimaryProjectRoot(resolvedCwd) ?? resolvedCwd,
		scope: computeBankScope(config.hindsight, resolvedCwd),
		client: createHindsightClient({ ...config.hindsight, hindsightApiUrl: config.apiUrl }),
		banksSet: new Set<string>(),
		processSessionId: randomUUID(),
	};
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
