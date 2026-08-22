import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { assistantMsg, userMsg } from "./utilities";

afterEach(() => {
	vi.restoreAllMocks();
});

const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

describe("AgentSession follow-up lifecycle and options", () => {
	it("queues one idempotent follow-up, applies options before its provider call, and clears promotion state", async () => {
		const initialModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const targetModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		const requestedModels: string[] = [];
		let callCount = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
			streamFn: requestedModel => {
				const stream = new AssistantMessageEventStream();
				const callIndex = callCount++;
				requestedModels.push(requestedModel.id);
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => {
							stream.push({ type: "done", reason: "stop", message });
						});
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const setModel = vi.spyOn(session, "setModel");
		const setThinkingLevel = vi.spyOn(session, "setThinkingLevel");
		const setFastMode = vi.spyOn(session, "setFastMode");
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		const promptPromise = session.prompt("First run");
		await streamStarted.promise;

		const followUpOptions = {
			clientTurnId: "turn-f1",
			optionFingerprint: "fingerprint-123",
			turnOptions: {
				provider: "anthropic",
				modelId: targetModel.id,
				thinkingLevel: Effort.High,
				fastMode: true,
			},
		};
		await session.followUp("Queued follow-up", undefined, followUpOptions);
		await session.followUp("Queued follow-up", undefined, followUpOptions);
		await expect(
			session.followUp("Queued follow-up", undefined, {
				...followUpOptions,
				turnOptions: { ...followUpOptions.turnOptions, thinkingLevel: Effort.Low },
			}),
		).rejects.toThrow("Host turn turn-f1: clientTurnId already exists with different turn options");

		expect(session.getQueuedMessages().followUp).toEqual(["Queued follow-up"]);
		expect(events.filter(event => event.type === "follow_up_queued")).toEqual([
			{
				type: "follow_up_queued",
				clientTurnId: "turn-f1",
				optionFingerprint: "fingerprint-123",
				queuePosition: 1,
			},
		]);

		finishFirstTurn.resolve();
		await promptPromise;
		await session.waitForIdle();

		const promotedEvent = events.find(event => event.type === "host_turn_promoted");
		expect(promotedEvent).toMatchObject({
			type: "host_turn_promoted",
			clientTurnId: "turn-f1",
			optionFingerprint: "fingerprint-123",
			model: "anthropic/claude-sonnet-4-5",
			thinkingLevel: "high",
			fastMode: true,
		});
		expect(requestedModels).toEqual([initialModel.id, targetModel.id]);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: targetModel.provider, id: targetModel.id }),
		);
		expect(setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(setThinkingLevel).toHaveBeenCalledWith(Effort.High);
		expect(setFastMode).toHaveBeenCalledTimes(1);
		expect(setFastMode).toHaveBeenCalledWith(true);

		await session.prompt("After promoted follow-up");
		expect(requestedModels).toEqual([initialModel.id, targetModel.id, targetModel.id]);
		expect(session.configuredThinkingLevel()).toBe(Effort.High);
		expect(session.isFastModeActive()).toBe(true);

		await session.dispose();
	});

	it.each(["model", "thinking level"] as const)(
		"keeps an identical durable retry idempotent after a promoted %s change",
		async optionKind => {
			const initialModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
			const promotedModel =
				optionKind === "model" ? getBundledModel("anthropic", "claude-sonnet-4-5")! : initialModel;
			const streamStarted = Promise.withResolvers<void>();
			const finishFirstTurn = Promise.withResolvers<void>();
			const requestedModels: string[] = [];
			let callCount = 0;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
				streamFn: requestedModel => {
					const stream = new AssistantMessageEventStream();
					const callIndex = callCount++;
					requestedModels.push(requestedModel.id);
					queueMicrotask(() => {
						const message = createAssistantMessage(`response ${callIndex + 1}`);
						stream.push({ type: "start", partial: message });
						if (callIndex === 0) {
							streamStarted.resolve();
							void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
						} else {
							stream.push({ type: "done", reason: "stop", message });
						}
					});
					return stream;
				},
			});
			const authStorage = await AuthStorage.create(":memory:");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			if (optionKind === "thinking level") session.setThinkingLevel(Effort.Low);

			const turnOptions = {
				provider: promotedModel.provider,
				modelId: promotedModel.id,
				...(optionKind === "thinking level" ? { thinkingLevel: Effort.High } : {}),
			};
			const durableOptions = {
				clientTurnId: `turn-promoted-${optionKind.replace(" ", "-")}`,
				optionFingerprint: `promoted-${optionKind}`,
				turnOptions,
			};
			const prompt = session.prompt("Initial run");
			await streamStarted.promise;
			await session.followUp("Durable option change", undefined, durableOptions);
			finishFirstTurn.resolve();
			await prompt;
			await session.waitForIdle();

			expect(session.model?.id).toBe(promotedModel.id);
			if (optionKind === "thinking level") expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(requestedModels).toEqual([initialModel.id, promotedModel.id]);
			await expect(session.followUp("Durable option change", undefined, durableOptions)).resolves.toBeUndefined();
			expect(requestedModels).toEqual([initialModel.id, promotedModel.id]);

			await expect(session.followUp("Different content", undefined, durableOptions)).rejects.toThrow(
				"clientTurnId already exists with different content",
			);
			const conflictingTurnOptions =
				optionKind === "model"
					? { ...turnOptions, modelId: initialModel.id }
					: { ...turnOptions, thinkingLevel: Effort.Low };
			await expect(
				session.followUp("Durable option change", undefined, {
					...durableOptions,
					turnOptions: conflictingTurnOptions,
				}),
			).rejects.toThrow("clientTurnId already exists with different turn options");

			await session.dispose();
			authStorage.close();
		},
	);

	it("tracks distinct host turns even when their messages share a timestamp", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const callIndex = callCount++;
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const promoted: string[] = [];
		session.subscribe(event => {
			if (event.type === "host_turn_promoted") promoted.push(event.clientTurnId);
		});

		const prompt = session.prompt("First run");
		await streamStarted.promise;
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		await session.followUp("First queued turn", undefined, {
			clientTurnId: "turn-same-time-1",
			optionFingerprint: "same-time-1",
		});
		await session.followUp("Second queued turn", undefined, {
			clientTurnId: "turn-same-time-2",
			optionFingerprint: "same-time-2",
		});

		finishFirstTurn.resolve();
		await prompt;
		await session.waitForIdle();
		expect(promoted).toEqual(["turn-same-time-1", "turn-same-time-2"]);

		await session.dispose();
	});

	it.each(["new", "switch"] as const)(
		"clears queued durable host-turn tracking after a successful %s session boundary",
		async transition => {
			const model = getBundledModel("anthropic", "claude-haiku-4-5")!;
			const streamStarted = Promise.withResolvers<void>();
			let callCount = 0;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: (_requestedModel, _context, options) => {
					const stream = new AssistantMessageEventStream();
					const callIndex = callCount++;
					queueMicrotask(() => {
						const message = createAssistantMessage(`response ${callIndex + 1}`);
						stream.push({ type: "start", partial: message });
						if (callIndex === 0) {
							streamStarted.resolve();
							options?.signal?.addEventListener(
								"abort",
								() => {
									message.stopReason = "aborted";
									stream.push({ type: "error", reason: "aborted", error: message });
								},
								{ once: true },
							);
						} else {
							stream.push({ type: "done", reason: "stop", message });
						}
					});
					return stream;
				},
			});
			const authStorage = await AuthStorage.create(":memory:");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const tempDir = TempDir.createSync("@pi-host-turn-boundary-");
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			try {
				const initialPrompt = session.prompt("Initial run");
				await streamStarted.promise;
				await session.followUp("Stale queued turn", undefined, {
					clientTurnId: "turn-reused-after-boundary",
					optionFingerprint: "before-boundary",
				});

				if (transition === "new") {
					expect(await session.newSession()).toBe(true);
				} else {
					const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
					await targetManager.ensureOnDisk();
					const targetPath = targetManager.getSessionFile();
					if (!targetPath) throw new Error("Expected target session file");
					await targetManager.close();
					expect(await session.switchSession(targetPath)).toBe(true);
				}
				await initialPrompt;

				await session.sessionManager.prepareHostTurnOperation({
					clientTurnId: "turn-reused-after-boundary",
					kind: "follow_up",
					payload: {
						text: "Fresh queued turn",
						synthetic: false,
						attribution: undefined,
						images: undefined,
						model: { provider: model.provider, id: model.id },
						thinkingLevel: session.configuredThinkingLevel(),
					},
					optionFingerprint: "after-boundary",
				});
				await session.followUpPreparedHostTurn("turn-reused-after-boundary");

				expect(callCount).toBe(1);
				expect(agent.peekFollowUpQueue()).toMatchObject([
					{ role: "user", content: [{ type: "text", text: "Fresh queued turn" }] },
				]);
				expect(
					session.sessionManager
						.getHostTurnOperations()
						.find(operation => operation.clientTurnId === "turn-reused-after-boundary"),
				).toMatchObject({ status: "prepared" });
			} finally {
				await session.dispose();
				authStorage.close();
				await tempDir.remove();
			}
		},
	);

	it("settles each promoted durable host turn from its own assistant result", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const callIndex = callCount++;
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
					} else if (callIndex === 1) {
						stream.push({ type: "done", reason: "stop", message });
					} else {
						message.stopReason = "error";
						message.errorMessage = "terminal failure";
						stream.push({ type: "error", reason: "error", error: message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.maxRetries": 0,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const initialPrompt = session.prompt("Initial run");
		await streamStarted.promise;
		await session.followUp("First durable follow-up", undefined, {
			clientTurnId: "turn-own-success",
			optionFingerprint: "own-success",
		});
		await session.followUp("Second durable follow-up", undefined, {
			clientTurnId: "turn-own-failure",
			optionFingerprint: "own-failure",
		});

		finishFirstTurn.resolve();
		await initialPrompt;
		await session.waitForIdle();

		const operations = session.sessionManager.getHostTurnOperations();
		expect(operations.find(operation => operation.clientTurnId === "turn-own-success")).toMatchObject({
			status: "settled",
			outcome: "completed",
		});
		expect(operations.find(operation => operation.clientTurnId === "turn-own-failure")).toMatchObject({
			status: "settled",
			outcome: "failed",
		});

		await session.dispose();
		authStorage.close();
	});

	it("keeps tracked host turns as option barriers when follow-up mode drains all messages", async () => {
		const initialModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const targetModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		const requestedModels: string[] = [];
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
			followUpMode: "all",
			streamFn: requestedModel => {
				const stream = new AssistantMessageEventStream();
				const callIndex = callCount++;
				requestedModels.push(requestedModel.id);
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const prompt = session.prompt("First run");
		await streamStarted.promise;
		await session.followUp("Ordinary queued turn");
		await session.followUp("Tracked queued turn", undefined, {
			clientTurnId: "turn-option-barrier",
			optionFingerprint: "option-barrier",
			turnOptions: { provider: targetModel.provider, modelId: targetModel.id },
		});

		finishFirstTurn.resolve();
		await prompt;
		await session.waitForIdle();
		expect(requestedModels).toEqual([initialModel.id, initialModel.id, targetModel.id]);

		await session.dispose();
	});

	it("dequeues hidden keyword companions with their durable host turn in one provider call", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTaskTool] },
			followUpMode: "all",
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const callIndex = callCount++;
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"magicKeywords.enabled": true,
				"magicKeywords.ultrathink": true,
				"magicKeywords.orchestrate": true,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const firstPrompt = session.prompt("First run");
		await streamStarted.promise;
		await session.prompt("ultrathink and orchestrate the durable follow-up", {
			streamingBehavior: "followUp",
			clientTurnId: "turn-companions",
			optionFingerprint: "companions",
			turnOptions: { provider: model.provider, modelId: model.id },
		});
		expect(
			agent.peekFollowUpQueue().map(message => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["ultrathink-notice", "orchestrate-notice", "user"]);

		finishFirstTurn.resolve();
		await firstPrompt;
		await session.waitForIdle();

		expect(callCount).toBe(2);
		expect(agent.peekFollowUpQueue()).toHaveLength(0);
		expect(
			session.sessionManager.getHostTurnOperations().find(operation => operation.clientTurnId === "turn-companions"),
		).toMatchObject({ status: "settled", outcome: "completed" });

		await session.dispose();
	});

	it("short-circuits identical retries for durable prompts queued while streaming", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			followUpMode: "all",
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const callIndex = streamCalls++;
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const firstPrompt = session.prompt("First run");
		await streamStarted.promise;
		expect(
			await session.prompt("Queued durable follow-up", {
				streamingBehavior: "followUp",
				clientTurnId: "turn-streaming-retry",
			}),
		).toBe(true);
		expect(agent.peekFollowUpQueue()).toHaveLength(1);

		expect(
			await session.prompt("Queued durable follow-up", {
				streamingBehavior: "followUp",
				clientTurnId: "turn-streaming-retry",
			}),
		).toBe(true);
		expect(agent.peekFollowUpQueue()).toHaveLength(1);

		finishFirstTurn.resolve();
		await firstPrompt;
		await session.waitForIdle();
		expect(streamCalls).toBe(2);
		expect(
			session.sessionManager
				.getHostTurnOperations()
				.find(operation => operation.clientTurnId === "turn-streaming-retry"),
		).toMatchObject({ kind: "follow_up", status: "settled", outcome: "completed" });

		await session.dispose();
		authStorage.close();
	});

	it("rejects invalid durable turn options before execution while accepting fastMode false", async () => {
		const initialModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const nonReasoningModel = getBundledModel("openai", "gpt-4o-mini")!;
		const unsupportedFastModel = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				providerCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("response");
					stream.push({ type: "start", partial: message });
					streamStarted.resolve();
					void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		for (const provider of ["anthropic", "openai", "amazon-bedrock"]) {
			authStorage.setRuntimeApiKey(provider, "test-key");
		}
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const firstPrompt = session.prompt("First run");
		await streamStarted.promise;
		const invalidCases = [
			{
				id: "missing-provider",
				options: { provider: "missing", modelId: "missing-model" },
				error: "Unavailable host-turn model missing/missing-model",
			},
			{
				id: "missing-model",
				options: { provider: initialModel.provider, modelId: "missing-model" },
				error: `Unavailable host-turn model ${initialModel.provider}/missing-model`,
			},
			{
				id: "invalid-thinking",
				options: { provider: initialModel.provider, modelId: initialModel.id, thinkingLevel: "turbo" },
				error: "Invalid host-turn thinking level turbo",
			},
			{
				id: "unsupported-thinking",
				options: {
					provider: nonReasoningModel.provider,
					modelId: nonReasoningModel.id,
					thinkingLevel: Effort.High,
				},
				error: `Host-turn thinking level high is unsupported by ${nonReasoningModel.provider}/${nonReasoningModel.id}`,
			},
			{
				id: "unsupported-option",
				options: { provider: initialModel.provider, modelId: initialModel.id, ignoredOption: true },
				error: "Unsupported host-turn option ignoredOption",
			},
			{
				id: "unsupported-fast",
				options: {
					provider: unsupportedFastModel.provider,
					modelId: unsupportedFastModel.id,
					fastMode: true,
				},
				error: `Host-turn fast mode is unsupported by ${unsupportedFastModel.provider}/${unsupportedFastModel.id}`,
			},
		] as const;
		for (const invalid of invalidCases) {
			await expect(
				session.followUp(`Invalid ${invalid.id}`, undefined, {
					clientTurnId: `turn-${invalid.id}`,
					optionFingerprint: invalid.id,
					turnOptions: invalid.options,
				}),
			).rejects.toThrow(invalid.error);
		}

		expect(providerCalls).toBe(1);
		expect(agent.peekFollowUpQueue()).toHaveLength(0);
		expect(session.sessionManager.getHostTurnOperations()).toHaveLength(0);

		const setFastMode = vi.spyOn(session, "setFastMode");
		await session.followUp("Run without fast mode", undefined, {
			clientTurnId: "turn-fast-off",
			optionFingerprint: "fast-off",
			turnOptions: {
				provider: unsupportedFastModel.provider,
				modelId: unsupportedFastModel.id,
				fastMode: false,
			},
		});

		finishFirstTurn.resolve();
		await firstPrompt;
		await session.waitForIdle();
		expect(providerCalls).toBe(2);
		expect(setFastMode).toHaveBeenCalledTimes(1);
		expect(setFastMode).toHaveBeenCalledWith(false);
		expect(session.isFastModeActive()).toBe(false);
		await session.dispose();
	});

	it("reapplies persisted turn options before recovering a prepared turn", async () => {
		const initialModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const targetModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
			streamFn: requestedModel => {
				requestedModels.push(requestedModel.id);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("recovered");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-recovery",
			kind: "follow_up",
			payload: {
				text: "Recover me",
				synthetic: false,
				attribution: undefined,
				images: undefined,
				model: { provider: initialModel.provider, id: initialModel.id },
				thinkingLevel: session.configuredThinkingLevel(),
			},
			optionFingerprint: "recovery-options",
			turnOptions: {
				provider: targetModel.provider,
				modelId: targetModel.id,
				thinkingLevel: Effort.High,
				fastMode: true,
			},
		});

		expect(await session.recoverPreparedHostTurns()).toEqual(["turn-recovery"]);
		expect(requestedModels).toEqual([targetModel.id]);
		expect(session.configuredThinkingLevel()).toBe(Effort.High);
		expect(session.isFastModeActive()).toBe(true);

		await session.dispose();
	});

	it("queues an explicitly prepared durable operation exactly once", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-prepared",
			kind: "plan_execute",
			payload: {
				text: "Execute prepared plan",
				synthetic: true,
				attribution: "agent",
				images: undefined,
				model: { provider: model.provider, id: model.id },
				thinkingLevel: session.configuredThinkingLevel(),
			},
		});

		await Promise.all([
			session.followUpPreparedHostTurn("turn-prepared"),
			session.followUpPreparedHostTurn("turn-prepared"),
		]);

		expect(agent.peekFollowUpQueue()).toHaveLength(1);
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-prepared", status: "prepared" },
		]);

		await session.dispose();
	});

	it("waits for asynchronous promoted-message persistence before retry recovery", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const dispatchStarted = Promise.withResolvers<void>();
		const releaseDispatch = Promise.withResolvers<void>();
		let requestedCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [createAssistantMessage("seed")],
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				requestedCalls++;
				queueMicrotask(() => {
					if (requestedCalls === 1) {
						const error = createAssistantMessage("");
						error.stopReason = "error";
						error.errorMessage = "503 service unavailable: overloaded_error";
						stream.push({ type: "start", partial: error });
						stream.push({ type: "error", reason: "error", error });
						return;
					}
					const recovered = createAssistantMessage("recovered");
					stream.push({ type: "start", partial: recovered });
					stream.push({ type: "done", reason: "stop", message: recovered });
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const appendEntriesAtomically = sessionManager.appendEntriesAtomically.bind(sessionManager);
		let atomicCallCount = 0;
		sessionManager.appendEntriesAtomically = async <T>(append: () => T): Promise<T> => {
			atomicCallCount++;
			if (atomicCallCount === 2) {
				dispatchStarted.resolve();
				await releaseDispatch.promise;
			}
			return await appendEntriesAtomically(append);
		};
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 1,
				"retry.maxRetries": 1,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.followUp("Retry after persistence", undefined, {
			clientTurnId: "turn-persistence",
			optionFingerprint: "persistence-options",
		});
		await dispatchStarted.promise;
		for (let spin = 0; spin < 10; spin++) await Promise.resolve();
		expect(requestedCalls).toBe(1);

		releaseDispatch.resolve();
		await session.waitForIdle();
		expect(requestedCalls).toBe(2);

		await session.dispose();
	});

	it("leaves queued host turns intact when rollback validation fails", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.followUp("Keep queued", undefined, {
			clientTurnId: "turn-rollback",
			optionFingerprint: "rollback-options",
		});

		await expect(session.rollbackHostTurns({ count: 0, expectedClientTurnIds: [] })).rejects.toThrow(
			"count must be a positive integer",
		);
		expect(session.getQueuedMessages().followUp).toEqual(["Keep queued"]);
		expect(session.sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-rollback", status: "prepared" },
		]);

		await session.dispose();
	});

	it("does not cancel newer prepared durable turns outside a validated rollback suffix", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const first = await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-older",
			kind: "prompt",
			payload: { message: "older" },
		});
		const olderEntryId = sessionManager.appendMessage(userMsg("older"));
		sessionManager.appendMessage(assistantMsg("older response"));
		await sessionManager.markHostTurnDispatched({
			clientTurnId: first.clientTurnId,
			payloadFingerprint: first.payloadFingerprint,
			nativeIdentity: { sessionId: sessionManager.getSessionId(), entryId: olderEntryId },
		});
		await sessionManager.settleHostTurnOperation({
			clientTurnId: first.clientTurnId,
			payloadFingerprint: first.payloadFingerprint,
			outcome: "completed",
		});

		await session.followUp("Keep newer prepared", undefined, {
			clientTurnId: "turn-newer-prepared",
			optionFingerprint: "newer-options",
		});
		expect(session.getQueuedMessages().followUp).toEqual(["Keep newer prepared"]);
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-older", status: "settled" },
			{ clientTurnId: "turn-newer-prepared", status: "prepared" },
		]);

		await expect(session.rollbackHostTurns({ count: 1, expectedClientTurnIds: ["turn-older"] })).rejects.toThrow(
			"expectedClientTurnIds does not match the current host-turn suffix",
		);
		expect(session.getQueuedMessages().followUp).toEqual(["Keep newer prepared"]);
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-older", status: "settled" },
			{ clientTurnId: "turn-newer-prepared", status: "prepared" },
		]);

		await session.dispose();
	});

	it("emits host_turn_cancelled when unpromoted follow-up is popped or cleared", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const cancelled = Promise.withResolvers<Extract<AgentSessionEvent, { type: "host_turn_cancelled" }>>();
		session.subscribe(event => {
			if (event.type === "host_turn_cancelled") cancelled.resolve(event);
		});

		await session.followUp("Follow up to cancel", undefined, {
			clientTurnId: "turn-f2",
			optionFingerprint: "fingerprint-456",
		});

		session.popLastQueuedMessage();
		const cancelledEvent = await cancelled.promise;
		expect(cancelledEvent).toEqual({
			type: "host_turn_cancelled",
			clientTurnId: "turn-f2",
			outcome: "cancelled",
			reason: "popped",
		});

		await session.dispose();
	});

	it("redispatches a still-prepared durable follow-up on the same clientTurnId", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		// Simulate prepare succeeding then failing before native dispatch.
		await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-prepared-retry",
			kind: "follow_up",
			payload: {
				text: "Retry prepared turn",
				synthetic: false,
				attribution: undefined,
				images: undefined,
			},
		});
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-prepared-retry", status: "prepared" },
		]);

		await session.followUp("Retry prepared turn", undefined, { clientTurnId: "turn-prepared-retry" });
		expect(agent.peekFollowUpQueue()).toHaveLength(1);

		// Still prepared + already queued: stay idempotent.
		await session.followUp("Retry prepared turn", undefined, { clientTurnId: "turn-prepared-retry" });
		expect(agent.peekFollowUpQueue()).toHaveLength(1);

		// Dispatched/settled retries must short-circuit without re-enqueue.
		const prepared = sessionManager.getHostTurnOperations()[0]!;
		await sessionManager.markHostTurnDispatched({
			clientTurnId: prepared.clientTurnId,
			payloadFingerprint: prepared.payloadFingerprint,
			nativeIdentity: { sessionId: session.sessionId, entryId: prepared.preparedEntryId },
		});
		await sessionManager.settleHostTurnOperation({
			clientTurnId: prepared.clientTurnId,
			payloadFingerprint: prepared.payloadFingerprint,
			outcome: "failed",
		});
		const queueBeforeSettledRetry = agent.peekFollowUpQueue().length;
		await session.followUp("Retry prepared turn", undefined, { clientTurnId: "turn-prepared-retry" });
		expect(agent.peekFollowUpQueue()).toHaveLength(queueBeforeSettledRetry);

		await session.dispose();
	});

	it("prepares durable follow-up images against the requested turn model", async () => {
		const visionModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const textOnlyModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct")!;
		expect(visionModel.input).toContain("image");
		expect(textOnlyModel.input).not.toContain("image");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: visionModel, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("aimlapi", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"images.describeForTextModels": true,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			).toString("base64"),
		};

		// Active model is vision-capable, so image prep against it would skip description.
		// The durable turn model is text-only, so description must still be queued.
		await session.followUp("Describe this for the text-only turn model", [image], {
			clientTurnId: "turn-image-model",
			optionFingerprint: "image-model",
			turnOptions: { provider: textOnlyModel.provider, modelId: textOnlyModel.id },
		});

		expect(
			agent.peekFollowUpQueue().map(message => (message.role === "custom" ? message.customType : message.role)),
		).toEqual(["image-attachment-description", "user"]);
		// Model application still waits until dequeue/promotion, not queue-time image prep.
		expect(session.model?.id).toBe(visionModel.id);

		await session.dispose();
	});

	it("restores model, thinking, and service-tier from the branch after host-turn rollback", async () => {
		const baseModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const laterModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: baseModel, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await session.setModel(baseModel);
		session.setThinkingLevel(Effort.Low);
		session.setServiceTierFamily("anthropic", "priority");

		const turn1 = await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-base",
			kind: "prompt",
			payload: { message: "base" },
		});
		const user1 = sessionManager.appendMessage(userMsg("base"));
		sessionManager.appendMessage(assistantMsg("base response"));
		await sessionManager.markHostTurnDispatched({
			clientTurnId: "turn-base",
			payloadFingerprint: turn1.payloadFingerprint,
			nativeIdentity: { sessionId: session.sessionId, entryId: user1 },
		});
		await sessionManager.settleHostTurnOperation({
			clientTurnId: "turn-base",
			payloadFingerprint: turn1.payloadFingerprint,
			outcome: "completed",
		});

		const turn2 = await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-later",
			kind: "prompt",
			payload: { message: "later" },
		});
		// Simulate host-turn option application after prepare: these entries sit in the
		// rolled-back suffix and must not remain live after rollback.
		await session.setModel(laterModel);
		session.setThinkingLevel(Effort.High);
		session.setServiceTierFamily("anthropic", undefined);
		const user2 = sessionManager.appendMessage(userMsg("later"));
		sessionManager.appendMessage(assistantMsg("later response"));
		await sessionManager.markHostTurnDispatched({
			clientTurnId: "turn-later",
			payloadFingerprint: turn2.payloadFingerprint,
			nativeIdentity: { sessionId: session.sessionId, entryId: user2 },
		});
		await sessionManager.settleHostTurnOperation({
			clientTurnId: "turn-later",
			payloadFingerprint: turn2.payloadFingerprint,
			outcome: "completed",
		});

		expect(session.model?.id).toBe(laterModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.serviceTierByFamily.anthropic).toBeUndefined();

		await session.rollbackHostTurns({
			count: 1,
			expectedClientTurnIds: ["turn-later"],
		});

		expect(session.model?.id).toBe(baseModel.id);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.serviceTierByFamily.anthropic).toBe("priority");
		expect((await session.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-base"]);

		await session.dispose();
	});

	it("removes rolled-back prepared turns from the agent follow-up queue", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		const first = await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-settled",
			kind: "prompt",
			payload: { message: "settled" },
		});
		const settledEntryId = sessionManager.appendMessage(userMsg("settled"));
		sessionManager.appendMessage(assistantMsg("settled response"));
		await sessionManager.markHostTurnDispatched({
			clientTurnId: first.clientTurnId,
			payloadFingerprint: first.payloadFingerprint,
			nativeIdentity: { sessionId: sessionManager.getSessionId(), entryId: settledEntryId },
		});
		await sessionManager.settleHostTurnOperation({
			clientTurnId: first.clientTurnId,
			payloadFingerprint: first.payloadFingerprint,
			outcome: "completed",
		});

		await session.followUp("Queued durable follow-up", undefined, {
			clientTurnId: "turn-queued",
			optionFingerprint: "queued-options",
		});
		expect(session.getQueuedMessages().followUp).toEqual(["Queued durable follow-up"]);
		expect(agent.peekFollowUpQueue().length).toBeGreaterThan(0);
		const hostTurns = await session.getHostTurns();
		expect(hostTurns.map(turn => turn.clientTurnId)).toEqual(["turn-settled", "turn-queued"]);

		const cancelled = Promise.withResolvers<Extract<AgentSessionEvent, { type: "host_turn_cancelled" }>>();
		session.subscribe(event => {
			if (event.type === "host_turn_cancelled" && event.clientTurnId === "turn-queued") {
				cancelled.resolve(event);
			}
		});

		await session.rollbackHostTurns({
			count: 1,
			expectedClientTurnIds: hostTurns.slice(-1).map(turn => turn.clientTurnId),
		});

		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(agent.peekFollowUpQueue()).toEqual([]);
		expect(await cancelled.promise).toMatchObject({
			type: "host_turn_cancelled",
			clientTurnId: "turn-queued",
			outcome: "cancelled",
			reason: "rollback",
		});
		expect((await session.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-settled"]);

		await session.dispose();
	});

	it("cancelQueuedHostTurn removes one prepared follow-up and emits cancellation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const cancelled = Promise.withResolvers<Extract<AgentSessionEvent, { type: "host_turn_cancelled" }>>();
		session.subscribe(event => {
			if (event.type === "host_turn_cancelled") cancelled.resolve(event);
		});

		await session.followUp("Cancel me", undefined, {
			clientTurnId: "turn-cancel",
			optionFingerprint: "cancel-options",
		});
		await session.followUp("Keep me", undefined, {
			clientTurnId: "turn-keep",
			optionFingerprint: "keep-options",
		});

		expect(await session.cancelQueuedHostTurn("turn-cancel")).toBe(true);
		expect(session.getQueuedMessages().followUp).toEqual(["Keep me"]);
		expect(await cancelled.promise).toEqual({
			type: "host_turn_cancelled",
			clientTurnId: "turn-cancel",
			outcome: "cancelled",
			reason: "cancelled",
		});
		expect(await session.cancelQueuedHostTurn("turn-cancel")).toBe(false);
		expect(await session.cancelQueuedHostTurn("missing")).toBe(false);

		await session.dispose();
	});

	it("does not cancel a prepared non-queued durable prompt via cancelQueuedHostTurn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		// Direct prompt path: prepared durable op never enters the follow-up queue.
		await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-direct-prompt",
			kind: "prompt",
			payload: {
				text: "Direct durable prompt",
				synthetic: false,
				attribution: undefined,
				images: undefined,
			},
		});
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-direct-prompt", status: "prepared" },
		]);
		expect(session.getQueuedMessages().followUp).toEqual([]);

		expect(await session.cancelQueuedHostTurn("turn-direct-prompt")).toBe(false);
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-direct-prompt", status: "prepared" },
		]);

		// Queued follow-up still cancels.
		await session.followUp("Queued", undefined, { clientTurnId: "turn-queued" });
		expect(await session.cancelQueuedHostTurn("turn-queued")).toBe(true);
		expect(session.getQueuedMessages().followUp).toEqual([]);

		await session.dispose();
	});

	it("short-circuits concurrent identical retries while a prepared prompt is in flight", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("done");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		// Kick the identical retry from onHostTurnPrepared so it races the prepared→dispatch
		// window before the first pipeline calls beginInFlight / becomes busy.
		let second: Promise<boolean> | undefined;
		const secondReady = Promise.withResolvers<void>();
		const first = session.prompt("In-flight prepared", {
			clientTurnId: "turn-inflight",
			onHostTurnPrepared: () => {
				second = session.prompt("In-flight prepared", { clientTurnId: "turn-inflight" });
				secondReady.resolve();
			},
		});
		await secondReady.promise;
		const [firstResult, secondResult] = await Promise.all([first, second!]);
		expect(firstResult).toBe(true);
		expect(secondResult).toBe(true);
		expect(streamCalls).toBe(1);
		expect(session.sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-inflight", status: "settled" },
		]);

		await session.dispose();
	});

	it("restores runtime when dequeue turnOptions apply but the turn never promotes", async () => {
		const initialModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		const targetModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishFirstTurn = Promise.withResolvers<void>();
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const callIndex = callCount++;
				queueMicrotask(() => {
					const message = createAssistantMessage(`response ${callIndex + 1}`);
					stream.push({ type: "start", partial: message });
					if (callIndex === 0) {
						streamStarted.resolve();
						void finishFirstTurn.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
					} else {
						// Follow-up must not reach the provider if hooks abort after options apply.
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.setThinkingLevel(Effort.Low);

		// After session registers its dequeue hooks, add a trailing hook that aborts
		// once turn options have been applied — simulating abort/preflight failure.
		agent.addBeforeQueuedMessageDequeueHook(() => {
			if (session.model?.id === targetModel.id) {
				throw new DOMException("Simulated abort after turnOptions apply", "AbortError");
			}
		});

		const promptPromise = session.prompt("First run");
		await streamStarted.promise;
		await session.followUp("Options then abort", undefined, {
			clientTurnId: "turn-options-abort",
			optionFingerprint: "options-abort-fp",
			turnOptions: {
				provider: targetModel.provider,
				modelId: targetModel.id,
				thinkingLevel: Effort.High,
			},
		});
		finishFirstTurn.resolve();
		await promptPromise;
		await session.waitForIdle();

		// Options applied during dequeue then rolled back when continue failed before promote.
		expect(session.model?.id).toBe(initialModel.id);
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		// Follow-up remains prepared/queued (not promoted) after the failed drain.
		expect(session.sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-options-abort", status: "prepared" },
		]);

		await session.dispose();
		authStorage.close();
	});

	it("rejects durable extension commands before invoking local handlers", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		let handlerCalls = 0;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			extensionRunner: {
				getCommand: (name: string) =>
					name === "local-mutator"
						? {
								name: "local-mutator",
								handler: async () => {
									handlerCalls++;
								},
							}
						: undefined,
			} as never,
		});

		await expect(
			session.prompt("/local-mutator do thing", {
				clientTurnId: "turn-extension",
			}),
		).rejects.toThrow("/local-mutator extension command cannot be retried safely with clientTurnId");
		expect(handlerCalls).toBe(0);
		expect(session.sessionManager.getHostTurnOperations()).toEqual([]);

		await session.dispose();
	});

	it("excludes rpcBuiltin and rpcSkill prepared turns from generic recovery", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let promptCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				promptCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("should not run");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-builtin",
			kind: "prompt",
			payload: {
				text: "/fast on",
				synthetic: false,
				attribution: "user",
				rpcBuiltin: { name: "fast" },
			},
		});
		await sessionManager.prepareHostTurnOperation({
			clientTurnId: "turn-skill",
			kind: "prompt",
			payload: {
				text: "skill body",
				synthetic: false,
				attribution: "user",
				rpcSkill: {
					customType: "skill-prompt",
					content: "skill body",
					display: true,
					attribution: "user",
					details: { name: "reviewer" },
					streamingBehavior: "steer",
				},
			},
		});

		expect(await session.recoverPreparedHostTurns()).toEqual([]);
		expect(promptCalls).toBe(0);
		expect(sessionManager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-builtin", status: "prepared" },
			{ clientTurnId: "turn-skill", status: "prepared" },
		]);

		await session.dispose();
	});
});
