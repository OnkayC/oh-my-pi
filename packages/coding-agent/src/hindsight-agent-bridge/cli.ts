#!/usr/bin/env bun

import packageJson from "../../package.json" with { type: "json" };
import { loadBridgeConfig } from "./config";
import type { BridgeHarness } from "./hook-state";
import { type HookEvent, handleHook } from "./hooks";
import { runMcpServer } from "./mcp";
import { createBridgeRuntime, ensureBridgeBankAndModels, listVisibleMentalModels } from "./runtime";
import skillText from "./SKILL.md" with { type: "text" };

const VERSION = packageJson.version;
const HARNESSES: readonly BridgeHarness[] = ["codex", "grok"];
const HOOK_EVENTS: readonly HookEvent[] = ["session-start", "user-prompt-submit", "stop"];

function requiredChoice<T extends string>(value: string | undefined, choices: readonly T[], label: string): T {
	if (!value || !choices.includes(value as T)) throw new Error(`${label} must be one of: ${choices.join(", ")}.`);
	return value as T;
}

async function readHookInput(): Promise<unknown> {
	const text = await Bun.stdin.text();
	if (!text.trim()) throw new Error("Hook command requires a JSON object on stdin.");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Hook command received invalid JSON on stdin.");
	}
}

interface DiagnoseOptions {
	cwd: string;
	online: boolean;
	json: boolean;
}

function diagnoseOptions(args: string[]): DiagnoseOptions {
	let cwd = process.cwd();
	let online = false;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		switch (args[index]) {
			case "--cwd":
				cwd = args[index + 1] ?? "";
				index += 1;
				break;
			case "--online":
				online = true;
				break;
			case "--json":
				json = true;
				break;
			default:
				throw new Error(`Unknown diagnose argument: ${args[index]}`);
		}
	}
	if (!cwd.trim()) throw new Error("diagnose --cwd requires a path.");
	if (!json) throw new Error("diagnose requires --json.");
	return { cwd, online, json };
}

async function diagnose(args: string[]): Promise<void> {
	const options = diagnoseOptions(args);
	const config = loadBridgeConfig();
	const runtime = await createBridgeRuntime(config, options.cwd);
	const output: Record<string, unknown> = {
		version: VERSION,
		configPath: config.configPath,
		configMode: config.configMode.toString(8).padStart(4, "0"),
		apiOrigin: new URL(config.apiUrl).origin,
		primaryRoot: runtime.primaryRoot,
		bankId: runtime.scope.bankId,
		projectTag: runtime.scope.recallTags?.[0] ?? null,
		recallTagsMatch: runtime.scope.recallTagsMatch ?? null,
		observationScopes: runtime.scope.observationScopes ?? null,
	};
	if (options.online) {
		await ensureBridgeBankAndModels(runtime);
		output.reachable = true;
		output.mentalModelIds = (await listVisibleMentalModels(runtime)).map(model => model.id);
	}
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function hook(args: string[]): Promise<void> {
	const harness = requiredChoice(args[0], HARNESSES, "Hook harness");
	const event = requiredChoice(args[1], HOOK_EVENTS, "Hook event");
	if (args.length !== 2) throw new Error("Hook command accepts exactly a harness and event.");
	try {
		const output = await handleHook(harness, event, await readHookInput());
		if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`hindsight-agent-bridge hook: ${message}\n`);
	}
}

async function mcp(): Promise<void> {
	const harness = requiredChoice(process.env.HINDSIGHT_HARNESS, HARNESSES, "HINDSIGHT_HARNESS");
	const runtime = await createBridgeRuntime(loadBridgeConfig(), process.cwd());
	await runMcpServer(runtime, harness);
}

export async function runBridgeCli(args: string[] = process.argv.slice(2)): Promise<number> {
	try {
		if (args.length === 1 && args[0] === "--version") {
			process.stdout.write(`${VERSION}\n`);
			return 0;
		}
		switch (args[0]) {
			case "diagnose":
				await diagnose(args.slice(1));
				return 0;
			case "hook":
				await hook(args.slice(1));
				return 0;
			case "mcp":
				if (args.length !== 1) throw new Error("mcp accepts no arguments.");
				await mcp();
				return 0;
			case "skill":
				if (args.length !== 1) throw new Error("skill accepts no arguments.");
				process.stdout.write(skillText);
				return 0;
			default:
				throw new Error(
					"Usage: hindsight-agent-bridge --version | diagnose [--cwd PATH] [--online] --json | mcp | hook <codex|grok> <session-start|user-prompt-submit|stop> | skill",
				);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`hindsight-agent-bridge: ${message}\n`);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await runBridgeCli();
}
