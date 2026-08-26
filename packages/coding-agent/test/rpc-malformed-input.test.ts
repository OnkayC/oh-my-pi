import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { readRpcInputFrames } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";

/**
 * Regression test for issue #5194: a non-JSON stdin line crashed the whole RPC
 * process with an uncaught parse error escaping the frame loop. A malformed
 * line must instead be reported and the reader must keep yielding later frames.
 */
describe("RPC mode malformed stdin", () => {
	test("reports a bad line and keeps reading subsequent commands", async () => {
		const input = new Blob([
			"this is not json\n",
			`${JSON.stringify({ type: "get_state", id: "probe" })}\n`,
			`${JSON.stringify({ type: "get_messages_page", id: "page-probe", limit: 1 })}\n`,
		]).stream();
		const frames: unknown[] = [];
		const parseErrors: string[] = [];

		await readRpcInputFrames(
			input,
			frame => frames.push(frame),
			message => parseErrors.push(message),
		);

		expect(parseErrors).toHaveLength(1);
		expect(parseErrors[0]).toContain("Failed to parse command");
		expect(frames).toEqual([
			{ type: "get_state", id: "probe" },
			{ type: "get_messages_page", id: "page-probe", limit: 1 },
		]);
	});
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
