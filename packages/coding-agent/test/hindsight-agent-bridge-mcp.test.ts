import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBridgeConfig } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/config";
import { handleHook } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/hooks";
import { createMcpServer } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/mcp";
import type { Server } from "bun";

interface CapturedRequest {
	path: string;
	method: string;
	body?: Record<string, unknown>;
}

const originalEnv = {
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
	HINDSIGHT_BRIDGE_CONFIG: process.env.HINDSIGHT_BRIDGE_CONFIG,
	HINDSIGHT_RETAIN_EVERY_N_TURNS: process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS,
};
let tempRoot: string;
let httpServer: Server<undefined>;
let mcpServer: McpServer;
let client: Client;
let requests: CapturedRequest[];

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "hindsight-bridge-mcp-"));
	process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
	process.env.HINDSIGHT_BRIDGE_CONFIG = path.join(tempRoot, "bridge.json");
	delete process.env.HINDSIGHT_RETAIN_EVERY_N_TURNS;
	requests = [];
	httpServer = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = request.method === "GET" ? "" : await request.text();
			requests.push({
				path: url.pathname,
				method: request.method,
				body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
			});
			if (url.pathname.endsWith("/memories/recall")) {
				return Response.json({ results: [{ text: "Scoped memory", type: "world" }] });
			}
			if (url.pathname.endsWith("/reflect")) return Response.json({ text: "Scoped synthesis" });
			return Response.json({});
		},
	});
	await fs.writeFile(
		process.env.HINDSIGHT_BRIDGE_CONFIG,
		JSON.stringify({
			apiUrl: httpServer.url.origin,
			apiToken: "test-token",
			bankId: "coding-agents",
			scoping: "per-project-tagged",
			mentalModelsEnabled: false,
		}),
		{ mode: 0o600 },
	);
	mcpServer = createMcpServer(loadBridgeConfig(), "codex");
	client = new Client({ name: "bridge-test", version: "1" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
	await client?.close();
	await mcpServer?.close();
	httpServer?.stop(true);
	await fs.rm(tempRoot, { recursive: true, force: true });
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("Hindsight agent bridge MCP server", () => {
	it("scopes all three tools to their hook session instead of the server working directory", async () => {
		const scope = { session_id: "tool-session", cwd: "/work/config" };
		await handleHook("codex", "session-start", scope);
		const tools = await client.listTools();
		expect(tools.tools.map(tool => tool.name).sort()).toEqual(["recall", "reflect", "retain"]);
		const recall = await client.callTool({ name: "recall", arguments: { scope, query: "policy" } });
		const reflect = await client.callTool({
			name: "reflect",
			arguments: { scope, query: "summarize", context: "config" },
		});
		const retain = await client.callTool({
			name: "retain",
			arguments: { scope, items: [{ content: "Durable project fact", context: "test" }] },
		});
		expect(JSON.stringify(recall.content)).toContain("Scoped memory");
		expect(JSON.stringify(reflect.content)).toContain("Scoped synthesis");
		expect(JSON.stringify(retain.content)).toContain("1 memory queued");
		const recallRequest = requests.find(request => request.path.endsWith("/memories/recall"));
		const reflectRequest = requests.find(request => request.path.endsWith("/reflect"));
		const retainRequest = requests.find(
			request => request.method === "POST" && request.path.endsWith("/memories") && request.body?.items,
		);
		expect(recallRequest?.body).toMatchObject({ tags: ["project:config"], tags_match: "any" });
		expect(reflectRequest?.body).toMatchObject({ tags: ["project:config"], tags_match: "any" });
		expect(retainRequest?.body).toMatchObject({
			async: true,
			items: [
				{
					tags: ["project:config"],
					observation_scopes: [["project:config"]],
					metadata: { session_id: "tool-session", harness: "codex", cwd: "/work/config" },
				},
			],
		});
	});

	it("fails closed for missing, unknown, mismatched, or foreign-harness session bindings", async () => {
		const scope = { session_id: "known", cwd: "/work/config" };
		await handleHook("codex", "session-start", scope);
		await handleHook("amp", "session-start", { session_id: "amp-only", cwd: scope.cwd });
		const requestCount = requests.length;
		const missing = await client.callTool({ name: "recall", arguments: { query: "secret" } });
		const missingCodexId = await client.callTool({
			name: "recall",
			arguments: { scope: { cwd: scope.cwd }, query: "secret" },
		});
		const unknown = await client.callTool({
			name: "reflect",
			arguments: { scope: { ...scope, session_id: "unknown" }, query: "secret" },
		});
		const mismatch = await client.callTool({
			name: "retain",
			arguments: { scope: { ...scope, cwd: "/work/other" }, items: [{ content: "secret" }] },
		});
		const foreign = await client.callTool({
			name: "recall",
			arguments: { scope: { ...scope, session_id: "amp-only" }, query: "secret" },
		});
		expect(missing.isError).toBe(true);
		expect(missingCodexId.isError).toBe(true);
		expect(unknown.isError).toBe(true);
		expect(mismatch.isError).toBe(true);
		expect(foreign.isError).toBe(true);
		expect(JSON.stringify(unknown.content)).toContain("No hook state");
		expect(JSON.stringify(mismatch.content)).toContain("Stale Hindsight session scope");
		expect(requests).toHaveLength(requestCount);
	});

	it("refreshes scope on each call after a project transition and rejects the old binding", async () => {
		const oldScope = { session_id: "moving-session", cwd: "/work/alpha" };
		const newScope = { ...oldScope, cwd: "/work/beta" };
		await handleHook("codex", "session-start", oldScope);
		await client.callTool({ name: "recall", arguments: { scope: oldScope, query: "before" } });
		await handleHook("codex", "user-prompt-submit", { ...newScope, prompt: "new project" });
		const requestCount = requests.length;
		const stale = await client.callTool({
			name: "retain",
			arguments: { scope: oldScope, items: [{ content: "old" }] },
		});
		expect(stale.isError).toBe(true);
		expect(requests).toHaveLength(requestCount);
		const refreshed = await client.callTool({ name: "reflect", arguments: { scope: newScope, query: "after" } });
		expect(refreshed.isError).not.toBe(true);
		const reflected = requests.find(request => request.path.endsWith("/reflect"));
		expect(reflected?.body).toMatchObject({ tags: ["project:beta"], tags_match: "any" });
	});

	it("keeps simultaneous sessions separate within one MCP process", async () => {
		const scopes = [
			{ session_id: "alpha-session", cwd: "/work/alpha" },
			{ session_id: "beta-session", cwd: "/work/beta" },
		];
		await Promise.all(scopes.map(scope => handleHook("codex", "session-start", scope)));
		await Promise.all(
			scopes.map(scope =>
				client.callTool({
					name: "retain",
					arguments: { scope, items: [{ content: `${scope.session_id} decision` }] },
				}),
			),
		);
		const retained = requests.filter(request => request.method === "POST" && request.body?.items);
		expect(retained).toHaveLength(2);
		for (const project of ["alpha", "beta"]) {
			const request = retained.find(item => JSON.stringify(item.body).includes(`${project}-session decision`));
			expect(request?.body).toMatchObject({
				items: [
					{
						tags: [`project:${project}`],
						observation_scopes: [[`project:${project}`]],
						metadata: { session_id: `${project}-session`, cwd: `/work/${project}` },
					},
				],
			});
		}
	});

	it("uses explicit Grok cwd without inventing a session or using the last active hook", async () => {
		await client.close();
		await mcpServer.close();
		mcpServer = createMcpServer(loadBridgeConfig(), "grok");
		client = new Client({ name: "grok-bridge-test", version: "1" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
		await handleHook("grok", "session-start", { sessionId: "unrelated-session", cwd: "/work/unrelated" });
		const recalled = await client.callTool({
			name: "recall",
			arguments: { scope: { cwd: "/work/alpha" }, query: "first project" },
		});
		const reflected = await client.callTool({
			name: "reflect",
			arguments: { scope: { cwd: "/work/beta" }, query: "second project" },
		});
		const retained = await client.callTool({
			name: "retain",
			arguments: { scope: { cwd: "/work/beta" }, items: [{ content: "Beta decision" }] },
		});
		expect(recalled.isError).not.toBe(true);
		expect(reflected.isError).not.toBe(true);
		expect(retained.isError).not.toBe(true);
		expect(requests.find(request => request.path.endsWith("/memories/recall"))?.body).toMatchObject({
			tags: ["project:alpha"],
			tags_match: "any",
		});
		expect(requests.find(request => request.path.endsWith("/reflect"))?.body).toMatchObject({
			tags: ["project:beta"],
			tags_match: "any",
		});
		const retainedRequest = requests.find(request => request.method === "POST" && request.body?.items);
		expect(retainedRequest?.body).toMatchObject({
			items: [{ tags: ["project:beta"], metadata: { harness: "grok", cwd: "/work/beta" } }],
		});
		expect(JSON.stringify(retainedRequest?.body)).not.toContain("session_id");
		expect(JSON.stringify(retainedRequest?.body)).not.toContain("unrelated");
		const requestCount = requests.length;
		const invalid = await client.callTool({
			name: "recall",
			arguments: { scope: { cwd: "/work/beta", session_id: "unknown" }, query: "invalid session" },
		});
		const relative = await client.callTool({
			name: "recall",
			arguments: { scope: { cwd: "beta" }, query: "ambiguous directory" },
		});
		expect(invalid.isError).toBe(true);
		expect(relative.isError).toBe(true);
		expect(requests).toHaveLength(requestCount);
	});
});
