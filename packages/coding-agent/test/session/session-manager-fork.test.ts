import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

async function createSessionWithArtifacts(root: string): Promise<{
	cwd: string;
	sessionDir: string;
	sourceFile: string;
	sourceArtifactsDir: string;
}> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	const sourceFile = path.join(sessionDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "source-with-artifacts",
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.join(sourceArtifactsDir, "nested"), { recursive: true });
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	await Bun.write(path.join(sourceArtifactsDir, "1.read.log"), "tool output");
	await Bun.write(path.join(sourceArtifactsDir, "nested", "result.txt"), "nested output");
	return { cwd, sessionDir, sourceFile, sourceArtifactsDir };
}

async function appendHostTurn(manager: SessionManager, clientTurnId: string, message: string): Promise<string> {
	const prepared = await manager.prepareHostTurnOperation({ clientTurnId, kind: "prompt", payload: { message } });
	const userEntryId = manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
	await manager.markHostTurnDispatched({
		clientTurnId,
		payloadFingerprint: prepared.payloadFingerprint,
		nativeIdentity: { sessionId: manager.getSessionId(), entryId: userEntryId },
	});
	const settled = await manager.settleHostTurnOperation({
		clientTurnId,
		payloadFingerprint: prepared.payloadFingerprint,
		outcome: "completed",
	});
	return settled.journalEntryId;
}

describe("SessionManager forks", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");

			const prepared = await forked.prepareHostTurnOperation({
				clientTurnId: "fork-turn",
				kind: "prompt",
				payload: { message: "fork-local" },
			});
			const forkMessageId = forked.appendMessage({
				role: "user",
				content: "fork-local",
				timestamp: Date.now(),
			});
			await forked.markHostTurnDispatched({
				clientTurnId: prepared.clientTurnId,
				payloadFingerprint: prepared.payloadFingerprint,
				nativeIdentity: { sessionId: forked.getSessionId(), entryId: forkMessageId },
			});
			expect((await forked.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["fork-turn"]);
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("copies source artifacts recursively into the fork by default", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-artifacts-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifactsDir, "nested", "result.txt")).text()).toBe("nested output");
		expect(await Bun.file(path.join(sourceArtifactsDir, "1.read.log")).text()).toBe("tool output");
	});

	it("does not copy artifacts when the caller opts out", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-no-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).exists()).toBe(false);
	});

	it("does not treat an extensionless source's parent directory as artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-extensionless-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const forkDir = path.join(tempDir.path(), "forks");
		const sourceFile = path.join(sessionDir, "source");
		const unrelatedFile = path.join(sessionDir, "unrelated.txt");
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "extensionless-source",
			timestamp: new Date().toISOString(),
			cwd,
		};
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
		await Bun.write(unrelatedFile, "must not be copied");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, forkDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "unrelated.txt")).exists()).toBe(false);
		expect(await Bun.file(unrelatedFile).text()).toBe("must not be copied");
	});

	it("keeps copied branch host-turn history self-contained during rollback", async () => {
		using tempDir = TempDir.createSync("@omp-session-branch-turns-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const branchPointId = await appendHostTurn(manager, "turn-1", "kept source turn");
		await appendHostTurn(manager, "turn-2", "abandoned source turn");
		await manager.flush();

		const sourceFile = manager.getSessionFile();
		if (!sourceFile) throw new Error("expected source session file");
		const sourceBytes = await Bun.file(sourceFile).bytes();
		const sourceEntries = await loadEntriesFromFile(sourceFile);

		const branchFile = manager.createBranchedSession(branchPointId);
		if (!branchFile) throw new Error("expected copied branch session file");
		await appendHostTurn(manager, "turn-branch", "branch-only turn");

		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-1", "turn-branch"]);
		const rollback = await manager.rollbackHostTurns({
			count: 1,
			expectedClientTurnIds: ["turn-branch"],
		});
		expect(rollback.sessionFile).toBe(branchFile);
		expect(rollback.removedClientTurnIds).toEqual(["turn-branch"]);
		expect(rollback.remainingTurns.map(turn => turn.clientTurnId)).toEqual(["turn-1"]);
		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual(["turn-1"]);

		expect(await Bun.file(sourceFile).bytes()).toEqual(sourceBytes);
		expect(await loadEntriesFromFile(sourceFile)).toEqual(sourceEntries);
	});

	it("inherits host turns only from the persisted parent active branch", async () => {
		using tempDir = TempDir.createSync("@omp-session-parent-branch-turns-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const branchPointId = await appendHostTurn(manager, "turn-root", "shared root turn");
		await appendHostTurn(manager, "turn-abandoned", "abandoned parent turn");
		manager.branch(branchPointId);
		await appendHostTurn(manager, "turn-active", "active parent turn");
		await manager.flush();

		const parentFile = manager.getSessionFile();
		if (!parentFile) throw new Error("expected parent session file");
		await manager.newSession({ parentSession: parentFile });
		await appendHostTurn(manager, "turn-child", "child turn");

		expect((await manager.getHostTurns()).map(turn => turn.clientTurnId)).toEqual([
			"turn-root",
			"turn-active",
			"turn-child",
		]);
	});

	it("rejects rollback through an abandoned persisted parent branch", async () => {
		using tempDir = TempDir.createSync("@omp-session-parent-rollback-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const branchPointId = await appendHostTurn(manager, "turn-root", "shared root turn");
		await appendHostTurn(manager, "turn-abandoned", "abandoned parent turn");
		manager.branch(branchPointId);
		await appendHostTurn(manager, "turn-active", "active parent turn");
		await manager.flush();

		const parentFile = manager.getSessionFile();
		if (!parentFile) throw new Error("expected parent session file");
		const parentBytes = await Bun.file(parentFile).bytes();
		await manager.newSession({ parentSession: parentFile });
		await appendHostTurn(manager, "turn-child", "child turn");
		await manager.flush();
		const childFile = manager.getSessionFile();
		if (!childFile) throw new Error("expected child session file");
		const childBytes = await Bun.file(childFile).bytes();

		await expect(
			manager.rollbackHostTurns({
				count: 3,
				expectedClientTurnIds: ["turn-abandoned", "turn-active", "turn-child"],
			}),
		).rejects.toThrow("expectedClientTurnIds does not match the current host-turn suffix");
		expect(await Bun.file(parentFile).bytes()).toEqual(parentBytes);
		expect(await Bun.file(childFile).bytes()).toEqual(childBytes);

		const rollback = await manager.rollbackHostTurns({
			count: 1,
			expectedClientTurnIds: ["turn-child"],
		});
		expect(rollback.removedClientTurnIds).toEqual(["turn-child"]);
		expect(rollback.remainingTurns.map(turn => turn.clientTurnId)).toEqual(["turn-root", "turn-active"]);
		expect(await Bun.file(parentFile).bytes()).toEqual(parentBytes);
	});
});
