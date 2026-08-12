import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

async function appendTurn(manager: SessionManager, clientTurnId: string, message: string): Promise<void> {
	const prepared = await manager.prepareHostTurnOperation({ clientTurnId, kind: "prompt", payload: { message } });
	const userEntryId = manager.appendMessage(userMsg(message));
	manager.appendMessage(assistantMsg(`${message} response`));
	await manager.markHostTurnDispatched({
		clientTurnId,
		payloadFingerprint: prepared.payloadFingerprint,
		nativeIdentity: { sessionId: manager.getSessionId(), entryId: userEntryId },
	});
	await manager.settleHostTurnOperation({
		clientTurnId,
		payloadFingerprint: prepared.payloadFingerprint,
		outcome: "completed",
	});
}

describe("RPC durable host turns", () => {
	it("returns chronological boundaries and rolls back the exact suffix", async () => {
		const manager = SessionManager.inMemory();
		await appendTurn(manager, "turn-1", "one");
		await appendTurn(manager, "turn-2", "two");
		await appendTurn(manager, "turn-3", "three");

		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-1", "turn-2", "turn-3"]);

		const result = await manager.rollbackHostTurns({
			count: 2,
			expectedClientTurnIds: ["turn-2", "turn-3"],
		});
		expect(result.removedClientTurnIds).toEqual(["turn-2", "turn-3"]);
		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-1"]);
		expect(
			manager
				.getEntries()
				.some(
					entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "two",
				),
		).toBe(false);
	});

	it("fails atomically when the expected suffix diverges", async () => {
		const manager = SessionManager.inMemory();
		await appendTurn(manager, "turn-1", "one");
		await appendTurn(manager, "turn-2", "two");
		const before = manager.getEntries();

		await expect(manager.rollbackHostTurns({ count: 1, expectedClientTurnIds: ["wrong-turn"] })).rejects.toThrow(
			"expectedClientTurnIds does not match the current host-turn suffix",
		);
		expect(manager.getEntries()).toEqual(before);
	});

	it("rejects invalid counts without mutation", async () => {
		const manager = SessionManager.inMemory();
		await appendTurn(manager, "turn-1", "one");
		const before = manager.getEntries();

		await expect(manager.rollbackHostTurns({ count: 0, expectedClientTurnIds: [] })).rejects.toThrow(
			"count must be a positive integer",
		);
		expect(manager.getEntries()).toEqual(before);
	});

	it("includes prepared turns in suffix validation so newer durable work is not dropped", async () => {
		const manager = SessionManager.inMemory();
		await appendTurn(manager, "turn-1", "one");
		await appendTurn(manager, "turn-2", "two");
		const prepared = await manager.prepareHostTurnOperation({
			clientTurnId: "turn-prepared",
			kind: "follow_up",
			payload: { message: "queued" },
		});
		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual([
			"turn-1",
			"turn-2",
			"turn-prepared",
		]);

		const before = manager.getEntries();
		await expect(manager.rollbackHostTurns({ count: 1, expectedClientTurnIds: ["turn-2"] })).rejects.toThrow(
			"expectedClientTurnIds does not match the current host-turn suffix",
		);
		expect(manager.getEntries()).toEqual(before);
		expect(manager.getHostTurnOperations()).toMatchObject([
			{ clientTurnId: "turn-1", status: "settled" },
			{ clientTurnId: "turn-2", status: "settled" },
			{ clientTurnId: "turn-prepared", status: "prepared", operationId: prepared.operationId },
		]);

		const result = await manager.rollbackHostTurns({
			count: 2,
			expectedClientTurnIds: ["turn-2", "turn-prepared"],
		});
		expect(result.removedClientTurnIds).toEqual(["turn-2", "turn-prepared"]);
		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-1"]);
	});

	it("anchors parent lineage to the fork-boundary leaf captured at child creation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-host-lineage-${Snowflake.next()}-`));
		const storage = new FileSessionStorage();
		try {
			const parent = SessionManager.create(dir, dir, storage);
			await appendTurn(parent, "parent-turn-1", "parent-one");
			const parentLeafAtFork = parent.getLeafId();
			expect(parentLeafAtFork).toBeTruthy();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("expected parent session file");
			await parent.flush();

			const childFile = await parent.newSession({ parentSession: parentFile });
			expect(childFile).toBeTruthy();
			expect(parent.getHeader()?.parentLeafId ?? null).toBe(parentLeafAtFork ?? null);
			await appendTurn(parent, "child-turn-1", "child-one");
			const childSessionFile = parent.getSessionFile();
			if (!childSessionFile) throw new Error("expected child session file");
			await parent.flush();

			// Parent continues after the fork; those later turns must not enter the child's lineage.
			const parentAgain = await SessionManager.open(parentFile, dir, storage);
			await appendTurn(parentAgain, "parent-turn-2", "parent-two");
			await parentAgain.flush();

			const reopenedChild = await SessionManager.open(childSessionFile, dir, storage);
			expect((await reopenedChild.getHostTurns()).map(turn => turn.clientTurnId)).toEqual([
				"parent-turn-1",
				"child-turn-1",
			]);
		} finally {
			await removeWithRetries(dir);
		}
	});
});
