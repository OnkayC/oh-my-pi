import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";

/**
 * Regression test for issue #5194: a non-JSON stdin line crashed the whole RPC
 * process with an uncaught `SyntaxError: Failed to parse JSONL` escaping the
 * frame loop. A malformed line must instead be reported as an error frame and
 * the process must keep reading subsequent frames.
 */
describe("RPC mode malformed stdin", () => {
	test("reports a bad line as an error frame and keeps serving subsequent commands", async () => {
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...Bun.env, PI_NO_TITLE: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		// A non-JSON line followed by a valid command. Pre-fix the first line
		// crashed the generator before the second was ever read.
		child.stdin.write("this is not json\n");
		child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
		child.stdin.write(`${JSON.stringify({ type: "get_messages_page", id: "page-probe", limit: 1 })}\n`);
		await child.stdin.flush();

		let parseError: Record<string, unknown> | undefined;
		let stateResponse: Record<string, unknown> | undefined;
		let pageResponse: Record<string, unknown> | undefined;

		for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "response" && frame.command === "parse" && frame.success === false) {
				parseError = frame;
			}
			if (frame.type === "response" && frame.id === "probe") {
				stateResponse = frame;
			}
			if (frame.type === "response" && frame.id === "page-probe") pageResponse = frame;
			if (stateResponse && pageResponse) break;
		}

		child.stdin.end();
		child.kill();
		await child.exited.catch(() => {});

		expect(parseError).toBeDefined();
		expect(String(parseError?.error)).toContain("Failed to parse command");
		expect(stateResponse).toBeDefined();
		expect(stateResponse?.success).toBe(true);
		expect(pageResponse).toMatchObject({
			success: true,
			data: { messages: [], totalMessages: 0 },
		});
	}, 30000);
});

describe("RPC mode protocol v2 stdin", () => {
	test("reassembles oversized commands after protocol negotiation", async () => {
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...Bun.env, PI_NO_TITLE: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		try {
			const frames = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
			const nextMatching = async (predicate: (frame: Record<string, unknown>) => boolean) => {
				for (;;) {
					const next = await frames.next();
					if (next.done) throw new Error("OMP RPC stdout closed before the expected frame");
					if (isRecord(next.value) && predicate(next.value)) return next.value;
				}
			};
			expect(await nextMatching(frame => frame.type === "ready")).toMatchObject({ type: "ready" });

			child.stdin.write(`${JSON.stringify({ id: "protocol", type: "negotiate_protocol", protocolVersion: 2 })}\n`);
			await child.stdin.flush();
			expect(await nextMatching(frame => frame.type === "response" && frame.id === "protocol")).toMatchObject({
				id: "protocol",
				type: "response",
				command: "negotiate_protocol",
				success: true,
			});

			const requestId = `oversized-${"δ".repeat(600_000)}`;
			const encoder = new RpcFrameEncoder();
			encoder.setProtocolVersion(2);
			const encoded = encoder.encode({ id: requestId, type: "get_state" });
			expect(encoded.trimEnd().split("\n").length).toBeGreaterThan(1);
			child.stdin.write(encoded);
			await child.stdin.flush();

			const decoder = new RpcFrameDecoder();
			let response: object | undefined;
			while (!response) {
				const next = await frames.next();
				if (next.done) throw new Error("OMP RPC stdout closed before the oversized response");
				response = decoder.push(next.value);
			}
			expect(response).toMatchObject({
				type: "response",
				command: "get_state",
				success: true,
			});
			expect(isRecord(response) && response.id).toBe(requestId);
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited.catch(() => {});
		}
	}, 30000);
});
