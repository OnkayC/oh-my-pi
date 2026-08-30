import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hookStatePath, readHookState } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/hook-state";
import { handleHook } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/hooks";
import { expectedGrokTranscriptPath } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/transcripts";
import type { Server } from "bun";

interface CapturedRequest {
	method: string;
	path: string;
	body?: Record<string, unknown>;
}

const originalEnv = {
	HOME: process.env.HOME,
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
	HINDSIGHT_BRIDGE_CONFIG: process.env.HINDSIGHT_BRIDGE_CONFIG,
};

let tempRoot: string;
let server: Server<undefined> | undefined;
let requests: CapturedRequest[];
let failRetain = false;
let mentalModelsEnabled = false;

async function writeBridgeConfig(): Promise<void> {
	const configPath = path.join(tempRoot, "bridge.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({
			apiUrl: server?.url.origin,
			apiToken: "test-token",
			bankId: "coding-agents",
			scoping: "per-project-tagged",
			mentalModelsEnabled,
		}),
		{ mode: 0o600 },
	);
	await fs.chmod(configPath, 0o600);
	process.env.HINDSIGHT_BRIDGE_CONFIG = configPath;
}

function mentalModels(): Record<string, unknown>[] {
	return [
		{ id: "user-preferences", name: "User Preferences", content: "Prefer explicit errors.", tags: [] },
		{
			id: "project-conventions-config",
			name: "Project Conventions",
			content: "Use Nushell for configuration scripts.",
			tags: ["project:config"],
		},
		{
			id: "project-decisions-config",
			name: "Project Decisions",
			content: "Hindsight uses one tagged bank.",
			tags: ["project:config"],
		},
	];
}

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "hindsight-bridge-hooks-"));
	process.env.HOME = tempRoot;
	process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
	requests = [];
	failRetain = false;
	mentalModelsEnabled = false;
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = request.method === "GET" ? "" : await request.text();
			requests.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
			});
			if (request.method === "GET" && url.pathname.endsWith("/mental-models")) {
				return Response.json({ items: mentalModels() });
			}
			if (url.pathname.endsWith("/memories/recall")) {
				return Response.json({ results: [{ text: "Alpha policy", type: "world" }] });
			}
			if (failRetain && request.method === "POST" && url.pathname.endsWith("/memories")) {
				return Response.json({ error: "retain failed" }, { status: 500 });
			}
			return Response.json({});
		},
	});
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await fs.rm(tempRoot, { recursive: true, force: true });
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Hindsight bridge lifecycle hooks", () => {
	it("injects visible mental models and freezes project scope at session start", async () => {
		mentalModelsEnabled = true;
		await writeBridgeConfig();
		const output = await handleHook("codex", "session-start", {
			session_id: "codex-session",
			cwd: "/Users/onkay/workspace/config",
		});

		expect(output?.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(output?.hookSpecificOutput.additionalContext).toContain("Project Conventions");
		const state = await readHookState("codex", "codex-session");
		expect(state?.scope).toMatchObject({
			bankId: "coding-agents",
			retainTags: ["project:config"],
			recallTags: ["project:config"],
			recallTagsMatch: "any",
			observationScopes: [["project:config"]],
		});
	});

	it("recalls once on the first prompt with frozen tags", async () => {
		await writeBridgeConfig();
		await handleHook("codex", "session-start", { session_id: "recall-session", cwd: "/work/config" });
		const first = await handleHook("codex", "user-prompt-submit", {
			session_id: "recall-session",
			cwd: "/work/other",
			prompt: "What did we decide?",
		});
		const second = await handleHook("codex", "user-prompt-submit", {
			session_id: "recall-session",
			cwd: "/work/other",
			prompt: "Again",
		});

		expect(first?.hookSpecificOutput.additionalContext).toContain("Alpha policy");
		expect(second).toBeUndefined();
		const recallRequests = requests.filter(request => request.path.endsWith("/memories/recall"));
		expect(recallRequests).toHaveLength(1);
		expect(recallRequests[0].body).toMatchObject({ tags: ["project:config"], tags_match: "any" });
	});

	it("retains Codex and Grok transcripts with replace semantics and project observation scope", async () => {
		await writeBridgeConfig();
		const fixtureRoot = path.join(import.meta.dir, "fixtures", "hindsight-agent-bridge");
		const codexTranscript = path.join(fixtureRoot, "codex-transcript.jsonl");
		await handleHook("codex", "session-start", { session_id: "codex-stop", cwd: "/work/config" });
		await handleHook("codex", "stop", {
			session_id: "codex-stop",
			cwd: "/work/config",
			transcript_path: codexTranscript,
		});

		const grokTranscript = expectedGrokTranscriptPath("/work/config", "grok-stop");
		await fs.mkdir(path.dirname(grokTranscript), { recursive: true });
		await fs.copyFile(path.join(fixtureRoot, "grok-transcript.jsonl"), grokTranscript);
		await handleHook("grok", "session-start", { sessionId: "grok-stop", cwd: "/work/config" });
		await handleHook("grok", "stop", { sessionId: "grok-stop", cwd: "/work/config" });

		const retains = requests.filter(
			request => request.method === "POST" && request.path.endsWith("/memories") && request.body?.items,
		);
		expect(retains).toHaveLength(2);
		for (const request of retains) {
			expect(request.body).toMatchObject({
				async: true,
				items: [
					{
						tags: ["project:config"],
						observation_scopes: [["project:config"]],
						update_mode: "replace",
					},
				],
			});
		}
		expect(await Bun.file(hookStatePath("codex", "codex-stop")).exists()).toBe(false);
		expect(await Bun.file(hookStatePath("grok", "grok-stop")).exists()).toBe(false);
	});

	it("keeps hook state when Stop retention fails", async () => {
		await writeBridgeConfig();
		await handleHook("codex", "session-start", { session_id: "retry-stop", cwd: "/work/config" });
		failRetain = true;
		await expect(
			handleHook("codex", "stop", {
				session_id: "retry-stop",
				cwd: "/work/config",
				transcript_path: path.join(import.meta.dir, "fixtures", "hindsight-agent-bridge", "codex-transcript.jsonl"),
			}),
		).rejects.toThrow("retain failed");
		expect(await readHookState("codex", "retry-stop")).toBeDefined();
	});
});
