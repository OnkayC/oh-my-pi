import { afterEach, describe, expect, it, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionToolApprovalDecision,
	ExtensionToolApprovalRequest,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import {
	dispatchRpcControlFrame,
	RpcApprovalInteraction,
	type RpcInputFrameDeps,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcApprovalRequestFrame, RpcApprovalResolvedFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

function approvalEnvironment(args: unknown): string {
	if (!args || typeof args !== "object" || !("environment" in args)) return "unknown";
	return String(args.environment);
}

function createApprovalTool(
	execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
) {
	const tool: AgentTool = {
		name: "deploy",
		label: "Deploy",
		description: "Deploy the service",
		parameters: Type.Object({ environment: Type.String() }),
		approval: { tier: "exec", reason: "Production deployment" },
		formatApprovalDetails: args => [`Environment: ${approvalEnvironment(args)}`],
		execute,
	};
	return { tool, execute };
}

function createRunner(ui: Pick<ExtensionUIContext, "select" | "requestToolApproval">): ExtensionRunner {
	return {
		consumeToolCallEmitted: () => true,
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ui,
	} as unknown as ExtensionRunner;
}

function createToolContext(getSessionId: () => string): AgentToolContext {
	return {
		settings: Settings.isolated({ "tools.approvalMode": "write" }),
		sessionManager: { getSessionId },
	} as unknown as AgentToolContext;
}

afterEach(() => {
	vi.useRealTimers();
});

function createControlDeps(
	onApprovalResponse: NonNullable<RpcInputFrameDeps["onApprovalResponse"]>,
): RpcInputFrameDeps {
	return {
		handleCommand: async () => {
			throw new Error("No command expected");
		},
		output: () => {},
		errorResponse: (id, command, error) => ({ id, type: "response", command, success: false, error }),
		pendingExtensionRequests: new Map(),
		onApprovalResponse,
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
}

describe("structured tool approvals", () => {
	it("passes complete metadata and remembers approve_session only for the same session and tool", async () => {
		const requests: ExtensionToolApprovalRequest[] = [];
		const decisions: ExtensionToolApprovalDecision[] = ["approve_session", "approve_once"];
		const requestToolApproval = vi.fn(async (request: ExtensionToolApprovalRequest) => {
			requests.push(request);
			return decisions.shift() ?? "deny";
		});
		const ui = {
			select: vi.fn(async () => "Deny"),
			requestToolApproval,
		};
		const { tool, execute } = createApprovalTool();
		const wrapper = new ExtensionToolWrapper(tool, createRunner(ui));
		let sessionId = "session-a";
		const context = createToolContext(() => sessionId);

		await wrapper.execute("call-1", { environment: "production" }, undefined, undefined, context);
		await wrapper.execute("call-2", { environment: "production" }, undefined, undefined, context);
		sessionId = "session-b";
		await wrapper.execute("call-3", { environment: "production" }, undefined, undefined, context);

		expect(execute).toHaveBeenCalledTimes(3);
		expect(requestToolApproval).toHaveBeenCalledTimes(2);
		expect(requests).toEqual([
			{
				sessionId: "session-a",
				toolCallId: "call-1",
				toolName: "deploy",
				approvalMode: "write",
				tier: "exec",
				arguments: { environment: "production" },
				reason: "Production deployment",
				details: ["Environment: production"],
				providerSafetyChecks: [],
				allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
			},
			{
				sessionId: "session-b",
				toolCallId: "call-3",
				toolName: "deploy",
				approvalMode: "write",
				tier: "exec",
				arguments: { environment: "production" },
				reason: "Production deployment",
				details: ["Environment: production"],
				providerSafetyChecks: [],
				allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
			},
		]);
	});

	it("preserves provider safety metadata and never offers a session grant for safety checks", async () => {
		let captured: ExtensionToolApprovalRequest | undefined;
		const requestToolApproval = vi.fn(async (request: ExtensionToolApprovalRequest) => {
			captured = request;
			return "approve_once" as const;
		});
		const { tool, execute } = createApprovalTool();
		const wrapper = new ExtensionToolWrapper(
			tool,
			createRunner({ select: vi.fn(async () => "Deny"), requestToolApproval }),
		);
		const context = {
			settings: Settings.isolated({ "tools.approvalMode": "write" }),
			sessionManager: { getSessionId: () => "session-a" },
			toolCall: {
				providerMetadata: {
					type: "computer",
					actions: [{ type: "click", x: 12, y: 24 }],
					pendingSafetyChecks: [
						{ id: "safety-1", code: "external_side_effect", message: "Confirm external side effect" },
					],
				},
			},
		} as unknown as AgentToolContext;

		await wrapper.execute("call-safety", { environment: "production" }, undefined, undefined, context);

		expect(captured).toEqual({
			sessionId: "session-a",
			toolCallId: "call-safety",
			toolName: "deploy",
			approvalMode: "write",
			tier: "exec",
			arguments: { actions: [{ type: "click", x: 12, y: 24 }] },
			reason: "Production deployment",
			details: ["Environment: unknown"],
			providerSafetyChecks: ["Confirm external side effect"],
			allowedDecisions: ["approve_once", "deny", "cancel"],
		});
		expect(context.providerSafetyApproved).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it.each([
		["deny", "denied by user"],
		["cancel", "cancelled by user"],
	] as const)("fails closed when the structured decision is %s", async (decision, message) => {
		const requestToolApproval = vi.fn(async () => decision);
		const { tool, execute } = createApprovalTool();
		const wrapper = new ExtensionToolWrapper(
			tool,
			createRunner({ select: vi.fn(async () => "Approve"), requestToolApproval }),
		);

		await expect(
			wrapper.execute(
				"call-1",
				{ environment: "production" },
				undefined,
				undefined,
				createToolContext(() => "s1"),
			),
		).rejects.toThrow(message);
		expect(execute).not.toHaveBeenCalled();
	});

	it("falls back to the legacy select prompt when structured approval is unavailable", async () => {
		const select = vi.fn(async () => "Approve");
		const { tool, execute } = createApprovalTool();
		const wrapper = new ExtensionToolWrapper(tool, createRunner({ select }));

		await wrapper.execute(
			"call-1",
			{ environment: "staging" },
			undefined,
			undefined,
			createToolContext(() => "s1"),
		);

		expect(select).toHaveBeenCalledWith(expect.stringContaining("Allow tool: deploy"), ["Approve", "Deny"]);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});

describe("RPC approval side channel", () => {
	it.each([
		["approve_once", "accepted"],
		["approve_session", "accepted"],
		["deny", "denied"],
		["cancel", "cancelled"],
	] as const)("emits one authoritative %s resolution", async (decision, outcome) => {
		const frames: Array<RpcApprovalRequestFrame | RpcApprovalResolvedFrame> = [];
		const approvals = new RpcApprovalInteraction(frame => frames.push(frame));
		const result = approvals.request({
			sessionId: "session-1",
			toolCallId: "tool-1",
			toolName: "bash",
			approvalMode: "always-ask",
			tier: "exec",
			arguments: { command: "rm build.txt" },
			reason: "Command needs confirmation",
			details: ["Command: rm build.txt"],
			providerSafetyChecks: [],
			allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
		});
		const request = frames[0];
		if (request?.type !== "approval_request") throw new Error("Expected approval request");

		expect(
			dispatchRpcControlFrame(
				{ type: "approval_response", id: request.id, decision },
				createControlDeps(frame => approvals.handleResponse(frame)),
			),
		).toBe(true);

		expect(await result).toBe(decision);
		expect(frames[1]).toEqual({
			type: "approval_resolved",
			id: request.id,
			outcome,
			decision,
		});
		if (decision === "approve_session") {
			expect(approvals.hasSessionGrant("session-1", "bash")).toBe(true);
			approvals.clearSessionGrants();
			expect(approvals.hasSessionGrant("session-1", "bash")).toBe(false);
		}
	});

	it("fails closed for invalid, duplicate, and unknown responses without resolving another request", async () => {
		const frames: Array<RpcApprovalRequestFrame | RpcApprovalResolvedFrame> = [];
		const approvals = new RpcApprovalInteraction(frame => frames.push(frame));
		const first = approvals.request({
			sessionId: "session-1",
			toolCallId: "tool-1",
			toolName: "computer",
			approvalMode: "always-ask",
			tier: "exec",
			arguments: { actions: [] },
			details: [],
			providerSafetyChecks: ["Confirm external side effect"],
			allowedDecisions: ["approve_once", "deny", "cancel"],
		});
		const firstRequest = frames[0];
		if (firstRequest?.type !== "approval_request") throw new Error("Expected approval request");
		const second = approvals.request({
			sessionId: "session-1",
			toolCallId: "tool-2",
			toolName: "bash",
			approvalMode: "always-ask",
			tier: "exec",
			arguments: { command: "echo safe" },
			details: [],
			providerSafetyChecks: [],
			allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
		});
		const secondRequest = frames[1];
		if (secondRequest?.type !== "approval_request") throw new Error("Expected second request");

		approvals.handleResponse({ type: "approval_response", id: firstRequest.id, decision: "approve_session" });
		expect(await first).toBe("cancel");
		expect(frames.at(-1)).toEqual({ type: "approval_resolved", id: firstRequest.id, outcome: "stale" });

		approvals.handleResponse({ type: "approval_response", id: firstRequest.id, decision: "deny" });
		expect(frames.at(-1)).toEqual({ type: "approval_resolved", id: firstRequest.id, outcome: "stale" });

		approvals.handleResponse({ type: "approval_response", id: "unknown", decision: "approve_once" });
		expect(frames.at(-1)).toEqual({ type: "approval_resolved", id: "unknown", outcome: "stale" });

		approvals.handleResponse({ type: "approval_response", id: secondRequest.id, decision: "approve_once" });
		expect(await second).toBe("approve_once");
	});

	it.each([
		["timeout", "timed_out"],
		["abort", "aborted"],
		["exit", "aborted"],
	] as const)("resolves %s races authoritatively", async (race, outcome) => {
		if (race === "timeout") vi.useFakeTimers();
		const frames: Array<RpcApprovalRequestFrame | RpcApprovalResolvedFrame> = [];
		const approvals = new RpcApprovalInteraction(frame => frames.push(frame));
		const controller = new AbortController();
		const result = approvals.request(
			{
				sessionId: "session-1",
				toolCallId: "tool-1",
				toolName: "bash",
				approvalMode: "always-ask",
				tier: "exec",
				arguments: { command: "echo hi" },
				details: [],
				providerSafetyChecks: [],
				allowedDecisions: ["approve_once", "approve_session", "deny", "cancel"],
			},
			{ signal: controller.signal, timeout: race === "timeout" ? 1 : undefined },
		);
		const request = frames[0];
		if (request?.type !== "approval_request") throw new Error("Expected approval request");

		if (race === "timeout") vi.advanceTimersByTime(1);
		if (race === "abort") controller.abort();
		if (race === "exit") approvals.abortAll();

		expect(await result).toBe("cancel");
		expect(frames.at(-1)).toEqual({ type: "approval_resolved", id: request.id, outcome });
	});
});
