import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	createRpcPlanModeArtifacts,
	respondToRpcPlanReview,
	setRpcPlanModeAtBoundary,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { PLAN_REVIEW_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/plan-mode/controller";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("native RPC plan mode", () => {
	it("supports active, pause, resume, and off in the same session", async () => {
		using temp = TempDir.createSync("@omp-rpc-plan-");
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: temp.path(),
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1", ANTHROPIC_API_KEY: "test" },
		});
		await client.start();

		const active = await client.setPlanMode({ status: "active", workflow: "parallel" });
		expect(active).toMatchObject({ status: "active", workflow: "parallel" });
		expect((await client.getState()).planMode).toMatchObject({ status: "active", workflow: "parallel" });

		expect(await client.setPlanMode({ status: "paused" })).toMatchObject({ status: "paused" });
		expect(await client.setPlanMode({ status: "active" })).toMatchObject({ status: "active" });
		expect(await client.setPlanMode({ status: "off" })).toEqual({ status: "off", reentry: false });
		expect(await client.setPlanMode({ status: "active" })).toMatchObject({ status: "active", reentry: false });
		expect(await client.setPlanMode({ status: "off" })).toEqual({ status: "off", reentry: false });
	});
});

describe("RPC plan artifacts and recovery", () => {
	it("resolves and pins local URLs, cwd-relative paths, and absolute paths without changing namespaces", async () => {
		using temp = TempDir.createSync("@omp-rpc-plan-artifacts-");
		const firstCwd = path.join(temp.path(), "first-cwd");
		const secondCwd = path.join(temp.path(), "second-cwd");
		let cwd = firstCwd;
		let artifactsDir = path.join(temp.path(), "first-artifacts");
		let sessionId = "first-session";
		const artifacts = createRpcPlanModeArtifacts({
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => sessionId,
			getCwd: () => cwd,
		});

		const relativePath = "plans/review.md";
		await artifacts.write(relativePath, "# Relative\n\noriginal");
		expect(await artifacts.read(relativePath)).toBe("# Relative\n\noriginal");
		const pinnedRelative = artifacts.pin?.(relativePath);
		if (!pinnedRelative) throw new Error("RPC plan artifacts must support pinning");

		cwd = secondCwd;
		artifactsDir = path.join(temp.path(), "second-artifacts");
		sessionId = "second-session";
		expect(await pinnedRelative.read()).toBe("# Relative\n\noriginal");
		await pinnedRelative.write("# Relative\n\nreplacement");
		expect(await Bun.file(path.join(firstCwd, relativePath)).text()).toBe("# Relative\n\nreplacement");
		expect(await Bun.file(path.join(secondCwd, relativePath)).exists()).toBe(false);

		const absolutePath = path.join(firstCwd, "absolute-plan.md");
		await artifacts.write(absolutePath, "# Absolute\n\noriginal");
		const pinnedAbsolute = artifacts.pin?.(absolutePath);
		if (!pinnedAbsolute) throw new Error("RPC plan artifacts must support pinning");
		expect(await pinnedAbsolute.read()).toBe("# Absolute\n\noriginal");
		await pinnedAbsolute.write("# Absolute\n\nreplacement");
		expect(await Bun.file(absolutePath).text()).toBe("# Absolute\n\nreplacement");

		await artifacts.write("local://review.md", "# Local\n\noriginal");
		expect(await artifacts.read("local://review.md")).toBe("# Local\n\noriginal");
	});

	it("replays a recovered filesystem plan review after start listeners can subscribe", async () => {
		using temp = TempDir.createSync("@omp-rpc-plan-recovery-");
		const cwd = temp.path();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const planPath = path.join(cwd, "pending-plan.md");
		const markdown = "# Pending plan\n\nReview me.";
		await Bun.write(planPath, markdown);
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(markdown);
		manager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
			schemaVersion: 1,
			request: {
				id: "recovered-review",
				title: "Pending plan",
				path: planPath,
				markdown,
				planDigest: hasher.digest("hex"),
				allowedContextStrategies: ["fresh", "preserve", "compact"],
				executionModels: [{ provider: "anthropic", modelId: "claude-sonnet-4-5" }],
				defaultExecutionModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				workflow: "parallel",
			},
			status: "pending",
		});
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted RPC recovery session");
		await manager.close();

		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			args: ["--resume", sessionFile],
			capabilities: { planReview: 1 },
			env: {
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: path.join(cwd, "agent-home"),
				ANTHROPIC_API_KEY: "test",
			},
		});
		await client.start();
		const recovered = Promise.withResolvers<{ id: string; path: string; markdown: string }>();
		const unsubscribe = client.onPlanReviewRequest(request => recovered.resolve(request));
		const request = await recovered.promise;
		unsubscribe();
		expect(request).toMatchObject({ id: "recovered-review", path: planPath, markdown });
		expect(await client.respondToPlanReview(request.id, { action: "cancel" })).toMatchObject({
			id: "recovered-review",
			outcome: "cancelled",
		});
		expect(await Bun.file(planPath).text()).toBe(markdown);
		await client.stop();
	}, 30000);
});

