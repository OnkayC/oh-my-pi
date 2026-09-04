import { type BankScope, ensureBankExists } from "../hindsight/bank";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	truncateRecallQuery,
} from "../hindsight/content";
import { loadMentalModelsBlock } from "../hindsight/mental-models";
import { loadBridgeConfig } from "./config";
import { type BridgeHarness, deleteHookState, type HookState, readHookState, writeHookState } from "./hook-state";
import { type BridgeRuntime, createBridgeRuntime, ensureBridgeBankAndModels } from "./runtime";
import { parseCodexTranscript, parseGrokTranscript, resolveGrokTranscriptPath } from "./transcripts";

export type HookEvent = "session-start" | "user-prompt-submit" | "stop";

export interface HookOutput {
	hookSpecificOutput: {
		hookEventName: "SessionStart" | "UserPromptSubmit";
		additionalContext: string;
	};
}

interface NormalizedHookInput {
	sessionId: string;
	cwd: string;
	prompt?: string;
	transcriptPath?: string;
	messages?: HindsightMessage[];
}

function inputRecord(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Hook input must be a JSON object.");
	}
	return input as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Hook payload is missing ${label}.`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function inlineMessages(value: unknown): HindsightMessage[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Hook payload messages must be an array.");
	return value.map((item, index) => {
		const message = inputRecord(item);
		return {
			role: requiredString(message.role, `messages[${index}].role`),
			content: requiredString(message.content, `messages[${index}].content`),
			timestamp: optionalString(message.timestamp),
		};
	});
}

function normalizeHookInput(harness: BridgeHarness, input: unknown): NormalizedHookInput {
	const record = inputRecord(input);
	if (harness === "codex" || harness === "amp") {
		return {
			sessionId: requiredString(record.session_id, "session_id"),
			cwd: requiredString(record.cwd, "cwd"),
			prompt: optionalString(record.prompt ?? record.user_prompt),
			transcriptPath: harness === "codex" ? optionalString(record.transcript_path) : undefined,
			messages: harness === "amp" ? inlineMessages(record.messages) : undefined,
		};
	}
	return {
		sessionId: requiredString(record.sessionId, "sessionId"),
		cwd: requiredString(record.cwd, "cwd"),
		prompt: optionalString(record.prompt),
	};
}

function newHookState(harness: BridgeHarness, input: NormalizedHookInput, scope: BankScope): HookState {
	return {
		version: 1,
		harness,
		sessionId: input.sessionId,
		cwd: input.cwd,
		scope,
		startedAt: new Date().toISOString(),
		recallAttempted: false,
	};
}

async function runtimeForState(state: HookState): Promise<BridgeRuntime> {
	const runtime = await createBridgeRuntime(loadBridgeConfig(), state.cwd);
	runtime.scope = state.scope;
	return runtime;
}

async function sessionStart(harness: BridgeHarness, input: NormalizedHookInput): Promise<HookOutput | undefined> {
	const runtime = await createBridgeRuntime(loadBridgeConfig(), input.cwd);
	const state = newHookState(harness, input, runtime.scope);
	await ensureBridgeBankAndModels(runtime);
	await writeHookState(state);
	if (!runtime.config.hindsight.mentalModelsEnabled) return undefined;
	const block = await loadMentalModelsBlock(
		runtime.client,
		runtime.scope.bankId,
		runtime.config.hindsight.mentalModelMaxRenderChars,
		runtime.scope.recallTags,
	);
	return block ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } } : undefined;
}

async function userPromptSubmit(harness: BridgeHarness, input: NormalizedHookInput): Promise<HookOutput | undefined> {
	let state = await readHookState(harness, input.sessionId);
	if (!state) {
		const runtime = await createBridgeRuntime(loadBridgeConfig(), input.cwd);
		state = newHookState(harness, input, runtime.scope);
		await writeHookState(state);
	}
	if ((harness !== "amp" && state.recallAttempted) || !input.prompt) return undefined;
	const runtime = await runtimeForState(state);
	const query = composeRecallQuery(
		input.prompt,
		[{ role: "user", content: input.prompt }],
		runtime.config.hindsight.recallContextTurns,
	);
	const truncated = truncateRecallQuery(query, input.prompt, runtime.config.hindsight.recallMaxQueryChars);
	try {
		const response = await runtime.client.recall(runtime.scope.bankId, truncated, {
			budget: runtime.config.hindsight.recallBudget,
			maxTokens: runtime.config.hindsight.recallMaxTokens,
			types: runtime.config.hindsight.recallTypes.length > 0 ? runtime.config.hindsight.recallTypes : undefined,
			tags: runtime.scope.recallTags,
			tagsMatch: runtime.scope.recallTagsMatch,
		});
		const results = response.results ?? [];
		if (results.length === 0) return undefined;
		const block = `<memories>\n${runtime.config.hindsight.recallPromptPreamble}\nCurrent time: ${formatCurrentTime()} UTC\n\n${formatMemories(results)}\n</memories>`;
		return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } };
	} finally {
		state.recallAttempted = true;
		await writeHookState(state);
	}
}

async function stop(harness: BridgeHarness, input: NormalizedHookInput): Promise<void> {
	let state = await readHookState(harness, input.sessionId);
	if (!state) {
		const runtime = await createBridgeRuntime(loadBridgeConfig(), input.cwd);
		state = newHookState(harness, input, runtime.scope);
		await writeHookState(state);
	}
	const runtime = await runtimeForState(state);
	let messages: HindsightMessage[];
	let transcriptSource: string;
	if (harness === "amp") {
		if (!input.messages) throw new Error("Hook payload is missing messages.");
		messages = input.messages;
		transcriptSource = "Amp hook payload";
	} else {
		const transcriptPath =
			harness === "codex"
				? requiredString(input.transcriptPath, "transcript_path")
				: await resolveGrokTranscriptPath(state.cwd, state.sessionId);
		messages =
			harness === "codex" ? await parseCodexTranscript(transcriptPath) : await parseGrokTranscript(transcriptPath);
		transcriptSource = transcriptPath;
	}
	const { transcript } = prepareRetentionTranscript(messages, true, { includeTimestamps: true });
	if (!transcript) throw new Error(`Transcript contains no retainable messages: ${transcriptSource}`);
	await ensureBankExists(runtime.client, runtime.scope.bankId, runtime.config.hindsight, runtime.banksSet);
	await runtime.client.retain(runtime.scope.bankId, transcript, {
		documentId: state.sessionId,
		updateMode: "replace",
		context: runtime.config.hindsight.retainContext,
		metadata: { session_id: state.sessionId, harness, cwd: state.cwd },
		tags: runtime.scope.retainTags,
		observationScopes: runtime.scope.observationScopes,
		async: true,
	});
	await deleteHookState(harness, state.sessionId);
}

export async function handleHook(
	harness: BridgeHarness,
	event: HookEvent,
	input: unknown,
): Promise<HookOutput | undefined> {
	const normalized = normalizeHookInput(harness, input);
	switch (event) {
		case "session-start":
			return await sessionStart(harness, normalized);
		case "user-prompt-submit":
			return await userPromptSubmit(harness, normalized);
		case "stop":
			await stop(harness, normalized);
			return undefined;
	}
}
