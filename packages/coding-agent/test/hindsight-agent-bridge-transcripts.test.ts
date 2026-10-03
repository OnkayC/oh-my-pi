import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseCodexTranscript, parseGrokTranscript } from "../src/hindsight-agent-bridge/transcripts";

describe("bridge conversation retention", () => {
	it("keeps Codex conversation text without instructions, tool arguments, results, or injected memory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-transcript-"));
		const file = path.join(directory, "transcript.jsonl");
		const timestamp = "2026-10-03T00:00:00Z";
		const payloads = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Use SQLite." }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Agreed. <memories>old fact</memories>" }],
			},
			{ type: "message", role: "developer", content: "Internal instructions" },
			{ type: "message", role: "user", content: "# AGENTS.md instructions\nInternal instructions" },
			{
				type: "message",
				role: "user",
				content: '<hindsight_bridge>{"session_id":"private-session","cwd":"/private/project"}</hindsight_bridge>',
			},
			{ type: "function_call", name: "shell", arguments: '{"command":"sensitive argument"}' },
			{ type: "custom_tool_call", name: "edit", input: "sensitive patch" },
			{ type: "function_call_output", output: "sensitive result" },
		];
		try {
			await Bun.write(
				file,
				payloads.map(payload => JSON.stringify({ type: "response_item", timestamp, payload })).join("\n"),
			);
			expect(await parseCodexTranscript(file)).toEqual([
				{ role: "user", content: "Use SQLite.", timestamp },
				{ role: "assistant", content: "Agreed.", timestamp },
			]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps Grok conversation text without tool-call arguments", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-transcript-"));
		const file = path.join(directory, "transcript.jsonl");
		try {
			await Bun.write(
				file,
				JSON.stringify({
					role: "assistant",
					content: "Use SQLite.",
					tool_calls: [{ function: { name: "shell", arguments: "sensitive argument" } }],
				}),
			);
			expect(await parseGrokTranscript(file)).toEqual([
				{ role: "assistant", content: "Use SQLite.", timestamp: undefined },
			]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
