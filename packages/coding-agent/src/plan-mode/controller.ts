import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { ContextUsage } from "../extensibility/extensions/types";
import { resolveLocalUrlToPath } from "../internal-urls";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import planModeRefinePrompt from "../prompts/system/plan-mode-refine.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { fingerprintHostTurnPayload, type HostTurnKind, type HostTurnOperation } from "../session/host-turns";
import type { ModeChangeEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampThinkingLevelToCeiling,
	parseConfiguredThinkingLevel,
} from "../thinking";
import { resolveApprovedPlan } from "./approved-plan";
import { copyLocalArtifactTree } from "./local-artifacts";
import { resolvePlanModelTransition } from "./model-transition";

export const PLAN_REVIEW_CUSTOM_TYPE = "plan_review";

export type RpcPlanModeStatus = "off" | "active" | "paused";
export type RpcPlanWorkflow = "parallel" | "iterative";
export type RpcPlanContextStrategy = "fresh" | "preserve" | "compact";

export interface RpcPlanModeState {
	status: RpcPlanModeStatus;
	planFilePath?: string;
	workflow?: RpcPlanWorkflow;
	reentry: boolean;
}

export interface RpcPlanExecutionModel {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

export type RpcPlanReviewDecision =
	| {
			action: "execute";
			context: RpcPlanContextStrategy;
			executionModel?: RpcPlanExecutionModel;
			replacementPlanMarkdown?: string;
			clientTurnId: string;
	  }
	| {
			action: "refine";
			feedback: string;
			replacementPlanMarkdown?: string;
			clientTurnId: string;
	  }
	| { action: "cancel" };

export interface RpcPlanReviewRequest {
	id: string;
	title: string;
	path: string;
	markdown: string;
	planDigest: string;
	allowedContextStrategies: RpcPlanContextStrategy[];
	contextUsage?: ContextUsage;
	executionModels: RpcPlanExecutionModel[];
	defaultExecutionModel?: RpcPlanExecutionModel;
	workflow: RpcPlanWorkflow;
}

export type RpcPlanReviewOutcome = "executing" | "refining" | "cancelled" | "stale" | "aborted" | "process_exited";

export interface RpcPlanReviewResolution {
	id: string;
	outcome: RpcPlanReviewOutcome;
	clientTurnId?: string;
	resume?: RpcPlanModeState;
	planDigest?: string;
}

export interface PinnedPlanModeArtifact {
	read(): Promise<string | null>;
	write(markdown: string): void | Promise<void>;
}

export interface PlanModeArtifacts {
	read(path: string): Promise<string | null>;
	write(path: string, markdown: string): void | Promise<void>;
	list(): Promise<string[]>;
	/** Bind one artifact to the current session so rollback still targets its source after a session switch. */
	pin?(path: string): PinnedPlanModeArtifact;
}

export interface PlanTurnDispatchInput {
	clientTurnId: string;
	kind: Extract<HostTurnKind, "plan_execute" | "plan_refine">;
	prompt: string;
}

export interface PlanModeControllerOptions {
	session: AgentSession;
	artifacts: PlanModeArtifacts;
	dispatchTurn?: (input: PlanTurnDispatchInput) => boolean | Promise<boolean>;
	/** Persist review records for RPC recovery; local interactive hosts own their review lifecycle. */
	persistReviews?: boolean;
	onModeChanged?: (state: RpcPlanModeState) => void | Promise<void>;
	onReviewRequested?: (request: RpcPlanReviewRequest) => void | Promise<void>;
	onReviewResolved?: (resolution: RpcPlanReviewResolution) => void | Promise<void>;
	/** Observe a successfully committed session transition without coupling this controller to its host. */
	onSessionTransitionCommitted?: () => void | Promise<void>;
	onWarning?: (message: string) => void;
}

type ReviewStatus = "pending" | "dispatching" | "dispatched" | "resolved";

interface PlanReviewRecord {
	schemaVersion: 1;
	request: RpcPlanReviewRequest;
	status: ReviewStatus;
	decision?: RpcPlanReviewDecision;
	decisionFingerprint?: string;
	resolution?: RpcPlanReviewResolution;
	priorMarkdown?: string;
	replacementMarkdown?: string;
	replacementDigest?: string;
	hostTurnOperationId?: string;
	/** True once compact-context prep has already compacted this pending review. */
	contextCompacted?: boolean;
	/** True once plan exit, compaction, execution model, and tool restoration have completed. */
	preparationComplete?: boolean;
	hostTurnSessionFile?: string;
}

interface PreviousModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

interface ResolvedExecutionModel {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicit: boolean;
}

function markdownDigest(markdown: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(markdown);
	return hasher.digest("hex");
}

function latestModeChange(manager: SessionManager): ModeChangeEntry | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "mode_change") return entry;
	}
	return undefined;
}

function parseModeState(manager: SessionManager): RpcPlanModeState {
	const modeChange = latestModeChange(manager);
	const data = modeChange?.data;
	const planFilePath = typeof data?.planFilePath === "string" ? data.planFilePath : undefined;
	const workflow = data?.workflow === "iterative" ? "iterative" : "parallel";
	const reentry = data?.reentry === true;
	if (modeChange?.mode === "plan") return { status: "active", planFilePath, workflow, reentry };
	if (modeChange?.mode === "plan_paused") return { status: "paused", planFilePath, workflow, reentry };
	return { status: "off", reentry: false };
}

function isContextStrategy(value: unknown): value is RpcPlanContextStrategy {
	return value === "fresh" || value === "preserve" || value === "compact";
}

function parseExecutionModel(value: unknown): RpcPlanExecutionModel | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string") return undefined;
	return {
		provider: value.provider,
		modelId: value.modelId,
		thinkingLevel: typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined,
	};
}

function parsePreviousModelState(session: AgentSession): PreviousModelState | undefined {
	const modeChange = latestModeChange(session.sessionManager);
	if (modeChange?.mode !== "plan") return undefined;
	const selection = parseExecutionModel(modeChange.data?.previousModel);
	if (!selection) return undefined;
	const model = session
		.getAvailableModels()
		.find(candidate => candidate.provider === selection.provider && candidate.id === selection.modelId);
	if (!model) return undefined;
	const thinkingLevel =
		selection.thinkingLevel === undefined ? undefined : parseConfiguredThinkingLevel(selection.thinkingLevel);
	if (selection.thinkingLevel !== undefined && thinkingLevel === undefined) return undefined;
	return { model, thinkingLevel };
}

function serializePreviousModelState(state: PreviousModelState): RpcPlanExecutionModel {
	return {
		provider: state.model.provider,
		modelId: state.model.id,
		...(state.thinkingLevel !== undefined ? { thinkingLevel: state.thinkingLevel } : {}),
	};
}

function parseContextUsage(value: unknown): ContextUsage | undefined {
	if (
		!isRecord(value) ||
		typeof value.tokens !== "number" ||
		typeof value.contextWindow !== "number" ||
		typeof value.percent !== "number"
	) {
		return undefined;
	}
	return { tokens: value.tokens, contextWindow: value.contextWindow, percent: value.percent };
}

function parseDecision(value: unknown): RpcPlanReviewDecision | undefined {
	if (!isRecord(value) || typeof value.action !== "string") return undefined;
	if (value.action === "cancel") return { action: "cancel" };
	const replacementPlanMarkdown =
		typeof value.replacementPlanMarkdown === "string" ? value.replacementPlanMarkdown : undefined;
	if (value.action === "execute" && isContextStrategy(value.context) && typeof value.clientTurnId === "string") {
		const executionModel = value.executionModel === undefined ? undefined : parseExecutionModel(value.executionModel);
		if (value.executionModel !== undefined && executionModel === undefined) return undefined;
		return {
			action: "execute",
			context: value.context,
			executionModel,
			replacementPlanMarkdown,
			clientTurnId: value.clientTurnId,
		};
	}
	if (value.action === "refine" && typeof value.feedback === "string" && typeof value.clientTurnId === "string") {
		return {
			action: "refine",
			feedback: value.feedback,
			replacementPlanMarkdown,
			clientTurnId: value.clientTurnId,
		};
	}
	return undefined;
}

