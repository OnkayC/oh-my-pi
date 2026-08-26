import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	acceptDurableRpcPrompt,
	type RpcDurableSkillCommandSession,
	recoverPreparedSpecialHostTurns,
	tryRunRpcSkillCommand,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("tryRunRpcSkillCommand", () => {
	test("dispatches registered /skill commands as skill prompt messages", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let message: Pick<CustomMessage, "attribution" | "content" | "customType" | "details" | "display"> | undefined;
		let options: { streamingBehavior?: "steer" | "followUp" } | undefined;

		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage(nextMessage: typeof message, nextOptions?: typeof options) {
					message = nextMessage;
					options = nextOptions;
				},
			},
			"/skill:reviewer focus on risks",
		);

		expect(handled).toEqual({ agentInvoked: true });
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.content).toContain("Review the supplied code carefully.");
		expect(message?.content).toContain(`[Skill directory: ${dir}]`);
		expect(message?.content).toContain("focus on risks");
		expect(message?.display).toBe(true);
		expect(message?.attribution).toBe("user");
		expect(options).toEqual({ streamingBehavior: "steer" });

		await removeWithRetries(dir);
	});

	test("honors the RPC prompt streaming behavior for registered /skill commands", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let options: { streamingBehavior?: "steer" | "followUp" } | undefined;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage(nextMessage, nextOptions) {
						expect(nextMessage.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
						options = nextOptions;
					},
				},
				"/skill:reviewer wait for the current turn",
				"followUp",
			);

			expect(handled).toEqual({ agentInvoked: true });
			expect(options?.streamingBehavior).toBe("followUp");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("journals durable skill prompts and does not execute a lost-response retry twice", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-durable-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		const manager = SessionManager.inMemory();
		const turn = Promise.withResolvers<void>();
		const invoked = Promise.withResolvers<void>();
		const listeners = new Set<Parameters<RpcDurableSkillCommandSession["subscribe"]>[0]>();
		let invocationCount = 0;
		let lastAssistant: AssistantMessage | undefined;
		const session = {
			skillsSettings: { enableSkillCommands: true },
			skills: [
				{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
			],
			isStreaming: false,
			sessionManager: manager,
			sessionId: manager.getSessionId(),
			sessionFile: undefined,
			subscribe(listener: Parameters<RpcDurableSkillCommandSession["subscribe"]>[0]) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getLastAssistantMessage() {
				return lastAssistant;
			},
			async promptCustomMessage(message: Parameters<RpcDurableSkillCommandSession["promptCustomMessage"]>[0]) {
				invocationCount += 1;
				manager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
					message.attribution,
				);
				invoked.resolve();
				await turn.promise;
				lastAssistant = {
					role: "assistant",
					content: [{ type: "text", text: "Reviewed." }],
					stopReason: "stop",
					timestamp: Date.now(),
				} as AssistantMessage;
				for (const listener of listeners) listener({ type: "agent_end", messages: [lastAssistant] } as never);
			},
		} as unknown as RpcDurableSkillCommandSession;

		let firstRun: Promise<boolean> | undefined;
		try {
			await acceptDurableRpcPrompt({
				startPrompt: onHostTurnPrepared => {
					firstRun = tryRunRpcSkillCommand(session, "/skill:reviewer focus on risks", "steer", {
						clientTurnId: "skill-turn-1",
						onHostTurnPrepared,
					}).then(result => result !== false);
					return firstRun;
				},
				onLocalResult: () => {},
				onAsyncError: error => {
					throw error;
				},
			});
			await invoked.promise;
			expect(invocationCount).toBe(1);

			await fs.unlink(skillPath);
			let retryRun: Promise<boolean> | undefined;
			await acceptDurableRpcPrompt({
				startPrompt: onHostTurnPrepared => {
					retryRun = tryRunRpcSkillCommand(session, "/skill:reviewer focus on risks", "steer", {
						clientTurnId: "skill-turn-1",
						onHostTurnPrepared,
					}).then(result => result !== false);
					return retryRun;
				},
				onLocalResult: () => {},
				onAsyncError: error => {
					throw error;
				},
			});
			await retryRun;
			expect(invocationCount).toBe(1);

			turn.resolve();
			await firstRun;
			const turns = await manager.getHostTurns();
			expect(turns).toHaveLength(1);
			expect(turns[0]).toMatchObject({
				clientTurnId: "skill-turn-1",
				kind: "prompt",
				status: "settled",
				outcome: "completed",
			});
			const skillEntry = manager
				.getBranch()
				.find(entry => entry.type === "custom_message" && entry.customType === SKILL_PROMPT_MESSAGE_TYPE);
			expect(turns[0]?.nativeIdentity?.entryId).toBe(skillEntry?.id);
		} finally {
			turn.resolve();
			await firstRun?.catch(() => undefined);
			await removeWithRetries(dir);
		}
	});

	test("redispatches a still-prepared durable skill retry instead of short-circuiting", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-durable-skill-retry-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		const manager = SessionManager.inMemory();
		const listeners = new Set<Parameters<RpcDurableSkillCommandSession["subscribe"]>[0]>();
		let invocationCount = 0;
		let failNextPrompt = true;
		let lastAssistant: AssistantMessage | undefined;
		const session = {
			skillsSettings: { enableSkillCommands: true },
			skills: [
				{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
			],
			isStreaming: false,
			sessionManager: manager,
			sessionId: manager.getSessionId(),
			sessionFile: undefined,
			subscribe(listener: Parameters<RpcDurableSkillCommandSession["subscribe"]>[0]) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getLastAssistantMessage() {
				return lastAssistant;
			},
			async promptCustomMessage(message: Parameters<RpcDurableSkillCommandSession["promptCustomMessage"]>[0]) {
				invocationCount += 1;
				if (failNextPrompt) {
					failNextPrompt = false;
					throw new Error("model preflight failed");
				}
				manager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
					message.attribution,
				);
				lastAssistant = {
					role: "assistant",
					content: [{ type: "text", text: "Reviewed." }],
					stopReason: "stop",
					timestamp: Date.now(),
				} as AssistantMessage;
				for (const listener of listeners) listener({ type: "agent_end", messages: [lastAssistant] } as never);
			},
		} as unknown as RpcDurableSkillCommandSession;

		try {
			await expect(
				tryRunRpcSkillCommand(session, "/skill:reviewer focus on risks", "steer", {
					clientTurnId: "skill-turn-prepared-retry",
					onHostTurnPrepared: () => {},
				}),
			).rejects.toThrow("model preflight failed");
			expect(invocationCount).toBe(1);
			expect(manager.getHostTurnOperations()).toMatchObject([
				{ clientTurnId: "skill-turn-prepared-retry", status: "prepared" },
			]);

			// Skill file can disappear between prepare and retry; redispatch uses the journaled payload.
			await fs.unlink(skillPath);
			const retry = await tryRunRpcSkillCommand(session, "/skill:reviewer focus on risks", "steer", {
				clientTurnId: "skill-turn-prepared-retry",
				onHostTurnPrepared: () => {},
			});
			expect(retry).toEqual({ agentInvoked: true });
			expect(invocationCount).toBe(2);
			expect(manager.getHostTurnOperations()).toMatchObject([
				{ clientTurnId: "skill-turn-prepared-retry", status: "settled", outcome: "completed" },
			]);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("ignores unknown skill commands so normal prompt handling can continue", async () => {
		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					throw new Error("should not dispatch unknown skills");
				},
			},
			"/skill:missing",
		);

		expect(handled).toBe(false);
	});

	test("does not steal builtin slash-command arguments that mention registered skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let dispatched = false;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage() {
						dispatched = true;
					},
				},
				"/compact /skill:reviewer",
			);

			expect(handled).toBe(false);
			expect(dispatched).toBe(false);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("recovers prepared skill host turns through the special durable dispatcher", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-recover-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		const manager = SessionManager.inMemory();
		const prepared = await manager.prepareHostTurnOperation({
			clientTurnId: "skill-recover-1",
			kind: "prompt",
			payload: {
				text: "Review the supplied code carefully.\n\n[Skill directory: x]\n\nfocus",
				synthetic: false,
				attribution: "user",
				rpcSkill: {
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: "Review the supplied code carefully.\n\n[Skill directory: x]\n\nfocus",
					display: true,
					attribution: "user",
					details: {
						name: "reviewer",
						description: "Review code",
						filePath: skillPath,
						baseDir: dir,
						source: "project",
						args: "focus",
					},
					streamingBehavior: "steer",
				},
			},
		});

		let promptCalls = 0;
		const lastAssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		} as AssistantMessage;
		const session = {
			skillsSettings: { enableSkillCommands: true },
			skills: [
				{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
			],
			sessionManager: manager,
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			isStreaming: false,
			getLastAssistantMessage: () => lastAssistantMessage,
			async resumePersistedTurn() {
				manager.appendMessage(lastAssistantMessage);
			},
			subscribe: () => () => {},
			async promptCustomMessage(
				message: Pick<CustomMessage, "content" | "customType" | "details" | "display" | "attribution">,
			) {
				promptCalls++;
				manager.appendCustomMessageEntry(
					message.customType,
					typeof message.content === "string" ? message.content : "",
					message.display,
					message.details,
					message.attribution,
				);
			},
		} as unknown as Parameters<typeof recoverPreparedSpecialHostTurns>[0];

		try {
			const recovered = await recoverPreparedSpecialHostTurns(session, {
				session: session as never,
				sessionManager: manager,
				settings: {} as never,
				cwd: dir,
				output: () => {},
			} as never);
			expect(recovered).toEqual(["skill-recover-1"]);
			expect(promptCalls).toBe(1);
			expect(manager.getHostTurnOperations()).toMatchObject([
				{
					clientTurnId: "skill-recover-1",
					status: "settled",
					outcome: "completed",
					payloadFingerprint: prepared.payloadFingerprint,
				},
			]);

			const persistedPrepared = await manager.prepareHostTurnOperation({
				clientTurnId: "skill-recover-persisted",
				kind: "prompt",
				payload: prepared.payload,
			});
			const persistedEntryId = manager.appendCustomMessageEntry(
				SKILL_PROMPT_MESSAGE_TYPE,
				"Review the supplied code carefully.\n\n[Skill directory: x]\n\nfocus",
				true,
				undefined,
				"user",
			);
			expect(
				await recoverPreparedSpecialHostTurns(session, {
					session: session as never,
					sessionManager: manager,
					settings: {} as never,
					cwd: dir,
					output: () => {},
				} as never),
			).toEqual(["skill-recover-persisted"]);
			expect(promptCalls).toBe(1);
			expect(manager.getHostTurnOperations()).toContainEqual(
				expect.objectContaining({
					clientTurnId: "skill-recover-persisted",
					status: "settled",
					outcome: "completed",
					payloadFingerprint: persistedPrepared.payloadFingerprint,
					nativeIdentity: expect.objectContaining({ entryId: persistedEntryId }),
				}),
			);
		} finally {
			await removeWithRetries(dir);
		}
	});
});
