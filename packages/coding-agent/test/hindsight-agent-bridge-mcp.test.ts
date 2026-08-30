import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/defaults";
import type { BridgeConfig } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/config";
import { createMcpServer } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/mcp";
import { createBridgeRuntime } from "@oh-my-pi/pi-coding-agent/hindsight-agent-bridge/runtime";
import type { Server } from "bun";

interface CapturedRequest {
	path: string;
	method: string;
	body?: Record<string, unknown>;
}

let httpServer: Server<undefined> | undefined;
let mcpServer: McpServer | undefined;
let client: Client | undefined;

afterEach(async () => {
	await client?.close();
	await mcpServer?.close();
	httpServer?.stop(true);
	client = undefined;
	mcpServer = undefined;
	httpServer = undefined;
});

describe("Hindsight agent bridge MCP server", () => {
	it("exposes only scoped recall, reflect, and retain", async () => {
		const requests: CapturedRequest[] = [];
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
		const hindsight = resolveHindsightConfig(
			{
				hindsightApiUrl: httpServer.url.origin,
				hindsightApiToken: "test-token",
				bankId: "coding-agents",
				scoping: "per-project-tagged",
				mentalModelsEnabled: false,
			},
			{},
		);
		const config: BridgeConfig = {
			configPath: "/tmp/bridge.json",
			configMode: 0o600,
			apiUrl: httpServer.url.origin,
			apiToken: "test-token",
			bankId: "coding-agents",
			scoping: "per-project-tagged",
			mentalModelsEnabled: false,
			hindsight,
		};
		const runtime = await createBridgeRuntime(config, "/work/config");
		mcpServer = createMcpServer(runtime, "codex");
		client = new Client({ name: "bridge-test", version: "1" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

		const tools = await client.listTools();
		expect(tools.tools.map(tool => tool.name).sort()).toEqual(["recall", "reflect", "retain"]);
		const recall = await client.callTool({ name: "recall", arguments: { query: "policy" } });
		const reflect = await client.callTool({ name: "reflect", arguments: { query: "summarize", context: "config" } });
		const retain = await client.callTool({
			name: "retain",
			arguments: { items: [{ content: "Durable project fact", context: "test" }] },
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
					metadata: { harness: "codex", cwd: "/work/config" },
				},
			],
		});
	});
});
