import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	dispatchRpcControlFrame,
	RpcAskInteraction,
	type RpcInputFrameDeps,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcAskRequestFrame, RpcExtensionUIResolvedFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const questions: ExtensionAskDialogQuestion[] = [
	{
		id: "scope",
		header: "Deployment scope",
		question: "Where should this ship?",
		options: [
			{ label: "Staging", description: "Internal verification", preview: "deploy --env staging" },
			{ label: "Production", description: "Customer traffic", preview: "deploy --env production" },
		],
		recommended: 0,
	},
	{
		id: "checks",
		question: "Which checks should run?",
		options: [{ label: "Smoke" }, { label: "Load" }],
		multi: true,
		allowCustom: true,
	},
];

const scopeAnswer = {
	id: "scope",
	question: "Where should this ship?",
	options: ["Staging", "Production"],
	multi: false,
	selectedOptions: ["Production"],
	note: "Watch error rate",
};

const checksAnswer = {
	id: "checks",
	question: "Which checks should run?",
	options: ["Smoke", "Load"],
	multi: true,
	selectedOptions: ["Smoke", "Load"],
	customInput: "Run soak tests",
};

const submitted = {
	kind: "submit",
	results: [scopeAnswer, checksAnswer],
} satisfies ExtensionAskDialogResult;

