import { describe, expect, test } from "bun:test";
import type { ExtensionAskDialogResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { defineRpcClientTool, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("RpcClient protocol v2 outbound logical frame limit", () => {
	test("rejects oversized correlated and lifecycle payloads without emitting rpc_frame_error", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-frame-limit-");
		const scriptPath = tempDir.join("fake-rpc-server.js");
		await Bun.write(
			scriptPath,
			`
let buffer = "";
const received = [];
const state = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "frame-limit-test",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
function respond(frame, data = {}) {
	write({ id: frame.id, type: "response", command: frame.type, success: true, data });
}
write({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: ${MAX_RPC_FRAME_BYTES},
	maxReassembledFrameBytes: ${MAX_RPC_REASSEMBLED_BYTES},
	capabilities: { richUserInput: 2 },
});
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
	received.push(frame);
	if (frame.type === "negotiate_protocol") {
		respond(frame, { protocolVersion: 2 });
		return;
	}
	if (frame.type === "negotiate_capabilities") {
		respond(frame, { capabilities: frame.capabilities });
		return;
	}
	if (frame.type === "set_host_tools") {
		respond(frame, { toolNames: frame.tools.map(tool => tool.name) });
		return;
	}
	if (frame.type === "prompt") {
		respond(frame);
		if (frame.message === "trigger host tool") {
			write({ type: "agent_start" });
			write({
				type: "host_tool_call",
				id: "host-call-oversized",
				toolCallId: "toolu_oversized",
				toolName: "oversized_host_result",
				arguments: {},
			});
		}
		return;
	}
	if (frame.type === "host_tool_result") {
		write({
			type: "tool_execution_end",
			toolCallId: "toolu_oversized",
			toolName: "oversized_host_result",
			result: frame.result,
			isError: frame.isError === true,
		});
		write({ type: "agent_end", messages: [] });
		return;
	}
	if (frame.type === "get_state") {
		respond(frame, { ...state, received });
		return;
	}
	if (frame.type === "abort") respond(frame);
}
`,
		);

		const oversized = "x".repeat(MAX_RPC_REASSEMBLED_BYTES);
		using client = new RpcClient({
			cliPath: scriptPath,
			capabilities: { richUserInput: 1, planControl: 1 },
			customTools: [
				defineRpcClientTool({
					name: "oversized_host_result",
					description: "Returns a payload above the negotiated logical frame limit",
					parameters: { type: "object", additionalProperties: false },
					execute: () => oversized,
				}),
			],
		});
		await client.start();
		expect(client.offeredCapabilities.richUserInput).toBe(2);
		expect(client.selectedCapabilities.richUserInput).toBe(1);
		client.respondToExtensionUI("ui-value", { value: "chosen" });
		client.respondToExtensionUI("ui-confirm", { confirmed: true });
		client.respondToExtensionUI("ui-cancel", { cancelled: true, timedOut: true });
		expect(() => client.respondToExtensionUI("ui-value-oversized", { value: oversized })).toThrow(
			"protocol v2 reassembly limit",
		);

		await expect(client.prompt(oversized)).rejects.toThrow("protocol v2 reassembly limit");
		await expect(
			client.prompt("oversized image", [{ type: "image", data: oversized, mimeType: "image/png" }]),
		).rejects.toThrow("protocol v2 reassembly limit");

		const askResult = {
			kind: "submit",
			results: [
				{
					id: "details",
					question: "Details?",
					options: [],
					multi: false,
					selectedOptions: [],
					note: oversized,
				},
			],
		} satisfies ExtensionAskDialogResult;
		expect(() => client.respondToAsk("ask-oversized", { result: askResult })).toThrow("protocol v2 reassembly limit");

		const hostEvents = await client.promptAndWait("trigger host tool");
		const hostEnd = hostEvents.find(event => event.type === "tool_execution_end");
		expect(hostEnd).toMatchObject({
			type: "tool_execution_end",
			toolName: "oversized_host_result",
			isError: true,
		});
		expect(JSON.stringify(hostEnd)).toContain("protocol v2 reassembly limit");

		const snapshot = (await client.getState()) as unknown as {
			received: Array<Record<string, unknown>>;
		};
		expect(snapshot.received.some(frame => frame.type === "rpc_frame_error")).toBe(false);
		expect(snapshot.received).toContainEqual(
			expect.objectContaining({
				type: "negotiate_capabilities",
				capabilities: { richUserInput: 1 },
			}),
		);
		expect(snapshot.received.filter(frame => frame.type === "prompt").map(frame => frame.message)).toEqual([
			"trigger host tool",
		]);
		expect(snapshot.received).toContainEqual({
			type: "extension_ui_response",
			id: "ask-oversized",
			cancelled: true,
		});
		expect(snapshot.received).toContainEqual({
			type: "extension_ui_response",
			id: "ui-value-oversized",
			cancelled: true,
		});
		expect(snapshot.received).toContainEqual({
			type: "extension_ui_response",
			id: "ui-value",
			value: "chosen",
		});
		expect(snapshot.received).toContainEqual({
			type: "extension_ui_response",
			id: "ui-confirm",
			confirmed: true,
		});
		expect(snapshot.received).toContainEqual({
			type: "extension_ui_response",
			id: "ui-cancel",
			cancelled: true,
			timedOut: true,
		});
		expect(snapshot.received).toContainEqual(
			expect.objectContaining({
				type: "host_tool_result",
				id: "host-call-oversized",
				isError: true,
			}),
		);

		await client.abort();
	}, 20_000);
});
