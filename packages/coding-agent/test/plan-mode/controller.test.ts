import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	PLAN_REVIEW_CUSTOM_TYPE,
	PlanModeController,
	type RpcPlanReviewDecision,
} from "@oh-my-pi/pi-coding-agent/plan-mode/controller";
import {
	fingerprintHostTurnPayload,
	HOST_TURN_OPERATION_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/host-turns";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTestSession } from "../utilities";

function reviewDecision(clientTurnId: string): RpcPlanReviewDecision {
	return { action: "execute", context: "preserve", clientTurnId };
}

describe("PlanModeController", () => {
	it("owns active, paused, resumed, and off transitions with workflow persistence", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const changed: string[] = [];
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			onModeChanged: state => {
				changed.push(`${state.status}:${state.workflow ?? "none"}`);
			},
		});
		try {
			await controller.setMode({ status: "active", workflow: "iterative", planFilePath: "local://PLAN.md" });
			expect(controller.state).toMatchObject({ status: "active", workflow: "iterative" });
			await controller.setMode({ status: "paused" });
			expect(controller.state.status).toBe("paused");
			await controller.setMode({ status: "active" });
			expect(controller.state.status).toBe("active");
			await controller.setMode({ status: "off" });
			expect(controller.state.status).toBe("off");
			expect(changed).toEqual(["active:iterative", "paused:iterative", "active:iterative", "off:none"]);
		} finally {
			await ctx.cleanup();
		}
	});

	it("preserves a persisted non-reentry active session when synchronizing", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: () => Promise.resolve(null),
				write: () => undefined,
				list: () => Promise.resolve([]),
			},
		});
		try {
			ctx.session.sessionManager.appendModeChange("plan", {
				planFilePath: "local://PLAN.md",
				workflow: "parallel",
				reentry: false,
			});
			controller.synchronizeFromSession();
			await controller.setMode({ status: "active", persistModeChange: false });

			expect(controller.state.reentry).toBe(false);
			expect(ctx.session.getPlanModeState()?.reentry).toBe(false);
		} finally {
			await ctx.cleanup();
		}
	});

	it("reads the latest mode entry without materializing the display transcript", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const buildDisplayContext = vi.spyOn(ctx.session, "buildDisplaySessionContext").mockImplementation(() => {
			throw new Error("display transcript should not be built");
		});
		try {
			ctx.session.sessionManager.appendModeChange("plan", {
				planFilePath: "local://PLAN.md",
				workflow: "iterative",
				reentry: true,
			});
			const controller = new PlanModeController({
				session: ctx.session,
				artifacts: {
					read: () => Promise.resolve(null),
					write: () => undefined,
					list: () => Promise.resolve([]),
				},
			});
			expect(controller.state).toEqual({
				status: "active",
				planFilePath: "local://PLAN.md",
				workflow: "iterative",
				reentry: true,
			});

			ctx.session.sessionManager.appendModeChange("none");
			expect(controller.synchronizeFromSession()).toEqual({ status: "off", reentry: false });
			expect(buildDisplayContext).not.toHaveBeenCalled();
		} finally {
			await ctx.cleanup();
		}
	});

	it("restores the original tool presentation when plan-model activation fails", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const originalModel = ctx.session.model!;
		const planModel = { ...originalModel, id: `${originalModel.id}-plan` };
		vi.spyOn(ctx.session, "getEnabledToolNames").mockReturnValue(["read"]);
		vi.spyOn(ctx.session, "getMountedXdevToolNames").mockReturnValue(["xdev-a"]);
		vi.spyOn(ctx.session, "hasBuiltInTool").mockImplementation(name => name === "write");
		const setTools = vi.spyOn(ctx.session, "setActiveToolsByName").mockResolvedValue(undefined);
		const restorePresentation = vi.spyOn(ctx.session, "setActiveToolPresentation").mockResolvedValue(undefined);
		vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		vi.spyOn(ctx.session, "setModelTemporary").mockRejectedValue(new Error("plan model unavailable"));
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: () => Promise.resolve(null),
				write: () => undefined,
				list: () => Promise.resolve([]),
			},
		});
		try {
			await expect(controller.setMode({ status: "active" })).rejects.toThrow("plan model unavailable");
			expect(setTools).toHaveBeenCalledWith(["read", "write"]);
			expect(restorePresentation).toHaveBeenCalledWith(["read"], ["xdev-a"]);
			expect(controller.state).toEqual({ status: "off", reentry: false });
			expect(controller.previousTools).toBeUndefined();
			expect(controller.previousModelState).toBeUndefined();
			expect(ctx.session.getPlanModeState()).toBeUndefined();
		} finally {
			await ctx.cleanup();
		}
	});

	it.each(["off", "paused"] as const)(
		"clears active plan runtime when a session transition restores %s",
		async status => {
			const ctx = await createTestSession({ inMemory: true });
			const executionModel = ctx.session.model!;
			const planModel = { ...executionModel, id: `${executionModel.id}-plan` };
			let currentModel = executionModel;
			Object.defineProperty(ctx.session, "model", { configurable: true, get: () => currentModel });
			vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
				model: planModel,
				thinkingLevel: undefined,
				explicitThinkingLevel: false,
				warning: undefined,
			});
			vi.spyOn(ctx.session, "setModelTemporary").mockImplementation(async model => {
				currentModel = model;
			});
			const restorePresentation = vi.spyOn(ctx.session, "setActiveToolPresentation");
			const controller = new PlanModeController({
				session: ctx.session,
				artifacts: {
					read: () => Promise.resolve(null),
					write: () => undefined,
					list: () => Promise.resolve([]),
				},
			});
			try {
				await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
				expect(ctx.session.getPlanModeState()?.enabled).toBe(true);
				expect(ctx.session.peekPlanProposalHandler()).toBeDefined();
				expect(currentModel).toBe(planModel);

				await controller.prepareSessionTransition();
				if (status === "paused") {
					ctx.session.sessionManager.appendModeChange("plan_paused", {
						planFilePath: "local://TARGET.md",
						workflow: "iterative",
						reentry: true,
					});
				} else {
					ctx.session.sessionManager.appendModeChange("none");
				}
				await controller.reconcileSessionTransition();

				expect(controller.state.status).toBe(status);
				expect(ctx.session.getPlanModeState()).toBeUndefined();
				expect(ctx.session.peekPlanProposalHandler()).toBeUndefined();
				expect(currentModel).toBe(executionModel);
				expect(restorePresentation).toHaveBeenCalled();
			} finally {
				Reflect.deleteProperty(ctx.session, "model");
				await ctx.cleanup();
			}
		},
	);

	it("fully reapplies active persisted plan runtime after a session transition", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const planModel = { ...ctx.session.model!, id: `${ctx.session.model!.id}-plan` };
		vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		const setTools = vi.spyOn(ctx.session, "setActiveToolsByName").mockResolvedValue(undefined);
		const setModel = vi.spyOn(ctx.session, "setModelTemporary").mockResolvedValue(undefined);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: () => Promise.resolve(null),
				write: () => undefined,
				list: () => Promise.resolve([]),
			},
		});
		try {
			ctx.session.sessionManager.appendModeChange("plan", {
				planFilePath: "local://TARGET.md",
				workflow: "iterative",
				reentry: true,
			});
			await controller.reconcileSessionTransition();

			expect(controller.state).toMatchObject({
				status: "active",
				planFilePath: "local://TARGET.md",
				workflow: "iterative",
				reentry: true,
			});
			expect(ctx.session.getPlanModeState()).toMatchObject({
				enabled: true,
				planFilePath: "local://TARGET.md",
				workflow: "iterative",
			});
			expect(ctx.session.peekPlanProposalHandler()).toBeDefined();
			expect(setTools).toHaveBeenCalledWith(expect.arrayContaining(["write"]));
			expect(setModel).toHaveBeenCalledWith(planModel, undefined);
		} finally {
			await ctx.cleanup();
		}
	});

	it("records the preserve-context host-turn rollback boundary before leaving plan mode", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await controller.respondToReview({ requestId: request.id, decision: reviewDecision("turn-boundary") });

			const entries = ctx.session.sessionManager.getBranch();
			const preparedIndex = entries.findIndex(
				entry => entry.type === "custom" && entry.customType === HOST_TURN_OPERATION_CUSTOM_TYPE,
			);
			const planExitIndex = entries.findLastIndex(entry => entry.type === "mode_change" && entry.mode === "none");
			expect(preparedIndex).toBeGreaterThanOrEqual(0);
			expect(planExitIndex).toBeGreaterThan(preparedIndex);
		} finally {
			await ctx.cleanup();
		}
	});

	it("resolves a submitted slug-named plan before a stale state artifact", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([
			["local://completed-plan.md", "# Completed\n\nOld plan."],
			["local://new-draft-plan.md", "# New draft\n\nCurrent plan."],
		]);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve(["local://new-draft-plan.md", "local://completed-plan.md"]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://completed-plan.md" });
			const request = await controller.createReview({ title: "new-draft" });

			expect(request.path).toBe("local://new-draft-plan.md");
			expect(request.markdown).toContain("Current plan");
		} finally {
			await ctx.cleanup();
		}
	});

	it("serializes concurrent duplicate decisions and dispatches only once", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const dispatched: Array<{ clientTurnId: string; prompt: string }> = [];
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: input => {
				dispatched.push({ clientTurnId: input.clientTurnId, prompt: input.prompt });
				return Promise.resolve(true);
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			const decision = reviewDecision("turn-execute");
			const [first, second] = await Promise.all([
				controller.respondToReview({ requestId: request.id, decision }),
				controller.respondToReview({ requestId: request.id, decision }),
			]);

			expect(first).toEqual(second);
			expect(first).toMatchObject({ outcome: "executing", clientTurnId: "turn-execute" });
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]?.prompt).toContain("local://PLAN.md");
		} finally {
			await ctx.cleanup();
		}
	});

	it("restores replacement markdown when execution turn preparation fails", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const original = "# Plan\n\nDo it.";
		const plans = new Map([["local://PLAN.md", original]]);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await expect(
				controller.respondToReview({
					requestId: request.id,
					decision: {
						action: "execute",
						context: "preserve",
						replacementPlanMarkdown: "# Replacement\n\nChanged.",
						executionModel: { provider: "missing", modelId: "missing" },
						clientTurnId: "turn-preparation-failure",
					},
				}),
			).rejects.toThrow("Execution model missing/missing is unavailable");
			expect(plans.get("local://PLAN.md")).toBe(original);
		} finally {
			await ctx.cleanup();
		}
	});

	it("restores active plan runtime when preserve-context preparation fails after exit", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const originalModel = ctx.session.model!;
		const planModel = { ...originalModel, id: `${originalModel.id}-plan` };
		const executionModel = { ...originalModel, id: `${originalModel.id}-exec` };
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([originalModel, planModel, executionModel]);
		const setModelTemporary = vi.spyOn(ctx.session, "setModelTemporary").mockImplementation(async model => {
			if (model.id === executionModel.id) throw new Error("execution model activation failed");
		});
		const setProposalHandler = vi.spyOn(ctx.session, "setPlanProposalHandler");
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			expect(controller.state.status).toBe("active");
			expect(ctx.session.peekPlanProposalHandler()).toBeDefined();
			const request = await controller.createReview({ title: "Plan" });

			await expect(
				controller.respondToReview({
					requestId: request.id,
					decision: {
						action: "execute",
						context: "preserve",
						executionModel: {
							provider: executionModel.provider,
							modelId: executionModel.id,
						},
						clientTurnId: "turn-preserve-prep-fail",
					},
				}),
			).rejects.toThrow("execution model activation failed");

			expect(controller.state).toMatchObject({
				status: "active",
				planFilePath: "local://PLAN.md",
			});
			expect(ctx.session.getPlanModeState()).toMatchObject({
				enabled: true,
				planFilePath: "local://PLAN.md",
			});
			expect(ctx.session.peekPlanProposalHandler()).toBeDefined();
			expect(setProposalHandler).toHaveBeenCalledWith(expect.any(Function));
			expect(setModelTemporary).toHaveBeenCalled();
			expect(controller.getPendingReviewSummaries()).toEqual([
				{ id: request.id, title: "Plan", path: "local://PLAN.md", status: "pending" },
			]);
		} finally {
			await ctx.cleanup();
		}
	});

	it("advertises the saved pre-plan model and thinking level as defaultExecutionModel", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const originalModel = ctx.session.model!;
		const planModel = { ...originalModel, id: `${originalModel.id}-plan` };
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		vi.spyOn(ctx.session, "setModelTemporary").mockResolvedValue(undefined);
		vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([originalModel, planModel]);
		vi.spyOn(ctx.session, "configuredThinkingLevel").mockReturnValue(Effort.High);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			// Active session model is the plan role; omission restores the pre-plan model.
			Object.defineProperty(ctx.session, "model", { configurable: true, get: () => planModel });
			// Simulate plan-role thinking so only #previousModel preserves execution thinking.
			vi.spyOn(ctx.session, "configuredThinkingLevel").mockReturnValue(Effort.Low);
			const request = await controller.createReview({ title: "Plan" });
			expect(request.defaultExecutionModel).toEqual({
				provider: originalModel.provider,
				modelId: originalModel.id,
				thinkingLevel: String(Effort.High),
			});
			expect(request.defaultExecutionModel).not.toEqual({
				provider: planModel.provider,
				modelId: planModel.id,
			});
		} finally {
			Reflect.deleteProperty(ctx.session, "model");
			await ctx.cleanup();
		}
	});

	it("defers previous-model restore when leaving plan mode while streaming", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const executionModel = ctx.session.model!;
		const planModel = { ...executionModel, id: `${executionModel.id}-plan` };
		let currentModel = executionModel;
		Object.defineProperty(ctx.session, "model", { configurable: true, get: () => currentModel });
		Object.defineProperty(ctx.session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
			warning: undefined,
		});
		// Entry while streaming defers the plan-model switch.
		const setModel = vi.spyOn(ctx.session, "setModelTemporary").mockImplementation(async model => {
			currentModel = model;
		});
		vi.spyOn(ctx.session, "sendPlanModeContext").mockResolvedValue(undefined);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: () => Promise.resolve(null),
				write: () => undefined,
				list: () => Promise.resolve([]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			// Simulate plan model already applied (as if entry was not deferred).
			currentModel = planModel;
			setModel.mockClear();

			await controller.setMode({ status: "off" });
			// Still streaming: restore is deferred via #pendingModel.
			expect(setModel).not.toHaveBeenCalled();
			expect(currentModel).toBe(planModel);

			Object.defineProperty(ctx.session, "isStreaming", { configurable: true, get: () => false });
			await controller.flushPendingModelSwitch();
			expect(setModel).toHaveBeenCalledWith(executionModel, undefined);
			expect(currentModel).toBe(executionModel);
		} finally {
			Reflect.deleteProperty(ctx.session, "model");
			Reflect.deleteProperty(ctx.session, "isStreaming");
			await ctx.cleanup();
		}
	});

	it("copies supporting local artifacts into a fresh execution session", async () => {
		const ctx = await createTestSession();
		const localOpts = {
			getArtifactsDir: () => ctx.session.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.session.sessionManager.getSessionId(),
		};
		const sourceRoot = resolveLocalUrlToPath("local://", localOpts);
		await Bun.write(path.join(sourceRoot, "PLAN.md"), "# Plan\n\nDo it.");
		await Bun.write(path.join(sourceRoot, "notes.md"), "# Supporting notes\n\nKeep me.");
		await Bun.write(path.join(sourceRoot, "nested", "draft.md"), "# Nested draft\n");

		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: async planPath => {
					const resolved = resolveLocalUrlToPath(
						planPath.startsWith("local:") ? planPath : `local://${planPath}`,
						{
							getArtifactsDir: () => ctx.session.sessionManager.getArtifactsDir(),
							getSessionId: () => ctx.session.sessionManager.getSessionId(),
						},
					);
					try {
						return await Bun.file(resolved).text();
					} catch {
						return null;
					}
				},
				write: async (planPath, markdown) => {
					const resolved = resolveLocalUrlToPath(
						planPath.startsWith("local:") ? planPath : `local://${planPath}`,
						{
							getArtifactsDir: () => ctx.session.sessionManager.getArtifactsDir(),
							getSessionId: () => ctx.session.sessionManager.getSessionId(),
						},
					);
					await Bun.write(resolved, markdown);
				},
				list: async () => ["local://PLAN.md"],
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			const sourceSessionFile = ctx.session.sessionFile;
			await controller.respondToReview({
				requestId: request.id,
				decision: { action: "execute", context: "fresh", clientTurnId: "turn-fresh-artifacts" },
			});
			expect(ctx.session.sessionFile).not.toBe(sourceSessionFile);
			const destRoot = resolveLocalUrlToPath("local://", {
				getArtifactsDir: () => ctx.session.sessionManager.getArtifactsDir(),
				getSessionId: () => ctx.session.sessionManager.getSessionId(),
			});
			expect(await Bun.file(path.join(destRoot, "PLAN.md")).text()).toContain("# Plan");
			expect(await Bun.file(path.join(destRoot, "notes.md")).text()).toContain("Supporting notes");
			expect(await Bun.file(path.join(destRoot, "nested", "draft.md")).text()).toContain("Nested draft");
		} finally {
			await ctx.cleanup();
		}
	});

	it("validates a fresh-context execution model before replacing the reviewed plan", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const original = "# Plan\n\nDo it.";
		const roots: Record<"parent" | "fresh", Map<string, string>> = {
			parent: new Map([["local://PLAN.md", original]]),
			fresh: new Map(),
		};
		let activeRoot: keyof typeof roots = "parent";
		const newSession = vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			activeRoot = "fresh";
			return true;
		});
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(roots[activeRoot].get(path) ?? null),
				write: (path, markdown) => void roots[activeRoot].set(path, markdown),
				list: () => Promise.resolve([...roots[activeRoot].keys()]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await expect(
				controller.respondToReview({
					requestId: request.id,
					decision: {
						action: "execute",
						context: "fresh",
						replacementPlanMarkdown: "# Replacement\n\nChanged.",
						executionModel: { provider: "missing", modelId: "missing" },
						clientTurnId: "turn-fresh-preparation-failure",
					},
				}),
			).rejects.toThrow("Execution model missing/missing is unavailable");
			expect(newSession).not.toHaveBeenCalled();
			expect(roots.parent.get("local://PLAN.md")).toBe(original);
		} finally {
			await ctx.cleanup();
		}
	});

	it("rejects an execution effort the selected model would clamp before mutating review or session", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const original = "# Plan\n\nDo it.";
		const plans = new Map([["local://PLAN.md", original]]);
		const model = {
			...ctx.session.model!,
			reasoning: true,
			thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High] },
		};
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([model]);
			const newSession = vi.spyOn(ctx.session, "newSession").mockResolvedValue(true);
			const setModelTemporary = vi.spyOn(ctx.session, "setModelTemporary").mockResolvedValue();

			await expect(
				controller.respondToReview({
					requestId: request.id,
					decision: {
						action: "execute",
						context: "fresh",
						replacementPlanMarkdown: "# Replacement\n\nChanged.",
						executionModel: {
							provider: model.provider,
							modelId: model.id,
							thinkingLevel: Effort.XHigh,
						},
						clientTurnId: "turn-unsupported-effort",
					},
				}),
			).rejects.toThrow(`Execution thinking level ${Effort.XHigh} is unsupported by ${model.provider}/${model.id}`);
			expect(controller.state.status).toBe("active");
			expect(plans.get("local://PLAN.md")).toBe(original);
			expect(newSession).not.toHaveBeenCalled();
			expect(setModelTemporary).not.toHaveBeenCalled();
			const latestReview = ctx.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
				.at(-1);
			expect(latestReview).toMatchObject({
				type: "custom",
				customType: PLAN_REVIEW_CUSTOM_TYPE,
				data: { status: "pending" },
			});
		} finally {
			await ctx.cleanup();
		}
	});

	it("applies a supported execution effort exactly", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const model = {
			...ctx.session.model!,
			reasoning: true,
			thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High] },
		};
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([model]);
			const setModelTemporary = vi.spyOn(ctx.session, "setModelTemporary").mockResolvedValue();

			await controller.respondToReview({
				requestId: request.id,
				decision: {
					action: "execute",
					context: "preserve",
					executionModel: {
						provider: model.provider,
						modelId: model.id,
						thinkingLevel: Effort.High,
					},
					clientTurnId: "turn-supported-effort",
				},
			});

			expect(setModelTemporary).toHaveBeenLastCalledWith(model, Effort.High);
		} finally {
			await ctx.cleanup();
		}
	});

	it("honors cancellation without checking a stale plan artifact", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const read = vi.fn((planPath: string) => Promise.resolve(plans.get(planPath) ?? null));
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read,
				write: (planPath, markdown) => void plans.set(planPath, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			plans.set(request.path, "# Changed\n\nNo longer the reviewed plan.");
			read.mockClear();

			await expect(
				controller.respondToReview({ requestId: request.id, decision: { action: "cancel" } }),
			).resolves.toMatchObject({ outcome: "cancelled" });
			expect(read).not.toHaveBeenCalled();
		} finally {
			await ctx.cleanup();
		}
	});

	it("rejects an execution effort above the session thinkingLevelCeiling before mutating", async () => {
		const ctx = await createTestSession({ inMemory: true, thinkingLevelCeiling: Effort.High });
		const original = "# Plan\n\nDo it.";
		const plans = new Map([["local://PLAN.md", original]]);
		const model = {
			...ctx.session.model!,
			reasoning: true,
			thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High, Effort.XHigh] },
		};
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			expect(ctx.session.thinkingLevelCeiling).toBe(Effort.High);
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([model]);
			const setModelTemporary = vi.spyOn(ctx.session, "setModelTemporary").mockResolvedValue();

			await expect(
				controller.respondToReview({
					requestId: request.id,
					decision: {
						action: "execute",
						context: "preserve",
						executionModel: {
							provider: model.provider,
							modelId: model.id,
							thinkingLevel: Effort.XHigh,
						},
						clientTurnId: "turn-above-ceiling",
					},
				}),
			).rejects.toThrow(`Execution thinking level ${Effort.XHigh} is unsupported by ${model.provider}/${model.id}`);
			expect(controller.state.status).toBe("active");
			expect(plans.get("local://PLAN.md")).toBe(original);
			expect(setModelTemporary).not.toHaveBeenCalled();
			const latestReview = ctx.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
				.at(-1);
			expect(latestReview).toMatchObject({
				type: "custom",
				customType: PLAN_REVIEW_CUSTOM_TYPE,
				data: { status: "pending" },
			});
		} finally {
			await ctx.cleanup();
		}
	});

	it("skips re-compaction when compact prep fails after a successful compact", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const model = ctx.session.model!;
		const compact = vi.spyOn(ctx.session, "compact").mockResolvedValue({
			tokensBefore: 1000,
			tokensAfter: 200,
			summary: "compacted",
			firstKeptEntryId: undefined,
		} as never);
		let failModel = true;
		const setModelTemporary = vi.spyOn(ctx.session, "setModelTemporary").mockImplementation(async () => {
			if (failModel) throw new Error("execution model activation failed after compact");
		});
		vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([model]);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "compact",
				executionModel: { provider: model.provider, modelId: model.id },
				clientTurnId: "turn-compact-once",
			};

			await expect(controller.respondToReview({ requestId: request.id, decision })).rejects.toThrow(
				"execution model activation failed after compact",
			);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(compact).toHaveBeenCalledWith(undefined, { internalGuidance: expect.any(String) });
			const pending = ctx.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
				.at(-1);
			expect(pending).toMatchObject({
				type: "custom",
				data: { status: "pending", contextCompacted: true },
			});

			failModel = false;
			await expect(controller.respondToReview({ requestId: request.id, decision })).resolves.toMatchObject({
				outcome: "executing",
				clientTurnId: "turn-compact-once",
			});
			expect(compact).toHaveBeenCalledTimes(1);
			expect(setModelTemporary).toHaveBeenCalled();
		} finally {
			await ctx.cleanup();
		}
	});

	it("returns a cached fresh-context resolution on immediate lost-response retry", async () => {
		const ctx = await createTestSession();
		const plans = {
			source: new Map([["local://PLAN.md", "# Plan\n\nDo it."]]),
			child: new Map<string, string>(),
		};
		let sourceSessionFile: string | undefined;
		const activeRoot = () =>
			sourceSessionFile === undefined || ctx.session.sessionFile === sourceSessionFile ? plans.source : plans.child;
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(activeRoot().get(path) ?? null),
				write: (path, markdown) => void activeRoot().set(path, markdown),
				list: () => Promise.resolve([...activeRoot().keys()]),
				pin: path => {
					const root = activeRoot();
					return {
						read: () => Promise.resolve(root.get(path) ?? null),
						write: markdown => void root.set(path, markdown),
					};
				},
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await ctx.session.sessionManager.ensureOnDisk();
			sourceSessionFile = ctx.session.sessionFile;
			if (!sourceSessionFile) throw new Error("Expected persisted source session");
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "fresh",
				clientTurnId: "turn-fresh-retry",
			};

			const first = await controller.respondToReview({ requestId: request.id, decision });
			expect(first).toMatchObject({ outcome: "executing", clientTurnId: "turn-fresh-retry" });
			expect(ctx.session.sessionFile).not.toBe(sourceSessionFile);

			const second = await controller.respondToReview({ requestId: request.id, decision });
			expect(second).toEqual(first);
		} finally {
			await ctx.cleanup();
		}
	});

	it("closes a fresh-context review in the source journal after switching sessions", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const roots: Record<"parent" | "fresh", Map<string, string>> = {
			parent: new Map([["local://PLAN.md", "# Plan\n\nDo it."]]),
			fresh: new Map(),
		};
		let activeRoot: keyof typeof roots = "parent";
		let sourceJournal: SessionManager | undefined;
		const cloneCurrentSession = ctx.session.sessionManager.cloneCurrentSession.bind(ctx.session.sessionManager);
		vi.spyOn(ctx.session.sessionManager, "cloneCurrentSession").mockImplementation(() => {
			sourceJournal = cloneCurrentSession();
			return sourceJournal;
		});
		vi.spyOn(ctx.session, "newSession").mockImplementation(async () => {
			const latest = ctx.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
				.at(-1);
			expect(latest?.type === "custom" ? (latest.data as { status?: string }).status : undefined).toBe(
				"dispatching",
			);
			activeRoot = "fresh";
			return true;
		});
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(roots[activeRoot].get(path) ?? null),
				write: (path, markdown) => void roots[activeRoot].set(path, markdown),
				list: () => Promise.resolve([...roots[activeRoot].keys()]),
				pin: path => {
					const root = roots[activeRoot];
					return {
						read: () => Promise.resolve(root.get(path) ?? null),
						write: markdown => void root.set(path, markdown),
					};
				},
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await controller.respondToReview({
				requestId: request.id,
				decision: { action: "execute", context: "fresh", clientTurnId: "turn-fresh" },
			});

			const latestSourceRecord = sourceJournal
				?.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
				.at(-1);
			expect(
				latestSourceRecord?.type === "custom"
					? (latestSourceRecord.data as { status?: string; resolution?: { outcome?: string } })
					: undefined,
			).toMatchObject({ status: "dispatching", resolution: { outcome: "executing" } });
		} finally {
			await sourceJournal?.close();
			await ctx.cleanup();
		}
	});

	it("restores the active source session and pending review after fresh preparation fails", async () => {
		const ctx = await createTestSession();
		const original = "# Plan\n\nDo it.";
		const replacement = "# Replacement\n\nChanged.";
		const roots = {
			source: new Map([["local://PLAN.md", original]]),
			child: new Map<string, string>(),
		};
		let sourceSessionFile: string | undefined;
		const activeRoot = () =>
			sourceSessionFile === undefined || ctx.session.sessionFile === sourceSessionFile ? roots.source : roots.child;
		const model = ctx.session.model!;
		vi.spyOn(ctx.session, "getAvailableModels").mockReturnValue([model]);
		const setModel = vi.spyOn(ctx.session, "setModelTemporary").mockImplementation(async () => {
			if (sourceSessionFile !== undefined && ctx.session.sessionFile !== sourceSessionFile) {
				throw new Error("child model activation failed");
			}
		});
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(activeRoot().get(path) ?? null),
				write: (path, markdown) => void activeRoot().set(path, markdown),
				list: () => Promise.resolve([...activeRoot().keys()]),
				pin: path => {
					const root = activeRoot();
					return {
						read: () => Promise.resolve(root.get(path) ?? null),
						write: markdown => void root.set(path, markdown),
					};
				},
			},
			dispatchTurn: () => Promise.resolve(true),
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			await ctx.session.sessionManager.ensureOnDisk();
			sourceSessionFile = ctx.session.sessionFile;
			if (!sourceSessionFile) throw new Error("Expected persisted source session");
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "fresh",
				replacementPlanMarkdown: replacement,
				executionModel: { provider: model.provider, modelId: model.id },
				clientTurnId: "turn-fresh-failure",
			};

			await expect(controller.respondToReview({ requestId: request.id, decision })).rejects.toThrow(
				"child model activation failed",
			);
			expect(ctx.session.sessionFile).toBe(sourceSessionFile);
			expect(controller.state.status).toBe("active");
			expect(ctx.session.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
			expect(ctx.session.peekPlanProposalHandler()).toBeDefined();
			expect(controller.getPendingReviewSummaries()).toEqual([
				expect.objectContaining({ id: request.id, status: "pending" }),
			]);
			expect(roots.source.get("local://PLAN.md")).toBe(original);
			expect(roots.child.get("local://PLAN.md")).toBe(replacement);

			setModel.mockResolvedValue(undefined);
			await expect(controller.respondToReview({ requestId: request.id, decision })).resolves.toMatchObject({
				outcome: "executing",
				clientTurnId: "turn-fresh-failure",
			});
		} finally {
			await ctx.cleanup();
		}
	});

	it.each([false, true])("queues an accepted review without awaiting a model turn (streaming=%s)", async streaming => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await controller.createReview({ title: "Plan" });
			Object.defineProperty(ctx.session, "isStreaming", { configurable: true, get: () => streaming });
			const promptTurn = vi
				.spyOn(ctx.session, "prompt")
				.mockRejectedValue(new Error("blocking prompt should not run"));
			const preparedFollowUp = vi.spyOn(ctx.session, "followUpPreparedHostTurn").mockResolvedValue();

			const resolution = await controller.respondToReview({
				requestId: request.id,
				decision: reviewDecision(`turn-queued-${streaming}`),
			});

			expect(resolution).toMatchObject({ outcome: "executing", clientTurnId: `turn-queued-${streaming}` });
			expect(promptTurn).not.toHaveBeenCalled();
			expect(preparedFollowUp).toHaveBeenCalledWith(`turn-queued-${streaming}`);
			expect(controller.getPendingReviewSummaries()).toEqual([]);
		} finally {
			Reflect.deleteProperty(ctx.session, "isStreaming");
			await ctx.cleanup();
		}
	});

	it("recovers an unresolved review with the same request id", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const options = {
			session: ctx.session,
			artifacts: {
				read: (path: string) => Promise.resolve(plans.get(path) ?? null),
				write: (path: string, markdown: string) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
		};
		try {
			const first = new PlanModeController(options);
			await first.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await first.createReview({ title: "Plan" });

			const resumed = new PlanModeController(options);
			const restored = await resumed.recoverPendingReview();
			expect(restored?.id).toBe(request.id);
			expect(restored?.markdown).toBe("# Plan\n\nDo it.");
		} finally {
			await ctx.cleanup();
		}
	});

	it("recovers a prepared review dispatch and preserves idempotency", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const artifacts = {
			read: (path: string) => Promise.resolve(plans.get(path) ?? null),
			write: (path: string, markdown: string) => void plans.set(path, markdown),
			list: () => Promise.resolve([...plans.keys()]),
		};
		try {
			const first = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: () => {
					throw new Error("simulated crash before enqueue");
				},
			});
			await first.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await first.createReview({ title: "Plan" });
			const decision = reviewDecision("turn-recovered");
			await expect(first.respondToReview({ requestId: request.id, decision })).rejects.toThrow(
				"simulated crash before enqueue",
			);

			const dispatched: string[] = [];
			const resumed = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: input => {
					dispatched.push(input.clientTurnId);
					return Promise.resolve(true);
				},
			});
			await resumed.recoverPendingReview();
			expect(dispatched).toEqual(["turn-recovered"]);
			const resolution = await resumed.respondToReview({ requestId: request.id, decision });
			expect(resolution).toMatchObject({ outcome: "executing", clientTurnId: "turn-recovered" });
			expect(dispatched).toEqual(["turn-recovered"]);
		} finally {
			await ctx.cleanup();
		}
	});

	it("does not open identifier-only parent references during recovery", async () => {
		const ctx = await createTestSession();
		try {
			const forked = await ctx.session.sessionManager.fork();
			if (!forked) throw new Error("expected a persisted session fork");
			const parentSession = ctx.session.sessionManager.getHeader()?.parentSession;
			expect(parentSession).toBeTruthy();
			expect(ctx.session.sessionManager.sessionFileExists(parentSession!)).toBe(false);

			const open = vi.spyOn(SessionManager, "open").mockRejectedValue(new Error("must not open a session id"));
			try {
				const controller = new PlanModeController({
					session: ctx.session,
					artifacts: {
						read: () => Promise.resolve(null),
						write: () => undefined,
						list: () => Promise.resolve([]),
					},
				});
				await expect(controller.recoverPendingReview()).resolves.toBeUndefined();
				expect(open).not.toHaveBeenCalled();
			} finally {
				open.mockRestore();
			}
		} finally {
			await ctx.cleanup();
		}
	});

	it("associates a fresh child operation in the source journal before dispatch and recovers it from the child", async () => {
		const ctx = await createTestSession();
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const artifacts = {
			read: (path: string) => Promise.resolve(plans.get(path) ?? null),
			write: (path: string, markdown: string) => void plans.set(path, markdown),
			list: () => Promise.resolve([...plans.keys()]),
		};
		let sourceSessionFile: string | undefined;
		try {
			const first = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: async () => {
					if (!sourceSessionFile) throw new Error("missing source session file");
					const childOperation = ctx.session.sessionManager.getHostTurnOperations().at(-1);
					const sourceManager = await SessionManager.open(sourceSessionFile);
					try {
						const sourceRecord = sourceManager
							.getBranch()
							.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
							.at(-1);
						expect(sourceRecord?.type === "custom" ? sourceRecord.data : undefined).toMatchObject({
							status: "dispatching",
							hostTurnOperationId: childOperation?.operationId,
							hostTurnSessionFile: ctx.session.sessionFile,
						});
					} finally {
						await sourceManager.close();
					}
					throw new Error("simulated crash after child preparation");
				},
			});
			await first.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await first.createReview({ title: "Plan" });
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "fresh",
				clientTurnId: "turn-fresh-child-recovery",
			};
			sourceSessionFile = ctx.session.sessionFile;
			await expect(first.respondToReview({ requestId: request.id, decision })).rejects.toThrow(
				"simulated crash after child preparation",
			);
			expect(ctx.session.sessionFile).not.toBe(sourceSessionFile);

			const dispatched: string[] = [];
			const offered = vi.fn();
			const resumed = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: input => {
					dispatched.push(input.clientTurnId);
					return Promise.resolve(true);
				},
				onReviewRequested: offered,
			});
			expect(await resumed.recoverPendingReview()).toBeUndefined();
			expect(dispatched).toEqual(["turn-fresh-child-recovery"]);
			expect(offered).not.toHaveBeenCalled();
			expect(await resumed.respondToReview({ requestId: request.id, decision })).toMatchObject({
				outcome: "executing",
				clientTurnId: "turn-fresh-child-recovery",
			});
			expect(dispatched).toEqual(["turn-fresh-child-recovery"]);
		} finally {
			await ctx.cleanup();
		}
	});

	it("repairs the source association after exit between child preparation and source journaling", async () => {
		const ctx = await createTestSession();
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const artifacts = {
			read: (path: string) => Promise.resolve(plans.get(path) ?? null),
			write: (path: string, markdown: string) => void plans.set(path, markdown),
			list: () => Promise.resolve([...plans.keys()]),
		};
		try {
			const first = new PlanModeController({ session: ctx.session, artifacts });
			await first.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await first.createReview({ title: "Plan" });
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "fresh",
				clientTurnId: "turn-fresh-unassociated",
			};
			await ctx.session.sessionManager.appendEntriesAtomically(() => {
				ctx.session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
					schemaVersion: 1,
					request,
					status: "dispatching",
					decision,
					decisionFingerprint: fingerprintHostTurnPayload("plan_execute", decision),
				});
			});
			await first.setMode({ status: "off", preserveReentry: true });
			const sourceSessionFile = ctx.session.sessionFile;
			if (!sourceSessionFile) throw new Error("missing source session file");
			expect(await ctx.session.newSession({ parentSession: sourceSessionFile })).toBe(true);
			const operation = await ctx.session.sessionManager.prepareHostTurnOperation({
				clientTurnId: decision.clientTurnId,
				kind: "plan_execute",
				payload: { text: "Execute the reviewed plan.", synthetic: true },
			});

			const dispatched: string[] = [];
			const offered = vi.fn();
			const resumed = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: async input => {
					const sourceManager = await SessionManager.open(sourceSessionFile);
					try {
						const associated = sourceManager
							.getBranch()
							.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
							.at(-1);
						expect(associated?.type === "custom" ? associated.data : undefined).toMatchObject({
							hostTurnOperationId: operation.operationId,
							hostTurnSessionFile: ctx.session.sessionFile,
						});
					} finally {
						await sourceManager.close();
					}
					dispatched.push(input.clientTurnId);
					return true;
				},
				onReviewRequested: offered,
			});
			expect(await resumed.recoverPendingReview()).toBeUndefined();
			expect(dispatched).toEqual([decision.clientTurnId]);
			expect(offered).not.toHaveBeenCalled();
		} finally {
			await ctx.cleanup();
		}
	});

	it("preserves a failed fresh child operation when recovery starts in the source session", async () => {
		const ctx = await createTestSession();
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const artifacts = {
			read: (path: string) => Promise.resolve(plans.get(path) ?? null),
			write: (path: string, markdown: string) => void plans.set(path, markdown),
			list: () => Promise.resolve([...plans.keys()]),
		};
		let sourceSessionFile: string | undefined;
		let childSessionFile: string | undefined;
		try {
			const first = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: async input => {
					const operation = ctx.session.sessionManager
						.getHostTurnOperations()
						.find(candidate => candidate.clientTurnId === input.clientTurnId);
					if (!operation) throw new Error("missing child operation");
					childSessionFile = ctx.session.sessionFile;
					await ctx.session.sessionManager.markHostTurnDispatched({
						clientTurnId: operation.clientTurnId,
						payloadFingerprint: operation.payloadFingerprint,
						nativeIdentity: {
							sessionId: ctx.session.sessionManager.getSessionId(),
							sessionFile: childSessionFile,
							entryId: "executed-child-entry",
						},
					});
					throw new Error("simulated crash after dispatch");
				},
			});
			await first.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await first.createReview({ title: "Plan" });
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "fresh",
				clientTurnId: "turn-fresh-dispatched",
			};
			sourceSessionFile = ctx.session.sessionFile;
			await expect(first.respondToReview({ requestId: request.id, decision })).rejects.toThrow(
				"simulated crash after dispatch",
			);
			if (!sourceSessionFile || !childSessionFile) throw new Error("missing fresh session lineage");
			expect(await ctx.session.switchSession(sourceSessionFile)).toBe(true);

			const dispatch = vi.fn(() => Promise.resolve(true));
			const offered = vi.fn();
			const resumed = new PlanModeController({
				session: ctx.session,
				artifacts,
				dispatchTurn: dispatch,
				onReviewRequested: offered,
			});
			expect(await resumed.recoverPendingReview()).toBeUndefined();
			expect(ctx.session.sessionFile).toBe(childSessionFile);
			expect(dispatch).not.toHaveBeenCalled();
			expect(offered).not.toHaveBeenCalled();
			expect(await resumed.respondToReview({ requestId: request.id, decision })).toMatchObject({
				outcome: "aborted",
				clientTurnId: "turn-fresh-dispatched",
			});
		} finally {
			await ctx.cleanup();
		}
	});

	it("returns to the source review when a fresh switch exits before preparing the child operation", async () => {
		const ctx = await createTestSession();
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const artifacts = {
			read: (path: string) => Promise.resolve(plans.get(path) ?? null),
			write: (path: string, markdown: string) => void plans.set(path, markdown),
			list: () => Promise.resolve([...plans.keys()]),
		};
		try {
			const first = new PlanModeController({ session: ctx.session, artifacts });
			await first.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const request = await first.createReview({ title: "Plan" });
			const decision: RpcPlanReviewDecision = {
				action: "execute",
				context: "fresh",
				clientTurnId: "turn-fresh-unprepared",
			};
			await ctx.session.sessionManager.appendEntriesAtomically(() => {
				ctx.session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
					schemaVersion: 1,
					request,
					status: "dispatching",
					decision,
					decisionFingerprint: fingerprintHostTurnPayload("plan_execute", decision),
				});
			});
			await first.setMode({ status: "off", preserveReentry: true });
			const sourceSessionFile = ctx.session.sessionFile;
			if (!sourceSessionFile) throw new Error("missing source session file");
			expect(await ctx.session.newSession({ parentSession: sourceSessionFile })).toBe(true);

			const offered = vi.fn();
			const resumed = new PlanModeController({
				session: ctx.session,
				artifacts,
				onReviewRequested: offered,
			});
			const restored = await resumed.recoverPendingReview();
			expect(restored?.id).toBe(request.id);
			expect(ctx.session.sessionFile).toBe(sourceSessionFile);
			expect(offered).toHaveBeenCalledWith(request);
			const latest = ctx.session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === PLAN_REVIEW_CUSTOM_TYPE)
				.at(-1);
			expect(latest?.type === "custom" ? latest.data : undefined).toMatchObject({
				status: "pending",
			});
			expect(latest?.type === "custom" ? latest.data : undefined).not.toHaveProperty("hostTurnOperationId");
		} finally {
			await ctx.cleanup();
		}
	});

	it("stops the proposal turn before returning a native review result", async () => {
		const ctx = await createTestSession({ inMemory: true });
		const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
		const abortGate = Promise.withResolvers<void>();
		const controller = new PlanModeController({
			session: ctx.session,
			artifacts: {
				read: path => Promise.resolve(plans.get(path) ?? null),
				write: (path, markdown) => void plans.set(path, markdown),
				list: () => Promise.resolve([...plans.keys()]),
			},
			onReviewRequested: () => {
				expect(abort).not.toHaveBeenCalled();
			},
		});
		const abort = vi.spyOn(ctx.session, "abort").mockImplementation(() => abortGate.promise);
		const mark = vi.spyOn(ctx.session, "markPlanInternalAbortPending");
		const clearPlanInternalAbortPending = ctx.session.clearPlanInternalAbortPending.bind(ctx.session);
		const cleared = Promise.withResolvers<void>();
		const clear = vi.spyOn(ctx.session, "clearPlanInternalAbortPending").mockImplementation(() => {
			clearPlanInternalAbortPending();
			cleared.resolve();
		});
		try {
			await controller.setMode({ status: "active", planFilePath: "local://PLAN.md" });
			const handler = ctx.session.peekPlanProposalHandler();
			expect(handler).toBeDefined();

			const result = await handler!("Plan");

			expect(result).toMatchObject({ content: [{ type: "text", text: "Plan ready for review." }] });
			expect(mark).toHaveBeenCalledTimes(1);
			expect(abort).toHaveBeenCalledTimes(1);
			expect(ctx.session.isPlanInternalAbortPending).toBe(true);
			expect(clear).not.toHaveBeenCalled();

			abortGate.resolve();
			await cleared.promise;
			expect(clear).toHaveBeenCalledTimes(1);
			expect(ctx.session.isPlanInternalAbortPending).toBe(false);
		} finally {
			abortGate.resolve();
			await ctx.cleanup();
		}
	});

	it.each(["paused", "off"] as const)(
		"fully restores plan-mode invariants before refining after mode becomes %s",
		async status => {
			const ctx = await createTestSession({ inMemory: true });
			const plans = new Map([["local://PLAN.md", "# Plan\n\nDo it."]]);
			const changed: string[] = [];
			const dispatchTurn = vi.fn(() => Promise.resolve(true));
			const controller = new PlanModeController({
				session: ctx.session,
				artifacts: {
					read: path => Promise.resolve(plans.get(path) ?? null),
					write: (path, markdown) => void plans.set(path, markdown),
					list: () => Promise.resolve([...plans.keys()]),
				},
				dispatchTurn,
				onModeChanged: state => {
					changed.push(state.status);
				},
			});
			try {
				await controller.setMode({
					status: "active",
					workflow: "iterative",
					planFilePath: "local://PLAN.md",
				});
				const request = await controller.createReview({ title: "Plan" });
				await controller.setMode({ status });
				changed.length = 0;

				const originalModel = ctx.session.model!;
				const planModel = { ...originalModel, id: `${originalModel.id}-plan-refinement` };
				vi.spyOn(ctx.session, "resolveRoleModelWithThinking").mockReturnValue({
					model: planModel,
					thinkingLevel: undefined,
					explicitThinkingLevel: false,
					warning: undefined,
				});
				const setModel = vi.spyOn(ctx.session, "setModelTemporary").mockResolvedValue(undefined);
				const setTools = vi.spyOn(ctx.session, "setActiveToolsByName");
				const setProposalHandler = vi.spyOn(ctx.session, "setPlanProposalHandler");

				const resolution = await controller.respondToReview({
					requestId: request.id,
					decision: {
						action: "refine",
						feedback: "Add rollback details.",
						clientTurnId: `turn-refine-${status}`,
					},
				});

				expect(resolution).toMatchObject({
					outcome: "refining",
					resume: { status: "active", planFilePath: request.path, workflow: "iterative" },
				});
				expect(controller.state).toMatchObject({
					status: "active",
					planFilePath: request.path,
					workflow: "iterative",
				});
				expect(ctx.session.getPlanModeState()).toMatchObject({
					enabled: true,
					planFilePath: request.path,
					workflow: "iterative",
				});
				expect(ctx.session.buildDisplaySessionContext()).toMatchObject({
					mode: "plan",
					modeData: { planFilePath: request.path, workflow: "iterative" },
				});
				expect(controller.previousTools).toBeDefined();
				expect(controller.previousModelState?.model).toBe(originalModel);
				expect(setTools).toHaveBeenCalledTimes(1);
				expect(setModel).toHaveBeenCalledWith(planModel, undefined);
				expect(setProposalHandler).toHaveBeenCalledWith(expect.any(Function));
				expect(changed).toEqual(["active"]);
				expect(dispatchTurn).toHaveBeenCalledWith({
					clientTurnId: `turn-refine-${status}`,
					kind: "plan_refine",
					prompt: expect.stringContaining("Add rollback details."),
				});
			} finally {
				await ctx.cleanup();
			}
		},
	);
});