function createControlDeps(
	onExtensionUIResponse: NonNullable<RpcInputFrameDeps["onExtensionUIResponse"]>,
): RpcInputFrameDeps {
	return {
		handleCommand: async () => {
			throw new Error("No command expected");
		},
		output: () => {},
		errorResponse: (id, command, error) => ({ id, type: "response", command, success: false, error }),
		pendingExtensionRequests: new Map(),
		onExtensionUIResponse,
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RPC rich ask side channel", () => {
	it("preserves every question and answer field and emits submitted authoritatively", async () => {
		const frames: Array<RpcAskRequestFrame | RpcExtensionUIResolvedFrame> = [];
		const asks = new RpcAskInteraction(frame => frames.push(frame));
		const result = asks.request(questions, { timeout: 45_000 });
		const request = frames[0];
		if (request?.type !== "extension_ui_request") throw new Error("Expected rich ask request");
		expect(request).toEqual({
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions,
			timeout: 45_000,
		});

		expect(
			dispatchRpcControlFrame(
				{ type: "extension_ui_response", id: request.id, result: submitted },
				createControlDeps(response => asks.handleResponse(response)),
			),
		).toBe(true);

		expect(await result).toEqual(submitted);
		expect(frames[1]).toEqual({
			type: "extension_ui_resolved",
			id: request.id,
			method: "ask",
			outcome: "submitted",
			result: submitted,
		});
	});

	it.each([
		[
			"an answer for an unknown question ID",
			{ ...submitted, results: [{ ...scopeAnswer, id: "unknown" }, checksAnswer] },
		],
		["a missing answer", { ...submitted, results: [scopeAnswer] }],
		["duplicate answers", { ...submitted, results: [scopeAnswer, { ...checksAnswer, id: "scope" }] }],
		[
			"an unadvertised selected option",
			{
				...submitted,
				results: [{ ...scopeAnswer, selectedOptions: ["Canary"] }, checksAnswer],
			},
		],
		[
			"multiple selections for a single-select question",
			{
				...submitted,
				results: [{ ...scopeAnswer, selectedOptions: ["Staging", "Production"] }, checksAnswer],
			},
		],
		[
			"duplicate selected options",
			{
				...submitted,
				results: [scopeAnswer, { ...checksAnswer, selectedOptions: ["Smoke", "Smoke"] }],
			},
		],
		[
			"custom input for a question that disallows it",
			{
				...submitted,
				results: [{ ...scopeAnswer, customInput: "Canary first" }, checksAnswer],
			},
		],
		[
			"a malformed answer",
			{
				...submitted,
				results: [scopeAnswer, { ...checksAnswer, selectedOptions: "Smoke" }],
			} as unknown as ExtensionAskDialogResult,
		],
	] satisfies Array<[string, ExtensionAskDialogResult]>)("rejects %s", async (_case, rejected) => {
		const frames: Array<RpcAskRequestFrame | RpcExtensionUIResolvedFrame> = [];
		const asks = new RpcAskInteraction(frame => frames.push(frame));
		const result = asks.request(questions);
		const request = frames[0];
		if (request?.type !== "extension_ui_request") throw new Error("Expected rich ask request");

		expect(asks.handleResponse({ type: "extension_ui_response", id: request.id, result: rejected })).toBe(true);
		expect(await result).toBeUndefined();
		expect(frames[1]).toEqual({
			type: "extension_ui_resolved",
			id: request.id,
			method: "ask",
			outcome: "stale",
		});
	});

	it("distinguishes chat redirect and cancellation", async () => {
		const frames: Array<RpcAskRequestFrame | RpcExtensionUIResolvedFrame> = [];
		const asks = new RpcAskInteraction(frame => frames.push(frame));
		const chat = asks.request(questions);
		const chatRequest = frames[0];
		if (chatRequest?.type !== "extension_ui_request") throw new Error("Expected chat request");
		asks.handleResponse({ type: "extension_ui_response", id: chatRequest.id, result: { kind: "chat" } });
		expect(await chat).toEqual({ kind: "chat" });
		expect(frames[1]).toEqual({
			type: "extension_ui_resolved",
			id: chatRequest.id,
			method: "ask",
			outcome: "chat",
			result: { kind: "chat" },
		});

		const cancelled = asks.request(questions);
		const cancelRequest = frames[2];
		if (cancelRequest?.type !== "extension_ui_request") throw new Error("Expected cancel request");
		asks.handleResponse({ type: "extension_ui_response", id: cancelRequest.id, cancelled: true });
		expect(await cancelled).toBeUndefined();
		expect(frames[3]).toEqual({
			type: "extension_ui_resolved",
			id: cancelRequest.id,
			method: "ask",
			outcome: "cancelled",
		});
	});

	it("invokes the timeout callback for a host-reported timeout exactly once", async () => {
		const frames: Array<RpcAskRequestFrame | RpcExtensionUIResolvedFrame> = [];
		const onTimeout = vi.fn();
		const asks = new RpcAskInteraction(frame => frames.push(frame));
		const result = asks.request(questions, { onTimeout });
		const request = frames[0];
		if (request?.type !== "extension_ui_request") throw new Error("Expected rich ask request");

		asks.handleResponse({ type: "extension_ui_response", id: request.id, cancelled: true, timedOut: true });

		expect(await result).toBeUndefined();
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(frames[1]).toMatchObject({ type: "extension_ui_resolved", id: request.id, outcome: "timed_out" });
	});

	it("settles timeout, abort, and process exit races exactly once", async () => {
		vi.useFakeTimers();
		const frames: Array<RpcAskRequestFrame | RpcExtensionUIResolvedFrame> = [];
		const asks = new RpcAskInteraction(frame => frames.push(frame));

		const onTimeout = vi.fn();
		const timedOut = asks.request(questions, { timeout: 25, onTimeout });
		const timeoutRequest = frames[0];
		if (timeoutRequest?.type !== "extension_ui_request") throw new Error("Expected timeout request");
		vi.advanceTimersByTime(25);
		expect(await timedOut).toBeUndefined();
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(frames.at(-1)).toEqual({
			type: "extension_ui_resolved",
			id: timeoutRequest.id,
			method: "ask",
			outcome: "timed_out",
		});

		const controller = new AbortController();
		const aborted = asks.request(questions, { signal: controller.signal });
		const abortRequest = frames.at(-1);
		if (abortRequest?.type !== "extension_ui_request") throw new Error("Expected abort request");
		controller.abort();
		expect(await aborted).toBeUndefined();
		expect(frames.at(-1)).toEqual({
			type: "extension_ui_resolved",
			id: abortRequest.id,
			method: "ask",
			outcome: "aborted",
		});

		const exited = asks.request(questions);
		const exitRequest = frames.at(-1);
		if (exitRequest?.type !== "extension_ui_request") throw new Error("Expected exit request");
		asks.abortAll();
		expect(await exited).toBeUndefined();
		expect(frames.at(-1)).toEqual({
			type: "extension_ui_resolved",
			id: exitRequest.id,
			method: "ask",
			outcome: "aborted",
		});
	});

	it("marks malformed, duplicate, and unknown ask responses stale without touching another request", async () => {
		const frames: Array<RpcAskRequestFrame | RpcExtensionUIResolvedFrame> = [];
		const asks = new RpcAskInteraction(frame => frames.push(frame));
		const first = asks.request(questions);
		const firstRequest = frames[0];
		if (firstRequest?.type !== "extension_ui_request") throw new Error("Expected first request");
		const second = asks.request(questions);
		const secondRequest = frames[1];
		if (secondRequest?.type !== "extension_ui_request") throw new Error("Expected second request");

		asks.handleResponse({
			type: "extension_ui_response",
			id: firstRequest.id,
			result: { kind: "submit", results: [] },
		});
		expect(await first).toBeUndefined();
		expect(frames.at(-1)).toEqual({
			type: "extension_ui_resolved",
			id: firstRequest.id,
			method: "ask",
			outcome: "stale",
		});

		asks.handleResponse({ type: "extension_ui_response", id: firstRequest.id, result: { kind: "chat" } });
		expect(frames.at(-1)).toEqual({
			type: "extension_ui_resolved",
			id: firstRequest.id,
			method: "ask",
			outcome: "stale",
		});

		asks.handleResponse({ type: "extension_ui_response", id: "unknown", result: { kind: "chat" } });
		expect(frames.at(-1)).toEqual({
			type: "extension_ui_resolved",
			id: "unknown",
			method: "ask",
			outcome: "stale",
		});

		asks.handleResponse({ type: "extension_ui_response", id: secondRequest.id, result: { kind: "chat" } });
		expect(await second).toEqual({ kind: "chat" });
	});
});
