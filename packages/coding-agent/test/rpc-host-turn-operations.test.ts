import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("RPC host-turn operation journal", () => {
	it("persists prepared, dispatched, and settled transitions idempotently", async () => {
		const manager = SessionManager.inMemory();
		const prepared = await manager.prepareHostTurnOperation({
			clientTurnId: "turn-1",
			kind: "prompt",
			payload: { message: "hello" },
		});
		const duplicate = await manager.prepareHostTurnOperation({
			clientTurnId: "turn-1",
			kind: "prompt",
			payload: { message: "hello" },
		});

		expect(duplicate).toEqual(prepared);
		expect(manager.getHostTurnOperations()).toHaveLength(1);

		const dispatched = await manager.markHostTurnDispatched({
			clientTurnId: "turn-1",
			payloadFingerprint: prepared.payloadFingerprint,
			nativeIdentity: { sessionId: manager.getSessionId(), entryId: "message-1" },
		});
		expect(dispatched.status).toBe("dispatched");

		const settled = await manager.settleHostTurnOperation({
			clientTurnId: "turn-1",
			payloadFingerprint: prepared.payloadFingerprint,
			outcome: "completed",
		});
		expect(settled.status).toBe("settled");
		expect(manager.getHostTurnOperations()).toEqual([settled]);
	});

	it("reports whether an idempotent preparation created durable work", async () => {
		const manager = SessionManager.inMemory();
		const first = await manager.prepareHostTurnOperationWithStatus({
			clientTurnId: "turn-disposition",
			kind: "follow_up",
			payload: { message: "once" },
		});
		const retry = await manager.prepareHostTurnOperationWithStatus({
			clientTurnId: "turn-disposition",
			kind: "follow_up",
			payload: { message: "once" },
		});

		expect(first.created).toBe(true);
		expect(retry).toEqual({ operation: first.operation, created: false });
		expect(manager.getHostTurnOperations()).toEqual([first.operation]);
	});

	it("persists queued follow-up option identity and supports cancellation before dispatch", async () => {
		const manager = SessionManager.inMemory();
		const prepared = await manager.prepareHostTurnOperation({
			clientTurnId: "turn-follow-up",
			kind: "follow_up",
			payload: { message: "next" },
			optionFingerprint: "options-v1",
			turnOptions: {
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				thinkingLevel: "high",
				fastMode: true,
			},
		});

		expect(prepared).toMatchObject({
			status: "prepared",
			optionFingerprint: "options-v1",
			turnOptions: {
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				thinkingLevel: "high",
				fastMode: true,
			},
		});

		const cancelled = await manager.cancelPreparedHostTurnOperation({
			clientTurnId: "turn-follow-up",
			payloadFingerprint: prepared.payloadFingerprint,
			outcome: "cancelled",
		});
		expect(cancelled).toMatchObject({ status: "settled", outcome: "cancelled" });
		expect(await manager.getHostTurns()).toEqual([]);
	});

	it("rejects reuse of a client turn id with different content", async () => {
		const manager = SessionManager.inMemory();
		await manager.prepareHostTurnOperation({
			clientTurnId: "turn-1",
			kind: "prompt",
			payload: { message: "hello" },
		});

		await expect(
			manager.prepareHostTurnOperation({
				clientTurnId: "turn-1",
				kind: "prompt",
				payload: { message: "different" },
			}),
		).rejects.toThrow("clientTurnId already exists with different content");
		expect(manager.getHostTurnOperations()).toHaveLength(1);
	});

	it("rejects reuse of a client turn id with different canonical turn options", async () => {
		const manager = SessionManager.inMemory();
		await manager.prepareHostTurnOperation({
			clientTurnId: "turn-options",
			kind: "follow_up",
			payload: { message: "same" },
			optionFingerprint: "host-supplied-fingerprint",
			turnOptions: { provider: "anthropic", modelId: "claude", fastMode: true },
		});

		await expect(
			manager.prepareHostTurnOperation({
				clientTurnId: "turn-options",
				kind: "follow_up",
				payload: { message: "same" },
				optionFingerprint: "host-supplied-fingerprint",
				turnOptions: { provider: "anthropic", modelId: "claude", fastMode: false },
			}),
		).rejects.toThrow("clientTurnId already exists with different content");
		expect(manager.getHostTurnOperations()).toHaveLength(1);
	});
});
