import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
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
	HINDSIGHT_RETAIN_EVERY_N_TURNS: process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS,
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
		{
			id: "project-conventions-alpha",
			name: "Alpha Conventions",
			content: "Alpha uses immutable records.",
			tags: ["project:alpha"],
		},
		{
			id: "project-conventions-beta",
			name: "Beta Conventions",
			content: "Beta uses message queues.",
			tags: ["project:beta"],
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
	delete process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS;
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

function turns(count: number, project = "config"): HindsightMessage[] {
	return Array.from({ length: count }, (_, index) => [
		{ role: "user", content: `${project} decision ${index + 1}` },
		{ role: "assistant", content: `${project} answer ${index + 1}` },
	]).flat();
}

function retains(): CapturedRequest[] {
	return requests.filter(
		request => request.method === "POST" && request.path.endsWith("/memories") && request.body?.items,
	);
}

describe("Hindsight bridge lifecycle hooks", () => {
	it("injects visible mental models and an exact session binding", async () => {
		mentalModelsEnabled = true;
		await writeBridgeConfig();
		const output = await handleHook("codex", "session-start", {
			session_id: "codex-session",
			cwd: "/work/config",
		});

		expect(output?.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(output?.hookSpecificOutput.additionalContext).toContain("Project Conventions");
		expect(output?.hookSpecificOutput.additionalContext).toContain(
			'"session_id":"codex-session","cwd":"/work/config"',
		);
		const state = await readHookState("codex", "codex-session");
		expect(state?.scope).toMatchObject({
			bankId: "coding-agents",
			retainTags: ["project:config"],
			recallTags: ["project:config"],
			recallTagsMatch: "any",
			observationScopes: [["project:config"]],
		});
		expect((await fs.stat(hookStatePath("codex", "codex-session"))).mode & 0o777).toBe(0o600);
	});

	it("does not recall again after a successful Stop or repeated SessionStart", async () => {
		process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS = "1";
		await writeBridgeConfig();
		const payload = { session_id: "recall-session", cwd: "/work/config" };
		await handleHook("codex", "session-start", payload);
		const first = await handleHook("codex", "user-prompt-submit", { ...payload, prompt: "What did we decide?" });
		await handleHook("codex", "stop", {
			...payload,
			transcript_path: path.join(import.meta.dir, "fixtures", "hindsight-agent-bridge", "codex-transcript.jsonl"),
		});
		await handleHook("codex", "session-start", payload);
		const second = await handleHook("codex", "user-prompt-submit", { ...payload, prompt: "Again" });

		expect(first?.hookSpecificOutput.additionalContext).toContain("Alpha policy");
		expect(second).toBeUndefined();
		expect(retains()).toHaveLength(1);
		const recalls = requests.filter(request => request.path.endsWith("/memories/recall"));
		expect(recalls).toHaveLength(1);
		expect(recalls[0].body).toMatchObject({ tags: ["project:config"], tags_match: "any" });
		expect((await readHookState("codex", "recall-session"))?.recallAttempted).toBe(true);
	});

	it("keeps Amp's first-prompt recall latch across turns", async () => {
		await writeBridgeConfig();
		const payload = { session_id: "amp-recall", cwd: "/work/config" };
		await handleHook("amp", "session-start", payload);
		const first = await handleHook("amp", "user-prompt-submit", { ...payload, prompt: "First question" });
		await handleHook("amp", "stop", { ...payload, messages: turns(1) });
		const second = await handleHook("amp", "user-prompt-submit", { ...payload, prompt: "Second question" });
		expect(first?.hookSpecificOutput.additionalContext).toContain("Alpha policy");
		expect(second).toBeUndefined();
		expect(requests.filter(request => request.path.endsWith("/memories/recall"))).toHaveLength(1);
	});

	it("retains every three user turns and flushes the final incomplete window once", async () => {
		await writeBridgeConfig();
		const payload = { session_id: "cadence", cwd: "/work/config" };
		await handleHook("amp", "session-start", payload);
		await handleHook("amp", "stop", { ...payload, messages: turns(1) });
		await handleHook("amp", "stop", { ...payload, messages: turns(2) });
		expect(retains()).toHaveLength(0);
		await handleHook("amp", "stop", { ...payload, messages: turns(3) });
		await handleHook("amp", "stop", { ...payload, messages: turns(3) });
		expect(retains()).toHaveLength(1);
		await handleHook("amp", "stop", { ...payload, messages: turns(4) });
		expect(retains()).toHaveLength(1);
		await handleHook("amp", "session-end", { ...payload, messages: turns(4) });
		await handleHook("amp", "session-end", { ...payload, messages: turns(4) });
		const retained = retains();
		expect(retained).toHaveLength(2);
		expect(retained[1].body).toMatchObject({
			items: [{ document_id: "bridge:amp:cadence:0", update_mode: "replace" }],
		});
		expect(JSON.stringify(retained[0].body)).not.toContain("config decision 4");
		expect(JSON.stringify(retained[1].body)).toContain("config decision 4");
	});

	it("retains Codex and Grok short sessions at SessionEnd without resetting their state", async () => {
		await writeBridgeConfig();
		const fixtureRoot = path.join(import.meta.dir, "fixtures", "hindsight-agent-bridge");
		const codexPayload = {
			session_id: "codex-stop",
			cwd: "/work/config",
			transcript_path: path.join(fixtureRoot, "codex-transcript.jsonl"),
		};
		await handleHook("codex", "session-start", { session_id: codexPayload.session_id, cwd: codexPayload.cwd });
		await handleHook("codex", "stop", codexPayload);
		await handleHook("codex", "session-end", codexPayload);
		const grokTranscript = expectedGrokTranscriptPath("/work/config", "grok-stop");
		await fs.mkdir(path.dirname(grokTranscript), { recursive: true });
		await fs.copyFile(path.join(fixtureRoot, "grok-transcript.jsonl"), grokTranscript);
		const grokPayload = { sessionId: "grok-stop", cwd: "/work/config" };
		await handleHook("grok", "session-start", grokPayload);
		await handleHook("grok", "stop", grokPayload);
		await handleHook("grok", "session-end", grokPayload);
		expect(retains()).toHaveLength(2);
		for (const request of retains()) {
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
		expect((await readHookState("codex", "codex-stop"))?.retainedTurns).toBeGreaterThan(0);
		expect((await readHookState("grok", "grok-stop"))?.retainedTurns).toBeGreaterThan(0);
	});

	it("preserves pending transcript when final retention fails and retries without duplicating messages", async () => {
		await writeBridgeConfig();
		const payload = { session_id: "retry-stop", cwd: "/work/config", messages: turns(1) };
		await handleHook("amp", "session-start", { session_id: payload.session_id, cwd: payload.cwd });
		await handleHook("amp", "stop", payload);
		failRetain = true;
		await expect(handleHook("amp", "session-end", payload)).rejects.toThrow("retain failed");
		expect((await readHookState("amp", "retry-stop"))?.retainedMessageCount).toBe(0);
		failRetain = false;
		await handleHook("amp", "session-end", payload);
		const retained = retains().at(-1);
		const body = JSON.stringify(retained?.body);
		expect(body.split("config decision 1")).toHaveLength(2);
		expect((await readHookState("amp", "retry-stop"))?.retainedMessageCount).toBe(2);
	});

	it("preserves the old project binding until its pending retention succeeds", async () => {
		await writeBridgeConfig();
		const session_id = "transition-failure";
		await handleHook("amp", "session-start", { session_id, cwd: "/work/alpha" });
		await handleHook("amp", "stop", { session_id, cwd: "/work/alpha", messages: turns(1, "alpha") });
		failRetain = true;
		await expect(
			handleHook("amp", "user-prompt-submit", { session_id, cwd: "/work/beta", prompt: "Beta" }),
		).rejects.toThrow("retain failed");
		expect((await readHookState("amp", session_id))?.cwd).toBe("/work/alpha");
		failRetain = false;
		await handleHook("amp", "user-prompt-submit", { session_id, cwd: "/work/beta", prompt: "Beta" });
		expect(retains().at(-1)?.body).toMatchObject({
			items: [{ tags: ["project:alpha"], document_id: "bridge:amp:transition-failure:0" }],
		});
		expect((await readHookState("amp", session_id))?.cwd).toBe("/work/beta");
	});

	it("flushes each project separately and uses new document identities when returning to a project", async () => {
		mentalModelsEnabled = true;
		await writeBridgeConfig();
		const session_id = "transition";
		const alpha = turns(1, "alpha");
		const beta = turns(1, "beta");
		const gamma = turns(1, "return");
		const started = await handleHook("amp", "session-start", { session_id, cwd: "/work/alpha" });
		expect(started?.hookSpecificOutput.additionalContext).toContain("Alpha uses immutable records.");
		expect(started?.hookSpecificOutput.additionalContext).not.toContain("Beta uses message queues.");
		await handleHook("amp", "user-prompt-submit", { session_id, cwd: "/work/alpha", prompt: "Alpha" });
		await handleHook("amp", "stop", { session_id, cwd: "/work/alpha", messages: alpha });
		const moved = await handleHook("amp", "user-prompt-submit", { session_id, cwd: "/work/beta", prompt: "Beta" });
		expect(moved?.hookSpecificOutput.additionalContext).toContain('"cwd":"/work/beta"');
		expect(moved?.hookSpecificOutput.additionalContext).toContain("Beta uses message queues.");
		expect(moved?.hookSpecificOutput.additionalContext).toContain("Prefer explicit errors.");
		expect(moved?.hookSpecificOutput.additionalContext).not.toContain("Alpha uses immutable records.");
		expect(moved?.hookSpecificOutput.additionalContext).toContain(
			"Do not apply memories or mental models from the previous project",
		);
		await handleHook("amp", "stop", { session_id, cwd: "/work/beta", messages: [...alpha, ...beta] });
		const returned = await handleHook("amp", "user-prompt-submit", {
			session_id,
			cwd: "/work/alpha",
			prompt: "Return",
		});
		expect(returned?.hookSpecificOutput.additionalContext).toContain("Alpha uses immutable records.");
		expect(returned?.hookSpecificOutput.additionalContext).not.toContain("Beta uses message queues.");
		await handleHook("amp", "session-end", {
			session_id,
			cwd: "/work/alpha",
			messages: [...alpha, ...beta, ...gamma],
		});
		const retained = retains();
		expect(retained).toHaveLength(3);
		for (const [index, tag] of ["alpha", "beta", "alpha"].entries()) {
			expect(retained[index].body).toMatchObject({
				items: [
					{
						document_id: `bridge:amp:transition:${index}`,
						tags: [`project:${tag}`],
						observation_scopes: [[`project:${tag}`]],
						metadata: { session_id, cwd: `/work/${tag}` },
					},
				],
			});
		}
		expect(JSON.stringify(retained[0].body)).toContain("alpha decision");
		expect(JSON.stringify(retained[0].body)).not.toContain("beta decision");
		expect(JSON.stringify(retained[1].body)).toContain("beta decision");
		expect(JSON.stringify(retained[1].body)).not.toContain("alpha decision");
		expect(JSON.stringify(retained[2].body)).toContain("return decision");
		expect(JSON.stringify(retained[2].body)).not.toContain("beta decision");
		const recalls = requests.filter(request => request.path.endsWith("/memories/recall"));
		expect(recalls.map(request => request.body?.tags)).toEqual([
			["project:alpha"],
			["project:beta"],
			["project:alpha"],
		]);
	});

	it("does not mix simultaneous host sessions", async () => {
		await writeBridgeConfig();
		await Promise.all(
			["alpha", "beta"].map(async project => {
				const payload = { session_id: `parallel-${project}`, cwd: `/work/${project}` };
				await handleHook("amp", "session-start", payload);
				await handleHook("amp", "user-prompt-submit", { ...payload, prompt: project });
				await handleHook("amp", "session-end", { ...payload, messages: turns(1, project) });
			}),
		);
		expect(retains()).toHaveLength(2);
		for (const project of ["alpha", "beta"]) {
			const retained = retains().find(request =>
				JSON.stringify(request.body).includes(`bridge:amp:parallel-${project}:0`),
			);
			expect(retained?.body).toMatchObject({
				items: [{ tags: [`project:${project}`], metadata: { session_id: `parallel-${project}` } }],
			});
			expect(JSON.stringify(retained?.body)).toContain(`${project} decision`);
			expect(JSON.stringify(retained?.body)).not.toContain(`${project === "alpha" ? "beta" : "alpha"} decision`);
		}
	});

	it("excludes an ambiguous late project transition instead of retagging its transcript", async () => {
		mentalModelsEnabled = true;
		await writeBridgeConfig();
		const session_id = "late-transition";
		await handleHook("amp", "session-start", { session_id, cwd: "/work/alpha" });
		await handleHook("amp", "stop", { session_id, cwd: "/work/alpha", messages: turns(1, "alpha") });
		const mixed = [...turns(1, "alpha"), ...turns(1, "unknown")];
		await expect(handleHook("amp", "stop", { session_id, cwd: "/work/beta", messages: mixed })).rejects.toThrow(
			"Transcript boundary changed",
		);
		const nextPrompt = await handleHook("amp", "user-prompt-submit", {
			session_id,
			cwd: "/work/beta",
			prompt: "Continue in beta",
		});
		expect(nextPrompt?.hookSpecificOutput.additionalContext).toContain("Beta uses message queues.");
		expect(nextPrompt?.hookSpecificOutput.additionalContext).toContain(
			"Do not apply memories or mental models from the previous project",
		);
		await handleHook("amp", "session-end", {
			session_id,
			cwd: "/work/beta",
			messages: [...mixed, ...turns(1, "beta")],
		});
		expect(retains()).toHaveLength(2);
		expect(JSON.stringify(retains()[1].body)).toContain("beta decision");
		expect(JSON.stringify(retains()[1].body)).not.toContain("alpha decision");
		expect(JSON.stringify(retains()[1].body)).not.toContain("unknown decision");
	});

	it("rejects rewritten history and continues only after its new boundary", async () => {
		await writeBridgeConfig();
		const payload = { session_id: "rewrite", cwd: "/work/config" };
		await handleHook("amp", "session-start", payload);
		await handleHook("amp", "stop", { ...payload, messages: turns(1) });
		await expect(handleHook("amp", "stop", { ...payload, messages: turns(1, "rewritten") })).rejects.toThrow(
			"Transcript boundary changed",
		);
		await handleHook("amp", "session-end", {
			...payload,
			messages: [...turns(1, "rewritten"), ...turns(1, "next")],
		});
		expect(JSON.stringify(retains().at(-1)?.body)).toContain("config decision");
		expect(JSON.stringify(retains().at(-1)?.body)).toContain("next decision");
		expect(JSON.stringify(retains().at(-1)?.body)).not.toContain("rewritten decision");
	});

	it("updates the binding within one repository without splitting its transcript or recalling again", async () => {
		mentalModelsEnabled = true;
		await writeBridgeConfig();
		const root = path.join(tempRoot, "Repository");
		const nested = path.join(root, "src");
		await fs.mkdir(path.join(root, ".git"), { recursive: true });
		await fs.mkdir(nested);
		const session_id = "nested-cwd";
		await handleHook("amp", "session-start", { session_id, cwd: root });
		await handleHook("amp", "user-prompt-submit", { session_id, cwd: root, prompt: "First" });
		await handleHook("amp", "stop", { session_id, cwd: root, messages: turns(1) });
		const modelRequests = requests.filter(
			request => request.method === "GET" && request.path.includes("/mental-models"),
		).length;
		const moved = await handleHook("amp", "user-prompt-submit", { session_id, cwd: nested, prompt: "Second" });
		expect(moved?.hookSpecificOutput.additionalContext).toContain(JSON.stringify(nested));
		expect(moved?.hookSpecificOutput.additionalContext).not.toContain("previous project");
		expect(
			requests.filter(request => request.method === "GET" && request.path.includes("/mental-models")),
		).toHaveLength(modelRequests);
		await handleHook("amp", "session-end", { session_id, cwd: nested, messages: turns(2) });
		expect(requests.filter(request => request.path.endsWith("/memories/recall"))).toHaveLength(1);
		expect(retains()).toHaveLength(1);
		expect(retains()[0].body).toMatchObject({
			items: [{ document_id: "bridge:amp:nested-cwd:0", tags: ["project:repository"] }],
		});
		expect(JSON.stringify(retains()[0].body)).toContain("config decision 1");
		expect(JSON.stringify(retains()[0].body)).toContain("config decision 2");
	});

	it("rejects an invalid cadence before storing or retaining a session", async () => {
		await writeBridgeConfig();
		process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS = "0";
		await expect(
			handleHook("amp", "session-start", { session_id: "invalid-cadence", cwd: "/work/config" }),
		).rejects.toThrow("HINDSIGHT_RETAIN_EVERY_N_TURNS");
		expect(await readHookState("amp", "invalid-cadence")).toBeUndefined();
		expect(requests).toHaveLength(0);
	});

	it("does not attribute untracked history when the first hook is Stop", async () => {
		await writeBridgeConfig();
		const payload = { session_id: "untracked", cwd: "/work/config" };
		await expect(handleHook("amp", "stop", { ...payload, messages: turns(1, "unknown") })).rejects.toThrow(
			"Transcript boundary changed",
		);
		expect(retains()).toHaveLength(0);
		await handleHook("amp", "session-end", {
			...payload,
			messages: [...turns(1, "unknown"), ...turns(1, "known")],
		});
		expect(retains()).toHaveLength(1);
		expect(JSON.stringify(retains()[0].body)).toContain("known decision");
		expect(JSON.stringify(retains()[0].body)).not.toContain("unknown decision");
	});
});
