#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadBridgeConfig } from "../src/hindsight-agent-bridge/config";
import { createBridgeRuntime } from "../src/hindsight-agent-bridge/runtime";
import { expectedGrokTranscriptPath } from "../src/hindsight-agent-bridge/transcripts";

interface SmokeOptions {
	binary: string;
	config: string;
	project: string;
	otherProject: string;
	worktree: string;
}

function parseOptions(args: string[]): SmokeOptions {
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag?.startsWith("--") || !value) throw new Error(`Invalid smoke argument near '${flag ?? "<end>"}'.`);
		values[flag] = value;
	}
	for (const flag of ["--binary", "--config", "--project", "--other-project", "--worktree"]) {
		if (!values[flag]) throw new Error(`Missing required smoke option ${flag}.`);
	}
	return {
		binary: path.resolve(values["--binary"]),
		config: path.resolve(values["--config"]),
		project: path.resolve(values["--project"]),
		otherProject: path.resolve(values["--other-project"]),
		worktree: path.resolve(values["--worktree"]),
	};
}

function childEnv(overrides: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...overrides };
}

async function runHook(
	binary: string,
	harness: "codex" | "grok",
	event: "session-start" | "stop",
	input: Record<string, unknown>,
	env: Record<string, string>,
): Promise<void> {
	const processHandle = Bun.spawn([binary, "hook", harness, event], {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	processHandle.stdin.write(JSON.stringify(input));
	processHandle.stdin.end();
	const [exitCode, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
	if (exitCode !== 0 || stderr.trim()) {
		throw new Error(`${harness} ${event} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
}

function recalledText(response: { results?: Array<{ text?: string }> }): string {
	return (response.results ?? []).map(result => result.text ?? "").join("\n");
}

function documentHasScope(document: Record<string, unknown> | null, projectTag: string): boolean {
	if (!document) return false;
	const tags = Array.isArray(document.tags) ? document.tags : [];
	return tags.includes(projectTag) && JSON.stringify(document.observation_scopes) === JSON.stringify([[projectTag]]);
}

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(1_000);
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	process.env.HINDSIGHT_BRIDGE_CONFIG = options.config;
	const config = loadBridgeConfig();
	const project = await createBridgeRuntime(config, options.project);
	const other = await createBridgeRuntime(config, options.otherProject);
	const worktree = await createBridgeRuntime(config, options.worktree);
	if (project.scope.recallTags?.[0] !== "project:config") {
		throw new Error(`Expected project:config, got ${project.scope.recallTags?.[0] ?? "<none>"}.`);
	}
	if (worktree.scope.recallTags?.[0] !== "project:oh-my-pi") {
		throw new Error(`Expected worktree project:oh-my-pi, got ${worktree.scope.recallTags?.[0] ?? "<none>"}.`);
	}

	const smokeId = randomUUID();
	const prefix = `bridge-smoke:${smokeId}`;
	const projectToken = `${prefix}:project-token`;
	const globalToken = `${prefix}:global-token`;
	const projectDocumentId = `${prefix}:project`;
	const globalDocumentId = `${prefix}:global`;
	const codexSessionId = `${prefix}:codex`;
	const grokSessionId = `${prefix}:grok`;
	const ownedDocumentIds = [projectDocumentId, globalDocumentId, codexSessionId, grokSessionId];
	if (ownedDocumentIds.some(documentId => !documentId.startsWith("bridge-smoke:"))) {
		throw new Error("Refusing to run with unsafe cleanup document ids.");
	}
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-agent-bridge-smoke-"));
	const env = childEnv({
		HINDSIGHT_BRIDGE_CONFIG: options.config,
		HOME: tempRoot,
		XDG_CACHE_HOME: path.join(tempRoot, "cache"),
	});
	try {
		await project.client.retain(
			project.scope.bankId,
			`The configuration project bridge smoke identifier is ${projectToken}.`,
			{
				documentId: projectDocumentId,
				updateMode: "replace",
				tags: project.scope.retainTags,
				observationScopes: project.scope.observationScopes,
				async: true,
			},
		);
		await project.client.retain(
			project.scope.bankId,
			`The shared global bridge smoke identifier is ${globalToken}.`,
			{
				documentId: globalDocumentId,
				updateMode: "replace",
				async: true,
			},
		);
		await waitFor("project and global recalls", async () => {
			const [projectRecall, otherRecall, projectGlobal, otherGlobal] = await Promise.all([
				project.client.recall(
					project.scope.bankId,
					`What is the configuration project bridge smoke identifier ${projectToken}?`,
					{
						tags: project.scope.recallTags,
						tagsMatch: project.scope.recallTagsMatch,
					},
				),
				other.client.recall(
					other.scope.bankId,
					`What is the configuration project bridge smoke identifier ${projectToken}?`,
					{
						tags: other.scope.recallTags,
						tagsMatch: other.scope.recallTagsMatch,
					},
				),
				project.client.recall(
					project.scope.bankId,
					`What is the shared global bridge smoke identifier ${globalToken}?`,
					{
						tags: project.scope.recallTags,
						tagsMatch: project.scope.recallTagsMatch,
					},
				),
				other.client.recall(
					other.scope.bankId,
					`What is the shared global bridge smoke identifier ${globalToken}?`,
					{
						tags: other.scope.recallTags,
						tagsMatch: other.scope.recallTagsMatch,
					},
				),
			]);
			return (
				recalledText(projectRecall).includes(projectToken) &&
				!recalledText(otherRecall).includes(projectToken) &&
				recalledText(projectGlobal).includes(globalToken) &&
				recalledText(otherGlobal).includes(globalToken)
			);
		});

		const mcpClient = new Client({ name: "hindsight-bridge-smoke", version: "1" });
		const transport = new StdioClientTransport({
			command: options.binary,
			args: ["mcp"],
			cwd: options.project,
			env: { ...env, HINDSIGHT_HARNESS: "codex" },
			stderr: "pipe",
		});
		try {
			await mcpClient.connect(transport);
			const tools = await mcpClient.listTools();
			if (
				tools.tools
					.map(tool => tool.name)
					.sort()
					.join(",") !== "recall,reflect,retain"
			) {
				throw new Error("Compiled MCP server exposed an unexpected tool set.");
			}
			const result = await mcpClient.callTool({
				name: "recall",
				arguments: { query: `What is the shared global bridge smoke identifier ${globalToken}?` },
			});
			if (!JSON.stringify(result.content).includes(prefix))
				throw new Error("Compiled MCP recall missed global smoke memory.");
		} finally {
			await mcpClient.close();
		}

		const codexTranscript = path.join(tempRoot, "codex.jsonl");
		await fs.writeFile(
			codexTranscript,
			`${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Codex hook smoke ${prefix}` }] } })}\n`,
		);
		await runHook(
			options.binary,
			"codex",
			"session-start",
			{ session_id: codexSessionId, cwd: options.project },
			env,
		);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await runHook(
				options.binary,
				"codex",
				"stop",
				{ session_id: codexSessionId, cwd: options.project, transcript_path: codexTranscript },
				env,
			);
		}

		const grokTranscript = expectedGrokTranscriptPath(options.project, grokSessionId, env);
		await fs.mkdir(path.dirname(grokTranscript), { recursive: true });
		await fs.writeFile(
			grokTranscript,
			`${JSON.stringify({ role: "user", prompt_index: 0, content: `Grok hook smoke ${prefix}` })}\n`,
		);
		await runHook(options.binary, "grok", "session-start", { sessionId: grokSessionId, cwd: options.project }, env);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await runHook(options.binary, "grok", "stop", { sessionId: grokSessionId, cwd: options.project }, env);
		}
		await waitFor("hook session documents", async () => {
			const [codexDocument, grokDocument] = await Promise.all([
				project.client.getDocument(project.scope.bankId, codexSessionId),
				project.client.getDocument(project.scope.bankId, grokSessionId),
			]);
			const projectTag = project.scope.retainTags?.[0];
			if (!projectTag) return false;
			return documentHasScope(codexDocument, projectTag) && documentHasScope(grokDocument, projectTag);
		});
		console.log("Hindsight agent bridge smoke passed.");
	} finally {
		for (const documentId of ownedDocumentIds) {
			await project.client.deleteDocument(project.scope.bankId, documentId).catch(() => false);
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

await main();
