import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureBankExists } from "../hindsight/bank";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import reflectDescription from "../prompts/tools/reflect.md" with { type: "text" };
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { BridgeHarness } from "./hook-state";
import type { BridgeRuntime } from "./runtime";

const recallInput = z.object({ query: z.string().describe("natural language search query") });
const reflectInput = z.object({
	query: z.string().describe("question to answer"),
	context: z.string().optional().describe("optional context"),
});
const retainInput = z.object({
	items: z
		.array(
			z.object({
				content: z.string().describe("information to remember"),
				context: z.string().optional().describe("source context"),
			}),
		)
		.min(1)
		.describe("memories to retain"),
});

interface BridgeToolResult {
	content: Array<{ type: "text"; text: string }>;
}

interface BridgeToolServer {
	registerTool(
		name: string,
		config: { description: string; inputSchema: z.ZodTypeAny },
		handler: (input: unknown) => Promise<BridgeToolResult>,
	): unknown;
}

export function createMcpServer(runtime: BridgeRuntime, harness: BridgeHarness): McpServer {
	const server = new McpServer({ name: "hindsight-agent-bridge", version: "1" });
	// SDK 1.30 supports Zod 3 and 4 through a recursive compatibility type that
	// TypeScript 7 cannot finitely expand. Keep that generic at this boundary and
	// parse each callback input with the exact schema before use.
	const tools = server as unknown as BridgeToolServer;
	tools.registerTool("recall", { description: recallDescription, inputSchema: recallInput }, async input => {
		const { query } = recallInput.parse(input);
		const response = await runtime.client.recall(runtime.scope.bankId, query, {
			budget: runtime.config.hindsight.recallBudget,
			maxTokens: runtime.config.hindsight.recallMaxTokens,
			types: runtime.config.hindsight.recallTypes.length > 0 ? runtime.config.hindsight.recallTypes : undefined,
			tags: runtime.scope.recallTags,
			tagsMatch: runtime.scope.recallTagsMatch,
		});
		const results = response.results ?? [];
		const text =
			results.length === 0
				? "No relevant memories found."
				: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatMemories(results)}`;
		return { content: [{ type: "text", text }] };
	});
	tools.registerTool("reflect", { description: reflectDescription, inputSchema: reflectInput }, async input => {
		const { query, context } = reflectInput.parse(input);
		await ensureBankExists(runtime.client, runtime.scope.bankId, runtime.config.hindsight, runtime.banksSet);
		const response = await runtime.client.reflect(runtime.scope.bankId, query, {
			context,
			budget: runtime.config.hindsight.recallBudget,
			tags: runtime.scope.recallTags,
			tagsMatch: runtime.scope.recallTagsMatch,
		});
		return {
			content: [{ type: "text", text: response.text?.trim() || "No relevant information found to reflect on." }],
		};
	});
	tools.registerTool("retain", { description: retainDescription, inputSchema: retainInput }, async input => {
		const { items } = retainInput.parse(input);
		await ensureBankExists(runtime.client, runtime.scope.bankId, runtime.config.hindsight, runtime.banksSet);
		await runtime.client.retainBatch(
			runtime.scope.bankId,
			items.map(item => ({
				content: item.content,
				context: item.context ?? runtime.config.hindsight.retainContext,
				metadata: {
					session_id: runtime.processSessionId,
					harness,
					cwd: runtime.cwd,
				},
				tags: runtime.scope.retainTags,
				observationScopes: runtime.scope.observationScopes,
				timestamp: new Date(),
			})),
			{ async: true },
		);
		const count = items.length;
		return { content: [{ type: "text", text: `${count} ${count === 1 ? "memory" : "memories"} queued.` }] };
	});
	return server;
}

export async function runMcpServer(runtime: BridgeRuntime, harness: BridgeHarness): Promise<void> {
	const server = createMcpServer(runtime, harness);
	await server.connect(new StdioServerTransport());
}