function parseMode(value: unknown): RpcPlanModeState | undefined {
	if (!isRecord(value) || (value.status !== "off" && value.status !== "active" && value.status !== "paused")) {
		return undefined;
	}
	return {
		status: value.status,
		planFilePath: typeof value.planFilePath === "string" ? value.planFilePath : undefined,
		workflow: value.workflow === "iterative" ? "iterative" : value.workflow === "parallel" ? "parallel" : undefined,
		reentry: value.reentry === true,
	};
}

function parseRequest(value: unknown): RpcPlanReviewRequest | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.title !== "string" ||
		typeof value.path !== "string" ||
		typeof value.markdown !== "string" ||
		typeof value.planDigest !== "string" ||
		!Array.isArray(value.allowedContextStrategies) ||
		!Array.isArray(value.executionModels) ||
		(value.workflow !== "parallel" && value.workflow !== "iterative")
	) {
		return undefined;
	}
	const strategies = value.allowedContextStrategies.filter(isContextStrategy);
	if (strategies.length !== value.allowedContextStrategies.length) return undefined;
	const executionModels: RpcPlanExecutionModel[] = [];
	for (const candidate of value.executionModels) {
		const parsed = parseExecutionModel(candidate);
		if (!parsed) return undefined;
		executionModels.push(parsed);
	}
	const defaultExecutionModel =
		value.defaultExecutionModel === undefined ? undefined : parseExecutionModel(value.defaultExecutionModel);
	if (value.defaultExecutionModel !== undefined && !defaultExecutionModel) return undefined;
	return {
		id: value.id,
		title: value.title,
		path: value.path,
		markdown: value.markdown,
		planDigest: value.planDigest,
		allowedContextStrategies: strategies,
		contextUsage: parseContextUsage(value.contextUsage),
		executionModels,
		defaultExecutionModel,
		workflow: value.workflow,
	};
}

function parseResolution(value: unknown): RpcPlanReviewResolution | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		(value.outcome !== "executing" &&
			value.outcome !== "refining" &&
			value.outcome !== "cancelled" &&
			value.outcome !== "stale" &&
			value.outcome !== "aborted" &&
			value.outcome !== "process_exited")
	) {
		return undefined;
	}
	return {
		id: value.id,
		outcome: value.outcome,
		clientTurnId: typeof value.clientTurnId === "string" ? value.clientTurnId : undefined,
		resume: parseMode(value.resume),
		planDigest: typeof value.planDigest === "string" ? value.planDigest : undefined,
	};
}

function parseReviewRecord(value: unknown): PlanReviewRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
	const request = parseRequest(value.request);
	if (
		!request ||
		(value.status !== "pending" &&
			value.status !== "dispatching" &&
			value.status !== "dispatched" &&
			value.status !== "resolved")
	) {
		return undefined;
	}
	const decision = value.decision === undefined ? undefined : parseDecision(value.decision);
	const resolution = value.resolution === undefined ? undefined : parseResolution(value.resolution);
	if (value.decision !== undefined && !decision) return undefined;
	if (value.resolution !== undefined && !resolution) return undefined;
	return {
		schemaVersion: 1,
		request,
		status: value.status,
		decision,
		decisionFingerprint: typeof value.decisionFingerprint === "string" ? value.decisionFingerprint : undefined,
		resolution,
		priorMarkdown: typeof value.priorMarkdown === "string" ? value.priorMarkdown : undefined,
		replacementMarkdown: typeof value.replacementMarkdown === "string" ? value.replacementMarkdown : undefined,
		replacementDigest: typeof value.replacementDigest === "string" ? value.replacementDigest : undefined,
		hostTurnOperationId: typeof value.hostTurnOperationId === "string" ? value.hostTurnOperationId : undefined,
		hostTurnSessionFile: typeof value.hostTurnSessionFile === "string" ? value.hostTurnSessionFile : undefined,
		contextCompacted: value.contextCompacted === true,
		preparationComplete: value.preparationComplete === true,
	};
}

export class PlanModeController {
	readonly #session: AgentSession;
	readonly #artifacts: PlanModeArtifacts;
	readonly #dispatchTurn: (input: PlanTurnDispatchInput) => Promise<boolean>;
	readonly #persistReviews: boolean;
	readonly #onModeChanged?: PlanModeControllerOptions["onModeChanged"];
	readonly #onReviewRequested?: PlanModeControllerOptions["onReviewRequested"];
	readonly #onReviewResolved?: PlanModeControllerOptions["onReviewResolved"];
	readonly #onSessionTransitionCommitted?: PlanModeControllerOptions["onSessionTransitionCommitted"];
	readonly #onWarning?: PlanModeControllerOptions["onWarning"];
	#state: RpcPlanModeState;
	#previousTools: string[] | undefined;
	#previousMountedTools: string[] | undefined;
	#previousModel: PreviousModelState | undefined;
	#pendingModel: PreviousModelState | undefined;
	#hasEntered = false;
	readonly #recoveredReviews = new Map<string, PlanReviewRecord>();
	readonly #reviewDecisionTails = new Map<string, Promise<void>>();
	#proposalSuspension: Promise<void> = Promise.resolve();

	constructor(options: PlanModeControllerOptions) {
		this.#session = options.session;
		this.#artifacts = options.artifacts;
		const configuredDispatch = options.dispatchTurn;
		this.#dispatchTurn = configuredDispatch
			? async input => await configuredDispatch(input)
			: async input => {
					await this.#session.followUpPreparedHostTurn(input.clientTurnId);
					return true;
				};
		this.#persistReviews = options.persistReviews !== false;
		this.#onModeChanged = options.onModeChanged;
		this.#onReviewRequested = options.onReviewRequested;
		this.#onReviewResolved = options.onReviewResolved;
		this.#onSessionTransitionCommitted = options.onSessionTransitionCommitted;
		this.#onWarning = options.onWarning;
		this.#state = parseModeState(options.session.sessionManager);
		this.#hasEntered = this.#state.reentry;
		this.#previousModel = parsePreviousModelState(options.session);
	}