describe("RPC plan boundary validation", () => {
	it("rejects malformed review decisions before invoking the mutating controller", async () => {
		const mutations: unknown[] = [];
		const controller = {
			respondToReview: async (input: unknown) => {
				mutations.push(input);
				return { id: "review-1", outcome: "cancelled" as const };
			},
		};
		const malformed = [
			{ action: "execute", context: "fresh", clientTurnId: "" },
			{ action: "execute", context: "invalid", clientTurnId: "turn-1" },
			{ action: "execute", context: "fresh", clientTurnId: "turn-1", executionModel: { provider: "" } },
			{ action: "refine", feedback: 42, clientTurnId: "turn-1" },
			{ action: "refine", feedback: "Try again", clientTurnId: "   " },
		];

		for (const decision of malformed) {
			await expect(respondToRpcPlanReview({ controller, requestId: "review-1", decision })).rejects.toThrow(
				"Invalid plan review decision",
			);
		}
		expect(mutations).toEqual([]);

		await expect(
			respondToRpcPlanReview({
				controller,
				requestId: "review-1",
				decision: { action: "refine", feedback: "Try again", clientTurnId: "turn-1" },
			}),
		).resolves.toEqual({ id: "review-1", outcome: "cancelled" });
		expect(mutations).toEqual([
			{
				requestId: "review-1",
				decision: { action: "refine", feedback: "Try again", clientTurnId: "turn-1" },
			},
		]);
	});

	it("rejects activation while goal or vibe mode is live and preserves valid plan transitions", async () => {
		const transitions: unknown[] = [];
		const controller = {
			setMode: async (input: { status: "off" | "active" | "paused"; workflow?: "parallel" | "iterative" }) => {
				transitions.push(input);
				return { status: input.status, workflow: input.workflow, reentry: input.status === "paused" };
			},
		};

		await expect(
			setRpcPlanModeAtBoundary({
				controller,
				session: { getGoalModeState: () => ({ enabled: false }), getVibeModeState: () => undefined },
				status: "active",
			}),
		).rejects.toThrow("Exit goal mode first.");
		await expect(
			setRpcPlanModeAtBoundary({
				controller,
				session: { getGoalModeState: () => undefined, getVibeModeState: () => ({ enabled: true }) },
				status: "active",
			}),
		).rejects.toThrow("Exit vibe mode first.");
		expect(transitions).toEqual([]);

		const inactiveModes = { getGoalModeState: () => undefined, getVibeModeState: () => undefined };
		for (const planFilePath of ["", "   "]) {
			await expect(
				setRpcPlanModeAtBoundary({
					controller,
					session: inactiveModes,
					status: "active",
					planFilePath,
				}),
			).rejects.toThrow("Invalid plan file path: expected a non-empty string");
		}
		expect(transitions).toEqual([]);
		await expect(
			setRpcPlanModeAtBoundary({ controller, session: inactiveModes, status: "active", workflow: "parallel" }),
		).resolves.toMatchObject({ status: "active", workflow: "parallel" });
		await expect(
			setRpcPlanModeAtBoundary({ controller, session: inactiveModes, status: "paused" }),
		).resolves.toMatchObject({ status: "paused" });
		await expect(
			setRpcPlanModeAtBoundary({ controller, session: inactiveModes, status: "off" }),
		).resolves.toMatchObject({ status: "off" });
		expect(transitions).toEqual([
			{ status: "active", workflow: "parallel", planFilePath: undefined },
			{ status: "paused", workflow: undefined, planFilePath: undefined },
			{ status: "off", workflow: undefined, planFilePath: undefined },
		]);
	});
});
