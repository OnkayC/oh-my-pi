import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { ensureBankExists } from "../hindsight/bank";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	retentionPrefixKey,
	truncateRecallQuery,
} from "../hindsight/content";
import { tryLoadMentalModelsBlock } from "../hindsight/mental-models";
import bindingTemplate from "./binding.md" with { type: "text" };
import { loadBridgeConfig } from "./config";
import { type BridgeHarness, hookDocumentId, type HookState, readHookState, writeHookState } from "./hook-state";
import { type BridgeRuntime, createBridgeRuntime, ensureBridgeBankAndModels } from "./runtime";
import { parseCodexTranscript, parseGrokTranscript, resolveGrokTranscriptPath } from "./transcripts";

export type HookEvent = "session-start" | "user-prompt-submit" | "stop" | "session-end";

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

interface HookTranscript {
	source: string;
	messages: HindsightMessage[];
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

function newHookState(harness: BridgeHarness, input: NormalizedHookInput, runtime: BridgeRuntime): HookState {
	return {
		version: 2,
		harness,
		sessionId: input.sessionId,
		cwd: runtime.cwd,
		primaryRoot: runtime.primaryRoot,
		scope: runtime.scope,
		startedAt: new Date().toISOString(),
		recallAttempted: false,
		segment: 0,
		needsBoundary: false,
		transcript: "",
		userTurns: 0,
		retainedTurns: 0,
		messageCount: 0,
		retainedMessageCount: 0,
	};
}

async function readTranscript(harness: BridgeHarness, input: NormalizedHookInput): Promise<HookTranscript> {
	if (harness === "amp") {
		if (!input.messages) throw new Error("Hook payload is missing messages.");
		return { source: "Amp hook payload", messages: input.messages };
	}
	const source =
		harness === "codex"
			? requiredString(input.transcriptPath, "transcript_path")
			: await resolveGrokTranscriptPath(input.cwd, input.sessionId);
	return {
		source,
		messages: harness === "codex" ? await parseCodexTranscript(source) : await parseGrokTranscript(source),
	};
}

function setCursor(state: HookState, transcript: HookTranscript): void {
	state.cursor = {
		source: transcript.source,
		messageCount: transcript.messages.length,
		prefixKey: retentionPrefixKey(transcript.messages, transcript.messages.length),
	};
	state.needsBoundary = false;
}

async function retainState(state: HookState, runtime: BridgeRuntime, force: boolean): Promise<void> {
	if (
		!runtime.config.hindsight.autoRetain ||
		!state.transcript ||
		state.messageCount === state.retainedMessageCount ||
		(!force && state.userTurns - state.retainedTurns < runtime.config.hindsight.retainEveryNTurns)
	) {
		return;
	}
	await ensureBankExists(runtime.client, state.scope.bankId, runtime.config.hindsight, runtime.banksSet);
	await runtime.client.retain(state.scope.bankId, state.transcript, {
		documentId: hookDocumentId(state),
		updateMode: "replace",
		context: runtime.config.hindsight.retainContext,
		metadata: { session_id: state.sessionId, harness: state.harness, cwd: state.cwd },
		tags: state.scope.retainTags,
		observationScopes: state.scope.observationScopes,
		async: true,
	});
	state.retainedTurns = state.userTurns;
	state.retainedMessageCount = state.messageCount;
	await writeHookState(state);
}

async function bindHookState(
	harness: BridgeHarness,
	event: HookEvent,
	input: NormalizedHookInput,
	runtime: BridgeRuntime,
): Promise<{ state: HookState; bindingChanged: boolean }> {
	let state = await readHookState(harness, input.sessionId);
	let bindingChanged = !state || state.cwd !== runtime.cwd;
	if (!state) {
		state = newHookState(harness, input, runtime);
		state.needsBoundary = event === "stop" || event === "session-end";
	} else if (
		state.primaryRoot !== runtime.primaryRoot ||
		JSON.stringify(state.scope) !== JSON.stringify(runtime.scope)
	) {
		// Flush the previous project under its original identity before cutting over.
		// The cached transcript contains only messages observed while bound there.
		await retainState(state, runtime, true);
		const previous = state;
		state = newHookState(harness, input, runtime);
		state.segment = previous.segment + 1;
		state.pendingProjectContext = true;
		state.cursor = previous.cursor;
		state.needsBoundary = !previous.cursor || event === "stop" || event === "session-end";
		bindingChanged = true;
	} else {
		state.cwd = runtime.cwd;
	}
	// A start/submit payload can establish a boundary before the next turn. On
	// resume, existing state is kept: neither its recall latch nor cadence resets.
	if (
		(event === "session-start" || event === "user-prompt-submit") &&
		(!state.cursor || state.needsBoundary) &&
		(input.transcriptPath || input.messages)
	) {
		const transcript = await readTranscript(harness, input);
		const last = transcript.messages.at(-1);
		if (event === "user-prompt-submit" && last?.role === "user" && last.content === input.prompt) {
			transcript.messages.pop();
		}
		setCursor(state, transcript);
	}
	await writeHookState(state);
	return { state, bindingChanged };
}

async function userPromptContext(
	state: HookState,
	input: NormalizedHookInput,
	runtime: BridgeRuntime,
): Promise<string> {
	if (state.recallAttempted || !input.prompt || !runtime.config.hindsight.autoRecall) return "";
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
		return results.length === 0
			? ""
			: `<memories>\n${runtime.config.hindsight.recallPromptPreamble}\nCurrent time: ${formatCurrentTime()} UTC\n\n${formatMemories(results)}\n</memories>`;
	} finally {
		state.recallAttempted = true;
		await writeHookState(state);
	}
}