	get state(): RpcPlanModeState {
		return { ...this.#state };
	}

	get previousTools(): readonly string[] | undefined {
		return this.#previousTools;
	}

	get previousModelState(): PreviousModelState | undefined {
		return this.#previousModel;
	}

	/** Re-read persisted mode after an in-process session switch or rollback. */
	synchronizeFromSession(): RpcPlanModeState {
		this.#state = parseModeState(this.#session.sessionManager);
		this.#previousTools = undefined;
		this.#previousMountedTools = undefined;
		this.#previousModel = parsePreviousModelState(this.#session);
		this.#pendingModel = undefined;
		this.#hasEntered = this.#state.reentry;
		return this.state;
	}

	/** Promote the reviewed artifact without discarding the active plan runtime snapshot. */
	async promotePlanArtifact(planFilePath: string): Promise<RpcPlanModeState> {
		const liveState = this.#session.getPlanModeState();
		if (!liveState?.enabled) return this.state;
		const workflow = liveState.workflow ?? this.#state.workflow ?? "parallel";
		const reentry = liveState.reentry ?? this.#state.reentry;
		if (liveState.planFilePath === planFilePath && this.#state.planFilePath === planFilePath) return this.state;
		this.#state = { status: "active", planFilePath, workflow, reentry };
		this.#session.setPlanModeState({ enabled: true, planFilePath, workflow, reentry });
		this.#session.sessionManager.appendModeChange("plan", {
			planFilePath,
			workflow,
			reentry,
			...(this.#previousModel ? { previousModel: serializePreviousModelState(this.#previousModel) } : {}),
		});
		await this.#onModeChanged?.(this.state);
		return this.state;
	}

	/** Remove source-session plan runtime before AgentSession changes its backing session. */
	async prepareSessionTransition(): Promise<RpcPlanModeState> {
		const source = this.state;
		if (this.#state.status === "active") {
			await this.#leave(false, false, true, false);
		} else {
			this.#session.setPlanModeState(undefined);
			this.#session.setPlanProposalHandler(null);
			this.#previousTools = undefined;
			this.#previousMountedTools = undefined;
			this.#previousModel = undefined;
			this.#pendingModel = undefined;
			this.#state = { status: "off", reentry: false };
			this.#hasEntered = source.reentry || source.status !== "off";
		}
		await this.#onModeChanged?.(this.state);
		return source;
	}

	/** Fully apply persisted target state, or an explicit source snapshot during rollback. */
	async reconcileSessionTransition(options?: {
		state?: RpcPlanModeState;
		persistModeChange?: boolean;
	}): Promise<RpcPlanModeState> {
		const restored = options?.state ?? parseModeState(this.#session.sessionManager);
		const persistModeChange = options?.persistModeChange === true;
		if (this.#state.status === "active") {
			await this.#leave(false, false, false, false);
		} else {
			this.#session.setPlanModeState(undefined);
			this.#session.setPlanProposalHandler(null);
			this.#previousTools = undefined;
			this.#previousMountedTools = undefined;
			this.#previousModel = undefined;
			this.#pendingModel = undefined;
		}
		this.#state = { status: "off", reentry: false };
		this.#hasEntered = restored.reentry;
		if (restored.status === "active") {
			await this.#enter({ planFilePath: restored.planFilePath, workflow: restored.workflow }, persistModeChange);
		} else if (restored.status === "paused") {
			this.#state = { ...restored };
			if (persistModeChange) {
				this.#session.sessionManager.appendModeChange("plan_paused", {
					planFilePath: restored.planFilePath,
					workflow: restored.workflow,
					reentry: restored.reentry,
				});
			}
		} else if (persistModeChange) {
			this.#session.sessionManager.appendModeChange("none");
		}
		await this.#onModeChanged?.(this.state);
		return this.state;
	}

	/** Clear a model restore intentionally deferred across plan compaction. */
	clearDeferredModelRestore(): void {
		this.#previousModel = undefined;
	}

