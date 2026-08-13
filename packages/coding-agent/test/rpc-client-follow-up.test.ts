import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient, RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

describe("RpcClient.followUp", () => {
	test("preserves legacy image calls and sends durable identity only for the options form", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-follow-up-");
		const captureFile = tempDir.join("commands.jsonl");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_CAPTURE_FILE: captureFile, MOCK_RPC_CAPABILITIES: JSON.stringify({ hostTurns: 1 }) },
		});
		const images: ImageContent[] = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];

		await client.start();
		await client.followUp("legacy without images");
		await client.followUp("legacy with images", images);
		await client.followUp("durable", {
			images,
			clientTurnId: "turn-1",
			optionFingerprint: "options-1",
			turnOptions: { modelId: "claude-sonnet-4-6", thinkingLevel: "high", fastMode: true },
		});

		const assertDurableIdentityIsRequired = () => {
			// @ts-expect-error Durable options must include both host-turn identity fields.
			void client.followUp("invalid durable call", { images });
		};
		void assertDurableIdentityIsRequired;

		const followUps = (await Bun.file(captureFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.filter(frame => frame.type === "follow_up")
			.map(({ id: _id, ...frame }) => frame);
		expect(followUps).toEqual([
			{ type: "follow_up", message: "legacy without images" },
			{ type: "follow_up", message: "legacy with images", images },
			{
				type: "follow_up",
				message: "durable",
				images,
				clientTurnId: "turn-1",
				optionFingerprint: "options-1",
				turnOptions: { modelId: "claude-sonnet-4-6", thinkingLevel: "high", fastMode: true },
			},
		]);
	});

	test("rejects durable prompt and follow_up when the server returns a failure response", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-durable-reject-${Date.now()}.js`);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
write({ type: "ready", capabilities: { hostTurns: 1 } });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			if (frame.type === "negotiate_capabilities") {
				write({
					id: frame.id,
					type: "response",
					command: frame.type,
					success: true,
					data: { capabilities: frame.capabilities },
				});
				index = buffer.indexOf("\\n");
				continue;
			}
			if (frame.type === "prompt" || frame.type === "follow_up") {
				write({
					id: frame.id,
					type: "response",
					command: frame.type,
					success: false,
					error: frame.type === "prompt"
						? "clientTurnId already exists with different content"
						: "hostTurns capability was not selected",
					code: frame.type === "follow_up" ? "capability_not_selected" : undefined,
				});
			}
		}
		index = buffer.indexOf("\\n");
	}
});
`,
		);

		const client = new RpcClient({ cliPath: scriptPath });
		try {
			await client.start();
			await expect(client.prompt("reused", undefined, "turn-conflict")).rejects.toBeInstanceOf(RpcCommandError);
			await expect(client.prompt("reused", undefined, "turn-conflict")).rejects.toThrow(
				"clientTurnId already exists with different content",
			);
			await expect(client.promptAndWait("reused", undefined, 20)).rejects.toBeInstanceOf(RpcCommandError);
			await Bun.sleep(50);
			await expect(
				client.followUp("durable", {
					clientTurnId: "turn-1",
					optionFingerprint: "options-1",
				}),
			).rejects.toMatchObject({
				name: "RpcCommandError",
				command: "follow_up",
				code: "capability_not_selected",
				message: "hostTurns capability was not selected",
			});
		} finally {
			await client.stop();
			fs.rmSync(scriptPath, { force: true });
		}
	});
});
