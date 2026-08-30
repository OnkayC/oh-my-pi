import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type HindsightMessage, hasSubstantiveContent, stripMemoryTags } from "../hindsight/content";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			parts.push(item);
			continue;
		}
		const block = record(item);
		const text = block?.text ?? block?.content ?? block?.output_text ?? block?.input_text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}

function timestamp(value: unknown): string | undefined {
	if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return undefined;
}

function normalizedMessage(role: string, content: string, at?: string): HindsightMessage | undefined {
	const clean = stripMemoryTags(content).trim();
	if (!hasSubstantiveContent(clean)) return undefined;
	return { role, content: clean, timestamp: at };
}

function syntheticCodexMessage(content: string): boolean {
	const trimmed = content.trimStart();
	return (
		trimmed.startsWith("# AGENTS.md instructions") ||
		trimmed.startsWith("<environment_context>") ||
		trimmed.startsWith("<system-reminder>")
	);
}

function codexEntry(value: unknown): HindsightMessage[] {
	const envelope = record(value);
	if (envelope?.type !== "response_item") return [];
	const payload = record(envelope.payload) ?? envelope;
	const at = timestamp(envelope.timestamp ?? payload.timestamp);
	if (payload.type === "message") {
		const role = typeof payload.role === "string" ? payload.role : "assistant";
		const content = textContent(payload.content);
		if (syntheticCodexMessage(content)) return [];
		const message = normalizedMessage(role, content, at);
		return message ? [message] : [];
	}
	if (payload.type === "function_call" || payload.type === "custom_tool_call") {
		const name = typeof payload.name === "string" ? payload.name : "tool";
		const argumentsText = textContent(payload.arguments ?? payload.input);
		const message = normalizedMessage("action", `${name}${argumentsText ? ` ${argumentsText}` : ""}`, at);
		return message ? [message] : [];
	}
	return [];
}

function grokToolMessages(message: Record<string, unknown>, at?: string): HindsightMessage[] {
	if (!Array.isArray(message.tool_calls)) return [];
	const actions: HindsightMessage[] = [];
	for (const rawCall of message.tool_calls) {
		const call = record(rawCall);
		const fn = record(call?.function);
		const name = typeof fn?.name === "string" ? fn.name : typeof call?.name === "string" ? call.name : "tool";
		const argumentsText = textContent(fn?.arguments ?? call?.arguments ?? call?.input);
		const action = normalizedMessage("action", `${name}${argumentsText ? ` ${argumentsText}` : ""}`, at);
		if (action) actions.push(action);
	}
	return actions;
}

function grokEntry(value: unknown): HindsightMessage[] {
	const envelope = record(value);
	if (!envelope) return [];
	const message = record(envelope.message) ?? envelope;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return [];
	if (role === "user" && (typeof message.prompt_index !== "number" || !Number.isFinite(message.prompt_index))) {
		return [];
	}
	const at = timestamp(message.timestamp ?? envelope.timestamp);
	const output: HindsightMessage[] = [];
	const content = normalizedMessage(role, textContent(message.content), at);
	if (content) output.push(content);
	output.push(...grokToolMessages(message, at));
	return output;
}

async function parseJsonLines(
	filePath: string,
	parser: (value: unknown) => HindsightMessage[],
): Promise<HindsightMessage[]> {
	const text = await fs.readFile(filePath, "utf8");
	const messages: HindsightMessage[] = [];
	for (const line of text.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		try {
			messages.push(...parser(JSON.parse(line)));
		} catch {}
	}
	return messages;
}

export async function parseCodexTranscript(filePath: string): Promise<HindsightMessage[]> {
	return await parseJsonLines(filePath, codexEntry);
}

export async function parseGrokTranscript(filePath: string): Promise<HindsightMessage[]> {
	return await parseJsonLines(filePath, grokEntry);
}

export function expectedGrokTranscriptPath(
	cwd: string,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const home = env.HOME?.trim() || os.homedir();
	return path.join(home, ".grok", "sessions", encodeURIComponent(cwd), sessionId, "chat_history.jsonl");
}

export async function resolveGrokTranscriptPath(
	cwd: string,
	sessionId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const expected = expectedGrokTranscriptPath(cwd, sessionId, env);
	try {
		await fs.access(expected);
		return expected;
	} catch {
		const sessionsRoot = path.join(env.HOME?.trim() || os.homedir(), ".grok", "sessions");
		const matches: string[] = [];
		async function scan(directory: string, depth: number): Promise<void> {
			if (depth > 4) return;
			let entries: Dirent[];
			try {
				entries = await fs.readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const child = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					await scan(child, depth + 1);
				} else if (
					entry.isFile() &&
					entry.name === "chat_history.jsonl" &&
					path.basename(path.dirname(child)) === sessionId
				) {
					matches.push(child);
				}
			}
		}
		await scan(sessionsRoot, 0);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new Error(`Multiple Grok transcripts found for session ${sessionId}.`);
		throw new Error(`Grok transcript not found for session ${sessionId}.`);
	}
}