	async setMode(input: {
		status: RpcPlanModeStatus;
		workflow?: RpcPlanWorkflow;
		planFilePath?: string;
		preserveRestoredModel?: boolean;
		deferModelRestore?: boolean;
		persistModeChange?: boolean;
		preserveReentry?: boolean;
	}): Promise<RpcPlanModeState> {
		const persistModeChange = input.persistModeChange !== false;
		if (input.status === "active") await this.#enter(input, persistModeChange);
		else
			await this.#leave(
				input.status === "paused",
				input.deferModelRestore === true,
				input.preserveReentry === true,
				persistModeChange,
			);
		await this.#onModeChanged?.(this.state);
		return this.state;
	}

	async #enter(
		input: {
			workflow?: RpcPlanWorkflow;
			planFilePath?: string;
			preserveRestoredModel?: boolean;
		},
		persistModeChange: boolean,
	): Promise<void> {
		const previousState = this.state;
		const workflow = input.workflow ?? this.#state.workflow ?? "parallel";
		const planFilePath = input.planFilePath ?? this.#state.planFilePath ?? "local://PLAN.md";
		const previousHasEntered = this.#hasEntered;
		const reentry =
			this.#state.status === "active" ? this.#state.reentry : previousHasEntered || this.#state.status !== "off";
		this.#hasEntered = true;
		const installRuntime = this.#state.status !== "active" || this.#previousTools === undefined;
		let previousTools: string[] | undefined;
		let previousMountedTools: string[] | undefined;
		let previousModel: { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined } | undefined;
		const previousPlanModeState = this.#session.getPlanModeState();
		// Plan mode state must be visible before Code Mode repartitions tools so
		// the top-level write transport remains available for plan approval.
		this.#session.setPlanModeState({ enabled: true, planFilePath, workflow, reentry });
		if (installRuntime) {
			previousTools = this.#session.getEnabledToolNames();
			previousMountedTools = this.#session.getMountedXdevToolNames();
			previousModel = this.#session.model
				? { model: this.#session.model, thinkingLevel: this.#session.configuredThinkingLevel() }
				: undefined;
			this.#previousTools = previousTools;
			this.#previousMountedTools = previousMountedTools;
			const planTools = this.#session.hasBuiltInTool("write")
				? [...new Set([...previousTools, "write"])]
				: previousTools;
			try {
				await this.#session.setActiveToolsByName(planTools);
				if (!input.preserveRestoredModel) await this.#applyPlanModel();
			} catch (error) {
				this.#session.setPlanModeState(previousPlanModeState);
				try {
					await this.#session
						.setActiveToolPresentation(previousTools, previousMountedTools)
						.catch(restoreError =>
							this.#onWarning?.(`Failed to restore tools after plan entry failed: ${String(restoreError)}`),
						);
					if (previousModel) {
						await this.#restoreModel(previousModel).catch(restoreError =>
							this.#onWarning?.(`Failed to restore the model after plan entry failed: ${String(restoreError)}`),
						);
					}
				} finally {
					this.#previousTools = undefined;
					this.#previousMountedTools = undefined;
					this.#previousModel = undefined;
					this.#pendingModel = undefined;
					this.#hasEntered = previousHasEntered;
				}
				throw error;
			}
		}
		try {
			this.#session.setPlanProposalHandler(async title => {
				const request = await this.createReview({ title });
				return {
					content: [{ type: "text", text: "Plan ready for review." }],
					details: { planFilePath: request.path, title: request.title, planExists: true },
				};
			});
			if (this.#session.isStreaming) await this.#session.sendPlanModeContext({ deliverAs: "steer" });
		} catch (error) {
			if (previousState.status === "active") {
				this.#session.setPlanModeState({
					enabled: true,
					planFilePath: previousState.planFilePath ?? "local://PLAN.md",
					workflow: previousState.workflow,
					reentry: previousState.reentry,
				});
			} else {
				this.#session.setPlanModeState(undefined);
				this.#session.setPlanProposalHandler(null);
				if (installRuntime && previousTools && previousMountedTools) {
					await this.#session
						.setActiveToolPresentation(previousTools, previousMountedTools)
						.catch(restoreError =>
							this.#onWarning?.(`Failed to restore tools after plan entry failed: ${String(restoreError)}`),
						);
					if (previousModel) {
						await this.#restoreModel(previousModel).catch(restoreError =>
							this.#onWarning?.(`Failed to restore the model after plan entry failed: ${String(restoreError)}`),
						);
					}
					this.#previousTools = undefined;
					this.#previousMountedTools = undefined;
					this.#previousModel = undefined;
					this.#pendingModel = undefined;
				}
				this.#hasEntered = previousHasEntered;
			}
			throw error;
		}
		this.#state = { status: "active", planFilePath, workflow, reentry };
		if (persistModeChange) {
			this.#session.sessionManager.appendModeChange("plan", {
				planFilePath,
				workflow,
				reentry,
				...(this.#previousModel ? { previousModel: serializePreviousModelState(this.#previousModel) } : {}),
			});
		}
	}

	#suspendProposalTurn(): void {
		this.#session.markPlanInternalAbortPending();
		this.#proposalSuspension = this.#session
			.abort()
			.catch(error => this.#onWarning?.(`Failed to stop the plan proposal turn: ${String(error)}`))
			.finally(() => this.#session.clearPlanInternalAbortPending());
	}

	async #leave(
		paused: boolean,
		deferModelRestore: boolean,
		preserveReentry: boolean,
		persistModeChange: boolean,
	): Promise<void> {
		const previous = this.#state;
		if (this.#state.status === "active") {
			const activePlanState = this.#session.getPlanModeState();
			const activePlanTools = this.#session.getEnabledToolNames();
			const activeMountedTools = this.#session.getMountedXdevToolNames();
			this.#session.setPlanModeState(undefined);
			try {
				if (this.#previousTools) {
					await this.#session.setActiveToolPresentation(this.#previousTools, this.#previousMountedTools ?? []);
				}
				// Preserve a streaming restore deferred by #restoreModel; only discard
				// plan-entry deferred switches when we are not restoring previous.
				if (this.#previousModel && !deferModelRestore) {
					// Drop any pending plan-role switch before restore; #restoreModel may
					// re-queue the previous (execution) model when still streaming.
					this.#pendingModel = undefined;
					await this.#restoreModel(this.#previousModel);
				} else {
					this.#pendingModel = undefined;
				}
			} catch (error) {
				this.#session.setPlanModeState(activePlanState);
				await this.#session.setActiveToolPresentation(activePlanTools, activeMountedTools).catch(() => undefined);
				await this.#applyPlanModel(true).catch(() => undefined);
				throw error;
			}
			this.#session.setPlanProposalHandler(null);
		} else {
			// Not active: still drop stale plan-entry deferred switches.
			this.#pendingModel = undefined;
		}
		this.#state = paused
			? {
					status: "paused",
					planFilePath: previous.planFilePath,
					workflow: previous.workflow ?? "parallel",
					reentry: true,
				}
			: { status: "off", reentry: false };
		this.#hasEntered = paused || preserveReentry;
		this.#previousTools = undefined;
		this.#previousMountedTools = undefined;
		if (!deferModelRestore) this.#previousModel = undefined;
		if (persistModeChange) {
			const modeData = paused
				? {
						planFilePath: this.#state.planFilePath,
						workflow: this.#state.workflow,
						reentry: this.#state.reentry,
					}
				: undefined;
			this.#session.sessionManager.appendModeChange(paused ? "plan_paused" : "none", modeData);
		}
	}

	async #applyPlanModel(preservePrevious = false): Promise<void> {
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		if (this.#session.model && !preservePrevious) {
			this.#previousModel = {
				model: this.#session.model,
				thinkingLevel: this.#session.configuredThinkingLevel(),
			};
		}
		const transition = resolvePlanModelTransition(this.#session.model, resolved, this.#session.isStreaming);
		if (transition.kind === "thinking") {
			this.#session.setThinkingLevel(transition.thinkingLevel);
		} else if (transition.kind === "apply") {
			if (transition.deferred)
				this.#pendingModel = { model: transition.model, thinkingLevel: transition.thinkingLevel };
			else await this.#session.setModelTemporary(transition.model, transition.thinkingLevel);
		}
	}

	async reapplyPlanModel(): Promise<void> {
		if (this.#state.status !== "active") return;
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) {
			this.#pendingModel = undefined;
			return;
		}
		const transition = resolvePlanModelTransition(this.#session.model, resolved, this.#session.isStreaming);
		if (transition.kind === "none") {
			this.#pendingModel = undefined;
		} else if (transition.kind === "thinking") {
			this.#pendingModel = undefined;
			this.#session.setThinkingLevel(transition.thinkingLevel);
		} else if (transition.deferred) {
			this.#pendingModel = { model: transition.model, thinkingLevel: transition.thinkingLevel };
		} else {
			this.#pendingModel = undefined;
			await this.#session.setModelTemporary(transition.model, transition.thinkingLevel);
		}
	}

	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModel;
		this.#pendingModel = undefined;
		if (pending) await this.#session.setModelTemporary(pending.model, pending.thinkingLevel);
	}

	async #restoreModel(previous: PreviousModelState): Promise<void> {
		if (this.#session.model?.provider === previous.model.provider && this.#session.model.id === previous.model.id) {
			this.#session.setThinkingLevel(previous.thinkingLevel);
		} else if (this.#session.isStreaming) {
			this.#pendingModel = previous;
		} else {
			await this.#session.setModelTemporary(previous.model, previous.thinkingLevel);
		}
	}

	getPendingReviewSummaries(): Array<{
		id: string;
		title: string;
		path: string;
		status: "pending" | "dispatching";
	}> {
		const latestById = new Map<string, PlanReviewRecord>();
		for (const record of this.#reviewRecords()) latestById.set(record.request.id, record);
		const summaries: Array<{
			id: string;
			title: string;
			path: string;
			status: "pending" | "dispatching";
		}> = [];
		for (const record of latestById.values()) {
			if (record.status !== "pending" && record.status !== "dispatching") continue;
			if (record.status === "dispatching" && record.resolution) continue;
			summaries.push({
				id: record.request.id,
				title: record.request.title,
				path: record.request.path,
				status: record.status,
			});
		}
		return summaries;
	}

	async createReview(input: { title?: string }): Promise<RpcPlanReviewRequest> {
		if (this.#state.status !== "active") throw new Error("Plan mode is not active");
		const resolved = await resolveApprovedPlan({
			suppliedTitle: input.title,
			statePlanFilePath: this.#state.planFilePath ?? "local://PLAN.md",
			readPlan: path => this.#artifacts.read(path),
			listPlanFiles: () => this.#artifacts.list(),
		});
		const path = resolved.planFilePath;
		const markdown = resolved.planContent;
		const title = resolved.title;
		const availableModels = this.#session.getAvailableModels();
		const executionModels = availableModels.map(model => ({
			provider: model.provider,
			modelId: model.id,
		}));
		const currentModel = this.#session.model;
		const previousModel = this.#previousModel?.model;
		const previousModelIsSelectable =
			previousModel !== undefined &&
			((currentModel?.provider === previousModel.provider && currentModel.id === previousModel.id) ||
				availableModels.some(model => model.provider === previousModel.provider && model.id === previousModel.id));
		const defaultModel = previousModelIsSelectable ? previousModel : (currentModel ?? availableModels[0]);
		const defaultThinkingLevel = previousModelIsSelectable
			? this.#previousModel?.thinkingLevel
			: this.#session.configuredThinkingLevel();
		const defaultExecutionModel = defaultModel
			? {
					provider: defaultModel.provider,
					modelId: defaultModel.id,
					...(defaultThinkingLevel !== undefined ? { thinkingLevel: String(defaultThinkingLevel) } : {}),
				}
			: undefined;
		const request: RpcPlanReviewRequest = {
			id: Bun.randomUUIDv7(),
			title,
			path,
			markdown,
			planDigest: markdownDigest(markdown),
			allowedContextStrategies: ["fresh", "preserve", "compact"],
			contextUsage: this.#session.getContextUsage(),
			executionModels,
			defaultExecutionModel,
			workflow: this.#state.workflow ?? "parallel",
		};
		if (this.#persistReviews) {
			this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
				schemaVersion: 1,
				request,
				status: "pending",
			} satisfies PlanReviewRecord);
		}
		await this.#onReviewRequested?.(request);
		if (this.#persistReviews) this.#suspendProposalTurn();
		return request;
	}

	#reviewRecords(manager: SessionManager = this.#session.sessionManager): PlanReviewRecord[] {
		const records: PlanReviewRecord[] = [];
		for (const entry of manager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PLAN_REVIEW_CUSTOM_TYPE) continue;
			const record = parseReviewRecord(entry.data);
			if (record) records.push(record);
		}
		return records;
	}

	#latestReview(requestId: string): PlanReviewRecord | undefined {
		const records = this.#reviewRecords();
		for (let index = records.length - 1; index >= 0; index--) {
			if (records[index]?.request.id === requestId) return records[index];
		}
		return this.#recoveredReviews.get(requestId);
	}

	#pendingReviews(manager: SessionManager): PlanReviewRecord[] {
		const latestById = new Map<string, PlanReviewRecord>();
		for (const record of this.#reviewRecords(manager)) latestById.set(record.request.id, record);
		return [...latestById.values()].filter(
			record =>
				record.status === "pending" ||
				record.status === "dispatching" ||
				(record.status === "dispatched" && record.resolution !== undefined),
		);
	}

	async #locatePendingReviews(): Promise<Array<{ record: PlanReviewRecord; sessionFile: string | undefined }>> {
		const currentManager = this.#session.sessionManager;
		const located: Array<{ record: PlanReviewRecord; sessionFile: string | undefined }> = [];
		const currentSessionFile = currentManager.getSessionFile();
		located.push(
			...this.#pendingReviews(currentManager).map(record => ({ record, sessionFile: currentSessionFile })),
		);
		const visited = new Set<string>();
		if (currentSessionFile) visited.add(currentSessionFile);
		let parentSession = currentManager.getHeader()?.parentSession;
		while (parentSession && !visited.has(parentSession) && currentManager.sessionFileExists(parentSession)) {
			visited.add(parentSession);
			const parentManager = await currentManager.openSiblingSession(parentSession);
			try {
				const sessionFile = parentManager.getSessionFile();
				if (sessionFile) visited.add(sessionFile);
				located.push(...this.#pendingReviews(parentManager).map(record => ({ record, sessionFile })));
				parentSession = parentManager.getHeader()?.parentSession;
			} finally {
				await parentManager.close();
			}
		}
		return located;
	}

	/** Replay every outstanding pending/dispatching plan review after reconnect. */
	async recoverPendingReviews(): Promise<RpcPlanReviewRequest[]> {
		const located = await this.#locatePendingReviews();
		const recovered: RpcPlanReviewRequest[] = [];
		for (const entry of located) {
			const liveManager = this.#session.sessionManager;
			const liveSessionFile = liveManager.getSessionFile();
			const manager =
				entry.sessionFile && entry.sessionFile !== liveSessionFile
					? await liveManager.openSiblingSession(entry.sessionFile)
					: liveManager;
			const latest = this.#pendingReviews(manager).find(record => record.request.id === entry.record.request.id);
			if (!latest) {
				if (manager !== liveManager) await manager.close();
				continue;
			}
			const request = await this.#recoverOnePendingReview({
				record: latest,
				manager,
				closeManager: manager !== liveManager,
			});
			if (request) recovered.push(request);
		}
		return recovered;
	}

	/** @deprecated Prefer recoverPendingReviews — recovers only the first outstanding review. */
	async recoverPendingReview(): Promise<RpcPlanReviewRequest | undefined> {
		const recovered = await this.recoverPendingReviews();
		return recovered[0];
	}

	async #recoverOnePendingReview(located: {
		record: PlanReviewRecord;
		manager: SessionManager;
		closeManager: boolean;
	}): Promise<RpcPlanReviewRequest | undefined> {
		let pending = located.record;
		let reviewManager = located.manager;
		let closeReviewManager = located.closeManager;
		try {
			if (pending.status === "dispatched" && pending.resolution) {
				await this.#onReviewResolved?.(pending.resolution);
				const resolved = { ...pending, status: "resolved" } satisfies PlanReviewRecord;
				await reviewManager.appendEntriesAtomically(() => {
					reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, resolved);
				});
				this.#recoveredReviews.set(resolved.request.id, resolved);
				return undefined;
			}
			if (pending.status === "dispatching") {
				const decision = pending.decision;
				const expectedKind = decision?.action === "execute" ? "plan_execute" : "plan_refine";
				const operationSessionFile = pending.hostTurnSessionFile;
				let operation = this.#session.sessionManager
					.getHostTurnOperations()
					.find(candidate =>
						pending.hostTurnOperationId
							? candidate.operationId === pending.hostTurnOperationId
							: candidate.clientTurnId ===
								(decision && "clientTurnId" in decision ? decision.clientTurnId : undefined),
					);
				if (!operation && operationSessionFile) {
					const reviewSessionFile = reviewManager.getSessionFile();
					const operationManager =
						operationSessionFile === reviewSessionFile
							? reviewManager
							: await reviewManager.openSiblingSession(operationSessionFile);
					try {
						operation = operationManager
							.getHostTurnOperations()
							.find(candidate => candidate.operationId === pending.hostTurnOperationId);
					} finally {
						if (operationManager !== reviewManager) await operationManager.close();
					}
				}
				if (!operation || !decision || decision.action === "cancel") {
					const reviewSessionFile = reviewManager.getSessionFile();
					if (reviewSessionFile && reviewSessionFile !== this.#session.sessionManager.getSessionFile()) {
						await reviewManager.close();
						closeReviewManager = false;
						const switched = await this.#session.switchSession(reviewSessionFile);
						if (!switched)
							throw new Error(`Plan review ${pending.request.id} source session recovery was cancelled`);
						this.synchronizeFromSession();
						reviewManager = this.#session.sessionManager;
					}
					if (pending.priorMarkdown !== undefined) {
						await this.#artifacts.write(pending.request.path, pending.priorMarkdown);
					}
					const reset: PlanReviewRecord = {
						schemaVersion: 1,
						request: pending.request,
						status: "pending",
						...(pending.contextCompacted ? { contextCompacted: true } : {}),
					};
					await reviewManager.appendEntriesAtomically(() => {
						reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, reset);
					});
					this.#recoveredReviews.set(reset.request.id, reset);
					await this.#onReviewRequested?.(reset.request);
					return reset.request;
				}
				if (
					operation.clientTurnId !== ("clientTurnId" in decision ? decision.clientTurnId : undefined) ||
					operation.kind !== expectedKind
				) {
					throw new Error(`Plan review ${pending.request.id} host-turn association conflicts with durable state`);
				}

				const targetSessionFile = operationSessionFile ?? operation.lineage.sessionFile;
				if (
					pending.hostTurnOperationId !== operation.operationId ||
					pending.hostTurnSessionFile !== targetSessionFile
				) {
					const associated = {
						...pending,
						hostTurnOperationId: operation.operationId,
						hostTurnSessionFile: targetSessionFile,
					} satisfies PlanReviewRecord;
					await reviewManager.appendEntriesAtomically(() => {
						reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, associated);
					});
					pending = associated;
				}
				if (targetSessionFile && targetSessionFile !== this.#session.sessionManager.getSessionFile()) {
					if (reviewManager === this.#session.sessionManager) {
						reviewManager = reviewManager.cloneCurrentSession();
						closeReviewManager = true;
					}
					const operationId = operation.operationId;
					const switched = await this.#session.switchSession(targetSessionFile);
					if (!switched)
						throw new Error(`Plan review ${pending.request.id} execution session recovery was cancelled`);
					this.synchronizeFromSession();
					if (
						reviewManager !== this.#session.sessionManager &&
						reviewManager.getSessionFile() === targetSessionFile
					) {
						await reviewManager.close();
						closeReviewManager = false;
						reviewManager = this.#session.sessionManager;
					}
					operation = this.#session.sessionManager
						.getHostTurnOperations()
						.find(candidate => candidate.operationId === operationId);
					if (!operation) throw new Error(`Plan review ${pending.request.id} lost its child host-turn operation`);
				}

				if (operation.status === "settled" && operation.outcome && operation.outcome !== "completed") {
					const resolution: RpcPlanReviewResolution = {
						id: pending.request.id,
						outcome: operation.outcome === "cancelled" ? "cancelled" : "aborted",
						clientTurnId: decision.clientTurnId,
						resume: this.state,
					};
					const resolved = { ...pending, status: "resolved", resolution } satisfies PlanReviewRecord;
					await reviewManager.appendEntriesAtomically(() => {
						reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, resolved);
					});
					this.#recoveredReviews.set(resolved.request.id, resolved);
					await this.#onReviewResolved?.(resolution);
					return undefined;
				}
				// Staleness is only meaningful while the host turn is still prepared.
				// Once dispatched/settled, the durable execution already ran — plan
				// edits after promotion must not rewrite the outcome to "stale".
				const expectedDigest = pending.replacementDigest ?? pending.request.planDigest;
				if (operation.status === "prepared") {
					const markdown = await this.#artifacts.read(pending.request.path);
					if (markdown === null || markdownDigest(markdown) !== expectedDigest) {
						const resolution: RpcPlanReviewResolution = {
							id: pending.request.id,
							outcome: "stale",
							resume: this.state,
						};
						const resolved = { ...pending, status: "resolved", resolution } satisfies PlanReviewRecord;
						await reviewManager.appendEntriesAtomically(() => {
							reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, resolved);
						});
						this.#recoveredReviews.set(resolved.request.id, resolved);
						this.#onWarning?.("The pending plan changed on disk and must be proposed again.");
						await this.#onReviewResolved?.(resolution);
						return undefined;
					}
					const resolvedExecutionModel = this.#resolveDecisionExecutionModel(pending.request, decision);
					let contextCompacted = pending.contextCompacted === true;
					if (decision.action === "execute" && decision.context === "fresh") {
						await this.#installExecutionRuntime(pending.request, resolvedExecutionModel);
					} else {
						await this.#prepareTurn(pending.request, markdown, decision, resolvedExecutionModel, {
							alreadyCompacted: pending.preparationComplete === true || contextCompacted,
							onCompacted: async () => {
								contextCompacted = true;
								const checkpoint = { ...pending, contextCompacted: true } satisfies PlanReviewRecord;
								await reviewManager.appendEntriesAtomically(() => {
									reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, checkpoint);
								});
								pending = checkpoint;
							},
						});
					}
					if (pending.preparationComplete !== true) {
						const prepared = {
							...pending,
							preparationComplete: true,
							contextCompacted: contextCompacted || undefined,
						} satisfies PlanReviewRecord;
						await reviewManager.appendEntriesAtomically(() => {
							reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, prepared);
						});
						pending = prepared;
					}
					const payload = isRecord(operation.payload) ? operation.payload : undefined;
					const turnPrompt = typeof payload?.text === "string" ? payload.text : undefined;
					if (!turnPrompt)
						throw new Error(`Plan review ${pending.request.id} has no recoverable host-turn prompt`);
					const accepted = await this.#dispatchTurn({
						clientTurnId: decision.clientTurnId,
						kind: expectedKind,
						prompt: turnPrompt,
					});
					if (!accepted) throw new Error(`Plan review ${pending.request.id} turn dispatch was rejected`);
					const operationId = operation.operationId;
					operation =
						this.#session.sessionManager
							.getHostTurnOperations()
							.find(candidate => candidate.operationId === operationId) ?? operation;
				}
				const resolution: RpcPlanReviewResolution = pending.resolution ?? {
					id: pending.request.id,
					outcome: decision.action === "execute" ? "executing" : "refining",
					clientTurnId: decision.clientTurnId,
					resume: this.state,
					planDigest: expectedDigest,
				};
				const recovered = {
					...pending,
					status: operation.status === "prepared" ? "dispatching" : "dispatched",
					resolution,
				} satisfies PlanReviewRecord;
				await reviewManager.appendEntriesAtomically(() => {
					reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, recovered);
				});
				this.#recoveredReviews.set(recovered.request.id, recovered);
				await this.#onReviewResolved?.(resolution);
				return undefined;
			}
			const reviewSessionFile = reviewManager.getSessionFile();
			if (reviewSessionFile && reviewSessionFile !== this.#session.sessionManager.getSessionFile()) {
				await reviewManager.close();
				closeReviewManager = false;
				const switched = await this.#session.switchSession(reviewSessionFile);
				if (!switched) throw new Error(`Plan review ${pending.request.id} source session recovery was cancelled`);
				this.synchronizeFromSession();
				reviewManager = this.#session.sessionManager;
			}

			const markdown = await this.#artifacts.read(pending.request.path);
			const expectedDigest = pending.replacementDigest ?? pending.request.planDigest;
			if (markdown === null || markdownDigest(markdown) !== expectedDigest) {
				const resolution: RpcPlanReviewResolution = {
					id: pending.request.id,
					outcome: "stale",
					resume: this.state,
				};
				this.#appendResolved(pending, resolution);
				this.#onWarning?.("The pending plan changed on disk and must be proposed again.");
				await this.#onReviewResolved?.(resolution);
				return undefined;
			}
			await this.#onReviewRequested?.(pending.request);
			return pending.request;
		} finally {
			if (closeReviewManager) await reviewManager.close();
		}
	}

	async respondToReview(input: {
		requestId: string;
		decision: RpcPlanReviewDecision;
	}): Promise<RpcPlanReviewResolution> {
		const previous = this.#reviewDecisionTails.get(input.requestId) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const current = previous.then(() => release.promise);
		this.#reviewDecisionTails.set(input.requestId, current);
		await previous;
		await this.#proposalSuspension;
		try {
			return await this.#respondToReviewUnlocked(input);
		} finally {
			release.resolve();
			if (this.#reviewDecisionTails.get(input.requestId) === current)
				this.#reviewDecisionTails.delete(input.requestId);
		}
	}

	async #respondToReviewUnlocked(input: {
		requestId: string;
		decision: RpcPlanReviewDecision;
	}): Promise<RpcPlanReviewResolution> {
		const decision =
			input.decision.action === "cancel"
				? input.decision
				: { ...input.decision, clientTurnId: input.decision.clientTurnId.trim() };
		if (decision.action !== "cancel" && decision.clientTurnId.length === 0) {
			throw new Error("Plan review clientTurnId must not be empty");
		}
		const record = this.#latestReview(input.requestId);
		if (!record) throw new Error(`Unknown plan review ${input.requestId}`);
		const fingerprint = fingerprintHostTurnPayload(
			decision.action === "refine" ? "plan_refine" : "plan_execute",
			decision,
		);
		if (record.status === "resolved" || record.status === "dispatched") {
			if (record.decisionFingerprint !== fingerprint || !record.resolution) {
				throw new Error(`Plan review ${input.requestId} was already answered with different content`);
			}
			return record.resolution;
		}
		if (record.status === "dispatching") {
			if (record.decisionFingerprint !== fingerprint) {
				throw new Error(`Plan review ${input.requestId} is dispatching different content`);
			}
			const latest = this.#latestReview(input.requestId);
			if (latest?.resolution) return latest.resolution;
			throw new Error(`Plan review ${input.requestId} is already dispatching`);
		}

		if (decision.action === "cancel") {
			const resolution: RpcPlanReviewResolution = {
				id: record.request.id,
				outcome: "cancelled",
				resume: this.state,
			};
			this.#appendResolved(record, resolution, decision, fingerprint);
			await this.#onReviewResolved?.(resolution);
			return resolution;
		}
		const pinnedPlan = this.#artifacts.pin?.(record.request.path);
		const currentMarkdown = pinnedPlan ? await pinnedPlan.read() : await this.#artifacts.read(record.request.path);
		if (currentMarkdown === null || markdownDigest(currentMarkdown) !== record.request.planDigest) {
			const resolution: RpcPlanReviewResolution = { id: record.request.id, outcome: "stale", resume: this.state };
			this.#appendResolved(record, resolution, decision, fingerprint);
			await this.#onReviewResolved?.(resolution);
			return resolution;
		}

		const resolvedExecutionModel = this.#resolveDecisionExecutionModel(record.request, decision);
		const replacement = decision.replacementPlanMarkdown;
		const effectiveMarkdown = replacement ?? currentMarkdown;
		const kind: Extract<HostTurnKind, "plan_execute" | "plan_refine"> =
			decision.action === "execute" ? "plan_execute" : "plan_refine";
		const turnPrompt = this.#renderTurnPrompt(record.request, decision);
		const freshContext = decision.action === "execute" && decision.context === "fresh";
		let operation: HostTurnOperation | undefined;
		const sourcePlanState = this.state;
		let sourceSessionManager: SessionManager | undefined;
		let dispatchingPersisted = false;
		let contextCompacted = record.contextCompacted === true;
		try {
			if (replacement !== undefined) {
				await this.#session.sessionManager.appendEntriesAtomically(() => {
					this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
						...record,
						status: "dispatching",
						decision,
						decisionFingerprint: fingerprint,
						priorMarkdown: currentMarkdown,
						replacementMarkdown: replacement,
						replacementDigest: markdownDigest(replacement),
						preparationComplete: false,
					} satisfies PlanReviewRecord);
				});
				dispatchingPersisted = true;
				if (pinnedPlan) await pinnedPlan.write(replacement);
				else await this.#artifacts.write(record.request.path, replacement);
			}

			if (freshContext && !dispatchingPersisted) {
				this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
					...record,
					status: "dispatching",
					decision,
					decisionFingerprint: fingerprint,
					preparationComplete: false,
				} satisfies PlanReviewRecord);
				dispatchingPersisted = true;
			} else if (!freshContext) {
				operation = await this.#session.sessionManager.appendEntriesAtomically(() => {
					const prepared = this.#session.sessionManager.recordPreparedHostTurnOperation({
						clientTurnId: decision.clientTurnId,
						kind,
						payload: {
							text: turnPrompt,
							synthetic: true,
							attribution: undefined,
							images: undefined,
							model: this.#session.model
								? { provider: this.#session.model.provider, id: this.#session.model.id }
								: undefined,
							thinkingLevel: this.#session.configuredThinkingLevel(),
						},
					});
					this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
						...record,
						status: "dispatching",
						decision,
						decisionFingerprint: fingerprint,
						priorMarkdown: replacement === undefined ? undefined : currentMarkdown,
						replacementMarkdown: replacement,
						replacementDigest: replacement === undefined ? undefined : markdownDigest(replacement),
						hostTurnOperationId: prepared.operationId,
						preparationComplete: false,
					} satisfies PlanReviewRecord);
					return prepared;
				});
				dispatchingPersisted = true;
			}

			await this.#prepareTurn(record.request, effectiveMarkdown, decision, resolvedExecutionModel, {
				alreadyCompacted: contextCompacted,
				onCompacted: async () => {
					contextCompacted = true;
					if (!operation) throw new Error(`Plan review ${record.request.id} lost its compact host turn`);
					const compactOperation = operation;
					await this.#session.sessionManager.appendEntriesAtomically(() => {
						this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
							...record,
							status: "dispatching",
							decision,
							decisionFingerprint: fingerprint,
							priorMarkdown: replacement === undefined ? undefined : currentMarkdown,
							replacementMarkdown: replacement,
							replacementDigest: replacement === undefined ? undefined : markdownDigest(replacement),
							hostTurnOperationId: compactOperation.operationId,
							contextCompacted: true,
							preparationComplete: false,
						} satisfies PlanReviewRecord);
					});
				},
				beforeFreshSessionSwitch: freshContext
					? () => {
							sourceSessionManager = this.#session.sessionManager.cloneCurrentSession({ persist: true });
						}
					: undefined,
			});
			if (!freshContext && operation) {
				this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
					...record,
					status: "dispatching",
					decision,
					decisionFingerprint: fingerprint,
					priorMarkdown: replacement === undefined ? undefined : currentMarkdown,
					replacementMarkdown: replacement,
					replacementDigest: replacement === undefined ? undefined : markdownDigest(replacement),
					hostTurnOperationId: operation.operationId,
					preparationComplete: true,
					contextCompacted: contextCompacted || undefined,
				} satisfies PlanReviewRecord);
			}
			if (freshContext) {
				operation = await this.#session.sessionManager.appendEntriesAtomically(() =>
					this.#session.sessionManager.recordPreparedHostTurnOperation({
						clientTurnId: decision.clientTurnId,
						kind,
						payload: {
							text: turnPrompt,
							synthetic: true,
							attribution: undefined,
							images: undefined,
							model: this.#session.model
								? { provider: this.#session.model.provider, id: this.#session.model.id }
								: undefined,
							thinkingLevel: this.#session.configuredThinkingLevel(),
						},
					}),
				);
				const sourceJournal = sourceSessionManager;
				const childOperation = operation;
				if (!sourceJournal || !childOperation) {
					throw new Error(`Plan review ${record.request.id} lost its source session journal`);
				}
				await sourceJournal.appendEntriesAtomically(() => {
					sourceJournal.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
						...record,
						status: "dispatching",
						decision,
						decisionFingerprint: fingerprint,
						priorMarkdown: replacement === undefined ? undefined : currentMarkdown,
						replacementMarkdown: replacement,
						replacementDigest: replacement === undefined ? undefined : markdownDigest(replacement),
						hostTurnOperationId: childOperation.operationId,
						hostTurnSessionFile: childOperation.lineage.sessionFile,
						preparationComplete: true,
					} satisfies PlanReviewRecord);
				});
			}
		} catch (error) {
			if (operation?.status === "prepared") {
				await this.#session.sessionManager
					.cancelPreparedHostTurnOperation({
						clientTurnId: operation.clientTurnId,
						payloadFingerprint: operation.payloadFingerprint,
						outcome: "cancelled",
					})
					.catch(cancelError => this.#onWarning?.(`Failed to cancel prepared plan turn: ${String(cancelError)}`));
			}
			if (dispatchingPersisted) {
				const reviewManager = freshContext
					? (sourceSessionManager ?? this.#session.sessionManager)
					: this.#session.sessionManager;
				await reviewManager.appendEntriesAtomically(() => {
					reviewManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
						...record,
						status: "pending",
						decision: undefined,
						decisionFingerprint: undefined,
						resolution: undefined,
						priorMarkdown: undefined,
						replacementMarkdown: undefined,
						replacementDigest: undefined,
						hostTurnOperationId: undefined,
						hostTurnSessionFile: undefined,
						contextCompacted: contextCompacted || undefined,
					} satisfies PlanReviewRecord);
				});
			}
			let rollbackError: unknown;
			try {
				if (replacement !== undefined) {
					if (pinnedPlan) await pinnedPlan.write(currentMarkdown);
					else await this.#artifacts.write(record.request.path, currentMarkdown);
				}
				if (sourceSessionManager) {
					await sourceSessionManager.ensureOnDisk();
					await sourceSessionManager.flush();
					const sourceSessionFile = sourceSessionManager.getSessionFile();
					if (sourceSessionFile) {
						const restored = await this.#session.switchSession(sourceSessionFile);
						if (!restored) throw new Error("Fresh-context source session restoration was cancelled");
					}
					await this.reconcileSessionTransition({ state: sourcePlanState, persistModeChange: true });
				} else if (sourcePlanState.status === "active") {
					// preserve/compact exit plan mode before fallible model/tool prep;
					// restore the captured active plan runtime so the host can retry.
					await this.reconcileSessionTransition({ state: sourcePlanState, persistModeChange: true });
				}
			} catch (rollback) {
				rollbackError = rollback;
			} finally {
				await sourceSessionManager?.close();
			}
			if (rollbackError !== undefined) {
				throw new AggregateError(
					[error, rollbackError],
					sourceSessionManager
						? "Fresh-context plan preparation failed and the source session could not be restored"
						: "Plan preparation failed and the active plan runtime could not be restored",
				);
			}
			throw error;
		}

		try {
			const accepted = await this.#dispatchTurn({ clientTurnId: decision.clientTurnId, kind, prompt: turnPrompt });
			if (!accepted) throw new Error(`Plan review ${record.request.id} turn dispatch was rejected`);
		} catch (error) {
			const current = this.#session.sessionManager
				.getHostTurnOperations()
				.find(candidate => candidate.clientTurnId === operation?.clientTurnId);
			if (current?.status === "dispatched") {
				await this.#session.sessionManager.settleHostTurnOperation({
					clientTurnId: current.clientTurnId,
					payloadFingerprint: current.payloadFingerprint,
					outcome: "failed",
				});
			}
			await sourceSessionManager?.close();
			throw error;
		}
		const operationId = operation?.operationId;
		if (operationId) {
			operation =
				this.#session.sessionManager
					.getHostTurnOperations()
					.find(candidate => candidate.operationId === operationId) ?? operation;
		}
		if (!operation) throw new Error(`Plan review ${record.request.id} did not prepare a host turn`);
		const resolution: RpcPlanReviewResolution = {
			id: record.request.id,
			outcome: decision.action === "execute" ? "executing" : "refining",
			clientTurnId: decision.clientTurnId,
			resume: this.state,
			planDigest: markdownDigest(effectiveMarkdown),
		};
		if (freshContext && !sourceSessionManager) {
			throw new Error(`Plan review ${record.request.id} lost its source session journal`);
		}
		const resolutionManager = sourceSessionManager ?? this.#session.sessionManager;
		const resolvedRecord = {
			...record,
			status: "dispatching",
			decision,
			decisionFingerprint: fingerprint,
			resolution,
			priorMarkdown: replacement === undefined ? undefined : currentMarkdown,
			replacementMarkdown: replacement,
			replacementDigest: replacement === undefined ? undefined : markdownDigest(replacement),
			hostTurnOperationId: operation.operationId,
			hostTurnSessionFile: operation.lineage.sessionFile,
			preparationComplete: true,
		} satisfies PlanReviewRecord;
		try {
			await resolutionManager.appendEntriesAtomically(() => {
				resolutionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, resolvedRecord);
			});
			// Fresh-context resolutions live in the source journal after the live
			// session has switched to the child; cache for no-restart idempotency.
			this.#recoveredReviews.set(resolvedRecord.request.id, resolvedRecord);
			await this.#onReviewResolved?.(resolution);
			return resolution;
		} finally {
			await sourceSessionManager?.close();
		}
	}

	#appendResolved(
		record: PlanReviewRecord,
		resolution: RpcPlanReviewResolution,
		decision?: RpcPlanReviewDecision,
		decisionFingerprint?: string,
	): void {
		this.#session.sessionManager.appendCustomEntry(PLAN_REVIEW_CUSTOM_TYPE, {
			...record,
			status: "resolved",
			decision,
			decisionFingerprint,
			resolution,
		} satisfies PlanReviewRecord);
	}

	#renderTurnPrompt(
		request: RpcPlanReviewRequest,
		decision: Exclude<RpcPlanReviewDecision, { action: "cancel" }>,
	): string {
		if (decision.action === "refine") {
			return prompt.render(planModeRefinePrompt, { planFilePath: request.path, feedback: decision.feedback });
		}
		return prompt.render(planModeApprovedPrompt, {
			planFilePath: request.path,
			contextPreserved: decision.context !== "fresh",
		});
	}

	async #prepareTurn(
		request: RpcPlanReviewRequest,
		markdown: string,
		decision: Exclude<RpcPlanReviewDecision, { action: "cancel" }>,
		executionModel: ResolvedExecutionModel | undefined,
		options?: {
			alreadyCompacted?: boolean;
			onCompacted?: () => void | Promise<void>;
			beforeFreshSessionSwitch?: () => void;
		},
	): Promise<void> {
		if (decision.action === "refine") {
			await this.setMode({
				status: "active",
				planFilePath: request.path,
				workflow: request.workflow,
			});
			return;
		}
		await this.setMode({ status: "off", preserveReentry: true });
		// Compaction may reconnect the agent and drain queued host/user messages in
		// its finally block. Restore execution-mode tools/model and select the approved
		// plan path before compacting so a drained turn can inject its reference.
		this.#session.setPlanReferencePath(request.path);
		if (decision.context === "compact" && !options?.alreadyCompacted) {
			this.#session.markPlanInternalAbortPending();
			try {
				const internalGuidance = prompt.render(planModeCompactInstructionsPrompt, { planFilePath: request.path });
				await this.#session.compact(undefined, { internalGuidance });
			} finally {
				this.#session.clearPlanInternalAbortPending();
			}
			await options?.onCompacted?.();
		}
		options?.beforeFreshSessionSwitch?.();
		if (decision.context === "fresh") {
			const localProtocolOptions = {
				getArtifactsDir: () => this.#session.sessionManager.getArtifactsDir(),
				getSessionId: () => this.#session.sessionManager.getSessionId(),
			};
			// Capture the full local artifact tree before the session identity changes so
			// supporting drafts/notes land in the child session (interactive parity).
			const sourceLocalRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
			const parentSession = this.#session.sessionFile;
			const switched = parentSession
				? await this.#session.newSession({ parentSession })
				: await this.#session.newSession();
			if (!switched) throw new Error("Fresh-context plan execution was cancelled");
			const destinationLocalRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
			await copyLocalArtifactTree(sourceLocalRoot, destinationLocalRoot);
			// Ensure the reviewed plan content wins over any stale copy from the tree.
			await this.#artifacts.write(request.path, markdown);
		}
		await this.#installExecutionRuntime(request, executionModel);
		if (decision.context === "fresh") await this.#onSessionTransitionCommitted?.();
	}

	async #installExecutionRuntime(
		request: RpcPlanReviewRequest,
		executionModel: ResolvedExecutionModel | undefined,
	): Promise<void> {
		if (executionModel) {
			const currentModel = this.#session.model;
			const alreadyActive =
				currentModel?.provider === executionModel.model.provider && currentModel.id === executionModel.model.id;
			if (executionModel.explicit || !alreadyActive) {
				await this.#session.setModelTemporary(executionModel.model, executionModel.thinkingLevel);
			} else if (executionModel.thinkingLevel !== undefined) {
				this.#session.setThinkingLevel(executionModel.thinkingLevel);
			}
		}
		const executionTools = this.#session.getEnabledToolNames();
		if (!executionTools.includes("read")) await this.#session.setActiveToolsByName([...executionTools, "read"]);
		this.#session.setPlanReferencePath(request.path);
		this.#session.markPlanReferenceSent();
	}

	#resolveDecisionExecutionModel(
		request: RpcPlanReviewRequest,
		decision: Exclude<RpcPlanReviewDecision, { action: "cancel" }>,
	): ResolvedExecutionModel | undefined {
		if (decision.action !== "execute") return undefined;
		const selection = decision.executionModel ?? request.defaultExecutionModel;
		if (!selection) return undefined;
		return { ...this.#resolveExecutionModel(selection), explicit: decision.executionModel !== undefined };
	}

	#resolveExecutionModel(selection: RpcPlanExecutionModel): ResolvedExecutionModel {
		const matches = (candidate: Model | undefined): candidate is Model =>
			candidate?.provider === selection.provider && candidate.id === selection.modelId;
		const model =
			this.#session.getAvailableModels().find(matches) ??
			(matches(this.#session.model) ? this.#session.model : undefined);
		if (!model) throw new Error(`Execution model ${selection.provider}/${selection.modelId} is unavailable`);
		const thinkingLevel =
			selection.thinkingLevel === undefined ? undefined : parseConfiguredThinkingLevel(selection.thinkingLevel);
		if (selection.thinkingLevel !== undefined && thinkingLevel === undefined) {
			throw new Error(`Unsupported thinking level ${selection.thinkingLevel}`);
		}
		if (thinkingLevel !== undefined) {
			const supportedEfforts = getSupportedEfforts(model);
			const unsupported =
				thinkingLevel === AUTO_THINKING
					? supportedEfforts.length === 0
					: thinkingLevel !== ThinkingLevel.Off &&
						(!supportedEfforts.includes(thinkingLevel as Effort) ||
							clampThinkingLevelToCeiling(model, thinkingLevel as Effort, this.#session.thinkingLevelCeiling) !==
								thinkingLevel);
			if (unsupported) {
				throw new Error(
					`Execution thinking level ${selection.thinkingLevel} is unsupported by ${model.provider}/${model.id}`,
				);
			}
		}
		return { model, thinkingLevel, explicit: false };
	}
}
