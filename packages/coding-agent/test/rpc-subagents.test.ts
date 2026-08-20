import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	handleRpcRollbackTurns,
	handleRpcSessionChange,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { PlanModeController } from "@oh-my-pi/pi-coding-agent/plan-mode/controller";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession } from "./utilities";

const tempPaths: string[] = [];

afterEach(() => {
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; selectedImages: ImageContent[]; cancelled: boolean };
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	return {
		newSession: async (_options?: unknown) => options.newSession ?? true,
		switchSession: async (_sessionPath: string) => options.switchSession ?? true,
		branch: async (_entryId: string) =>
			options.branch ?? { selectedText: "branched text", selectedImages: [], cancelled: false },
	};
}

describe("RPC subagent registry", () => {
	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		registry.clear();

		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({
					branch: { selectedText: "Branch text", selectedImages: [], cancelled: false },
				}),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			const planTransitions: string[] = [];
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, () => registry.clear(), {
					prepareSessionTransition: () => {
						planTransitions.push("prepare");
						return Promise.resolve({ status: "off", reentry: false });
					},
					reconcileSessionTransition: () => {
						planTransitions.push("reconcile");
						return Promise.resolve({ status: "off", reentry: false });
					},
				});

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				expect(planTransitions).toEqual(["prepare", "reconcile"]);
				expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", selectedImages: [], cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			const planTransitions: string[] = [];
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, () => registry.clear(), {
					prepareSessionTransition: () => {
						planTransitions.push("prepare");
						return Promise.resolve({ status: "off", reentry: false });
					},
					reconcileSessionTransition: () => {
						planTransitions.push("reconcile");
						return Promise.resolve({ status: "off", reentry: false });
					},
				});

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(planTransitions).toEqual(["prepare", "reconcile"]);
				expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("clears subagent registry after cross-lineage rollback activates parent session", async () => {
		const registry = createRegistryWithSnapshot();
		const commits: string[] = [];
		try {
			const rollback = await handleRpcRollbackTurns(
				{
					sessionId: "child-session",
					sessionFile: "/tmp/child.jsonl",
					validateHostTurnRollback: async () => {},
					rollbackHostTurns: async () => ({
						removedClientTurnIds: ["turn-child"],
						remainingTurns: [],
						sessionId: "parent-session",
						sessionFile: "/tmp/parent.jsonl",
					}),
				},
				{ count: 1, expectedClientTurnIds: ["turn-child"] },
				() => {
					commits.push("committed");
					registry.clear();
				},
			);

			expect(rollback).toMatchObject({
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				removedClientTurnIds: ["turn-child"],
			});
			expect(commits).toEqual(["committed"]);
			expect(registry.getSubagents()).toHaveLength(0);

			// Same-session rollback must not clear child subagent state.
			const sameSessionRegistry = createRegistryWithSnapshot();
			try {
				const sameSessionCommits: string[] = [];
				await handleRpcRollbackTurns(
					{
						sessionId: "same-session",
						sessionFile: "/tmp/same.jsonl",
						validateHostTurnRollback: async () => {},
						rollbackHostTurns: async () => ({
							removedClientTurnIds: ["turn-1"],
							remainingTurns: [],
							sessionId: "same-session",
							sessionFile: "/tmp/same.jsonl",
						}),
					},
					{ count: 1, expectedClientTurnIds: ["turn-1"] },
					() => {
						sameSessionCommits.push("committed");
						sameSessionRegistry.clear();
					},
				);
				expect(sameSessionCommits).toEqual([]);
				expect(sameSessionRegistry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
			} finally {
				sameSessionRegistry.dispose();
			}
		} finally {
			registry.dispose();
		}
	});

	test("suspends plan runtime before cross-session rollback and reconciles after", async () => {
		const planTransitions: string[] = [];
		const events: string[] = [];
		const rollback = await handleRpcRollbackTurns(
			{
				sessionId: "child-session",
				sessionFile: "/tmp/child.jsonl",
				validateHostTurnRollback: async () => {
					events.push("validate");
				},
				rollbackHostTurns: async () => {
					events.push("rollback");
					return {
						removedClientTurnIds: ["turn-child"],
						remainingTurns: [],
						sessionId: "parent-session",
						sessionFile: "/tmp/parent.jsonl",
					};
				},
			},
			{ count: 1, expectedClientTurnIds: ["turn-child"] },
			() => {
				events.push("committed");
			},
			{
				prepareSessionTransition: () => {
					planTransitions.push("prepare");
					events.push("prepare");
					return Promise.resolve({ status: "off", reentry: false });
				},
				reconcileSessionTransition: () => {
					planTransitions.push("reconcile");
					events.push("reconcile");
					return Promise.resolve({ status: "off", reentry: false });
				},
			},
		);

		expect(rollback.sessionId).toBe("parent-session");
		expect(planTransitions).toEqual(["prepare", "reconcile"]);
		expect(events).toEqual(["validate", "prepare", "rollback", "committed", "reconcile"]);
	});

	test("does not suspend plan runtime when rollback validation fails", async () => {
		const planTransitions: string[] = [];
		await expect(
			handleRpcRollbackTurns(
				{
					sessionId: "busy-session",
					sessionFile: "/tmp/busy.jsonl",
					validateHostTurnRollback: async () => {
						throw new Error("Agent is busy");
					},
					rollbackHostTurns: async () => {
						throw new Error("rollback must not run after validation failure");
					},
				},
				{ count: 1, expectedClientTurnIds: ["turn-1"] },
				() => {
					throw new Error("commit must not run after validation failure");
				},
				{
					prepareSessionTransition: () => {
						planTransitions.push("prepare");
						return Promise.resolve({ status: "off", reentry: false });
					},
					reconcileSessionTransition: () => {
						planTransitions.push("reconcile");
						return Promise.resolve({ status: "off", reentry: false });
					},
				},
			),
		).rejects.toThrow("Agent is busy");
		expect(planTransitions).toEqual([]);
	});

	test("clears source-session subagents when fresh plan execution commits the child session", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/source-subagent.jsonl",
		} satisfies SubagentLifecyclePayload);
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const newSession = vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			expect(registry.getSubagents()).toHaveLength(1);
			return true;
		});
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: () => Promise.resolve(true),
			onSessionTransitionCommitted: () => registry.clear(),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await controller.respondToReview({
				requestId: request.id,
				decision: { action: "execute", context: "fresh", clientTurnId: "turn-fresh-subagents" },
			});

			expect(newSession).toHaveBeenCalledTimes(1);
			expect(registry.getSubagents()).toHaveLength(0);
			expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
				/Unknown subagent or session file unavailable/,
			);

			const frameCountAfterSwitch = frames.length;
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/source-subagent.jsonl",
				progress: createProgress(),
			} satisfies SubagentProgressPayload);
			eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				id: "SubagentA",
				event: { type: "agent_start" },
			} satisfies SubagentEventPayload);
			expect(registry.getSubagents()).toHaveLength(0);
			expect(frames).toHaveLength(frameCountAfterSwitch);
		} finally {
			registry.dispose();
			await ctx.cleanup();
		}
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(0);
		expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({ type: "follow_up_queued", clientTurnId: "turn-queued", optionFingerprint: "options-queued", queuePosition: 1 });
		write({ type: "host_turn_promoted", clientTurnId: "turn-promoted", optionFingerprint: "options-promoted", model: "anthropic/claude" });
		write({ type: "host_turn_cancelled", clientTurnId: "turn-cancelled", outcome: "cancelled", reason: "host request" });
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		const unknownNotificationTypes: string[] = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));
		client.onUnknownNotification(frame => unknownNotificationTypes.push(String(frame.type)));

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(await client.getSubagentMessages({ sessionFile: "/tmp/subagent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toEqual(
			expect.arrayContaining(["notice", "follow_up_queued", "host_turn_promoted", "host_turn_cancelled"]),
		);
		expect(unknownNotificationTypes).toEqual([]);
	});
});
