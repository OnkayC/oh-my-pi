import { describe, expect, test } from "bun:test";
import {
	acceptDurableRpcPrompt,
	RpcExtensionUserMessageTracker,
	reportLocalOnlyPromptResult,
	watchAndReportLocalOnlyPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ExtensionActions, ExtensionCommandContextActions } from "../src/extensibility/extensions/types";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { AgentSession } from "../src/session/agent-session";

async function waitForPromptHandlers(prompt: Promise<unknown>): Promise<void> {
	await prompt.catch(() => undefined);
	await Promise.resolve();
}

async function waitForTrackedPromptHandlers(trackedPrompt: {
	prompt: Promise<unknown>;
	waitForAgentMessageTasks: () => Promise<void>;
}): Promise<void> {
	await trackedPrompt.prompt.catch(() => undefined);
	await trackedPrompt.waitForAgentMessageTasks();
	await Promise.resolve();
	await Promise.resolve();
}

describe("durable RPC prompt acknowledgement", () => {
	test("rejects a conflicting reused clientTurnId instead of acknowledging then discarding the error", async () => {
		let localResult = false;
		const asyncErrors: Error[] = [];

		await expect(
			acceptDurableRpcPrompt({
				startPrompt: async () => {
					await Promise.resolve();
					throw new Error("clientTurnId already exists with different content");
				},
				onLocalResult: () => {
					localResult = true;
				},
				onAsyncError: error => {
					asyncErrors.push(error);
				},
			}),
		).rejects.toThrow("clientTurnId already exists with different content");

		expect(localResult).toBe(false);
		expect(asyncErrors).toEqual([]);
	});
});

describe("acceptDurableRpcPrompt", () => {
	test("acknowledges after durable preparation without waiting for the agent turn to finish", async () => {
		const turn = Promise.withResolvers<boolean>();
		let prepared: (() => void) | undefined;
		const accepted = acceptDurableRpcPrompt({
			startPrompt: onHostTurnPrepared => {
				prepared = onHostTurnPrepared;
				return turn.promise;
			},
			onLocalResult: () => {},
			onAsyncError: error => {
				throw error;
			},
		});

		let acknowledged = false;
		void accepted.then(() => {
			acknowledged = true;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);

		prepared?.();
		await accepted;
		expect(acknowledged).toBe(true);

		turn.resolve(true);
		await turn.promise;
	});

	test("rejects when a durable prompt completes without authoritative preparation", async () => {
		await expect(
			acceptDurableRpcPrompt({
				startPrompt: async () => true,
				onLocalResult: () => {},
				onAsyncError: () => {},
			}),
		).rejects.toThrow("Durable prompt completed before host-turn preparation");
	});
});

describe("reportLocalOnlyPromptResult", () => {
	test("emits prompt_result when prompt resolves without invoking the agent or extension user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("does not emit false prompt_result when an extension command schedules a user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
	});

	test("does not emit false prompt_result when an extension command schedules a triggerTurn custom message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
	});

	test("ignores extension user messages scheduled before the watched prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.markAgentMessageTask();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("marks triggerTurn extension custom messages as agent work", async () => {
		let extensionActions: ExtensionActions | undefined;
		let markCount = 0;
		let sentOptions: { triggerTurn?: boolean } | undefined;
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendCustomMessage: async (_message: unknown, options?: { triggerTurn?: boolean }) => {
				sentOptions = options;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			markAgentInvokingMessage: () => {
				markCount += 1;
			},
		});
		extensionActions?.sendMessage(
			{
				customType: "test",
				content: "context",
				display: true,
				details: "context",
				attribution: "user",
			},
			{ triggerTurn: true },
		);

		expect(markCount).toBe(1);
		expect(sentOptions).toEqual({ triggerTurn: true });
	});

	test("uses mode-owned session actions for extension session changes", async () => {
		let commandActions: ExtensionCommandContextActions | undefined;
		const calls: string[] = [];
		const session = {
			extensionRunner: {
				initialize: (_actions: unknown, _contextActions: unknown, actions: ExtensionCommandContextActions) => {
					commandActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			newSession: async () => {
				throw new Error("direct newSession should not run");
			},
			branch: async () => {
				throw new Error("direct branch should not run");
			},
			switchSession: async () => {
				throw new Error("direct switchSession should not run");
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			sessionActions: {
				newSession: async () => {
					calls.push("new");
					return { cancelled: false };
				},
				branch: async () => {
					calls.push("branch");
					return { cancelled: false };
				},
				switchSession: async () => {
					calls.push("switch");
					return { cancelled: false };
				},
			},
		});
		if (!commandActions) throw new Error("extensions not initialized");

		await commandActions.newSession();
		await commandActions.branch("entry-1");
		await commandActions.switchSession("session.jsonl");

		expect(calls).toEqual(["new", "branch", "switch"]);
	});

	test("suppresses prompt_result when extension sendUserMessage succeeds", async () => {
		let extensionActions: ExtensionActions | undefined;
		let sentContent: unknown;
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async (content: unknown) => {
				sentContent = content;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_success",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(sentContent).toBe("start work");
		expect(output).toEqual([]);
	});

	test("emits prompt_result when extension sendUserMessage rejects", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const reportedErrors: Error[] = [];
		const thrown = new Error("missing model");
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async () => {
				throw thrown;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				reportedErrors.push(error);
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_rejected",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(reportedErrors).toEqual([thrown]);
		expect(output).toEqual([{ type: "prompt_result", id: "req_rejected", agentInvoked: false }]);
	});

	test("does not emit when prompt invokes the agent", async () => {
		const output: object[] = [];
		const prompt = Promise.resolve(true);

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([]);
	});

	test("reports prompt rejection without emitting output", async () => {
		const output: object[] = [];
		const thrown = new Error("boom");
		const prompt = Promise.reject(thrown);
		let reported: Error | undefined;

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				reported = error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(reported).toBe(thrown);
		expect(output).toEqual([]);
	});
});

describe("watchAndReportLocalOnlyPromptResult", () => {
	test("reports builtin residual prompts that complete locally", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(false);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("does not report builtin residual prompts that invoke the agent", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(true);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([]);
	});
});