async function stop(
	state: HookState,
	input: NormalizedHookInput,
	runtime: BridgeRuntime,
	force: boolean,
): Promise<void> {
	const transcript = await readTranscript(state.harness, input);
	const cursor = state.cursor;
	if (
		state.needsBoundary ||
		(cursor &&
			(cursor.messageCount > transcript.messages.length ||
				retentionPrefixKey(transcript.messages, cursor.messageCount) !== cursor.prefixKey))
	) {
		// Rewritten/compacted logs and late cwd changes have no provable boundary.
		// Preserve known content and exclude the ambiguous snapshot, never retag it.
		await retainState(state, runtime, true);
		setCursor(state, transcript);
		await writeHookState(state);
		throw new Error(
			"Transcript boundary changed; ambiguous history was excluded. Retention resumes with the next turn.",
		);
	}
	const messages = transcript.messages.slice(cursor?.messageCount ?? 0);
	const { transcript: addition } = prepareRetentionTranscript(messages, true, { includeTimestamps: true });
	if (addition) {
		state.transcript = state.transcript ? `${state.transcript}\n\n${addition}` : addition;
		state.userTurns += messages.filter(message => message.role === "user").length;
		state.messageCount += messages.length;
	}
	setCursor(state, transcript);
	await writeHookState(state);
	await retainState(state, runtime, force);
}

export async function handleHook(
	harness: BridgeHarness,
	event: HookEvent,
	input: unknown,
): Promise<HookOutput | undefined> {
	const normalized = normalizeHookInput(harness, input);
	const runtime = await createBridgeRuntime(loadBridgeConfig(), normalized.cwd);
	const { state, bindingChanged } = await bindHookState(harness, event, normalized, runtime);
	if (event === "stop" || event === "session-end") {
		await stop(state, normalized, runtime, event === "session-end");
		return undefined;
	}
	const projectChanged = state.pendingProjectContext === true;
	let projectContextLoaded = true;
	const context: string[] = [];
	if (event === "session-start" || bindingChanged || projectChanged || !state.recallAttempted) {
		context.push(
			prompt.render(bindingTemplate, {
				scope: JSON.stringify({ session_id: state.sessionId, cwd: state.cwd }),
				projectChanged,
			}),
		);
	}
	if (event === "session-start" || projectChanged) {
		await ensureBridgeBankAndModels(runtime);
		if (runtime.config.hindsight.mentalModelsEnabled) {
			const result = await tryLoadMentalModelsBlock(
				runtime.client,
				runtime.scope.bankId,
				runtime.config.hindsight.mentalModelMaxRenderChars,
				runtime.scope.recallTags,
			);
			projectContextLoaded = result.ok;
			if (result.ok && result.block) context.push(result.block);
		}
	}
	if (event === "user-prompt-submit") {
		const block = await userPromptContext(state, normalized, runtime);
		if (block) context.push(block);
	}
	if (projectChanged && projectContextLoaded) {
		state.pendingProjectContext = false;
		await writeHookState(state);
	}
	return context.length > 0
		? {
				hookSpecificOutput: {
					hookEventName: event === "session-start" ? "SessionStart" : "UserPromptSubmit",
					additionalContext: context.join("\n\n"),
				},
			}
		: undefined;
}
