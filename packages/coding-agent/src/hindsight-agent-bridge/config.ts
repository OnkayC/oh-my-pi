import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HindsightConfig, HindsightScoping } from "../hindsight/config";
import { HINDSIGHT_SCOPING_VALUES, resolveHindsightConfig } from "../hindsight/defaults";

const CONFIG_KEYS = ["apiToken", "apiUrl", "bankId", "mentalModelsEnabled", "scoping"] as const;

export interface BridgeConfig {
	configPath: string;
	configMode: number;
	apiUrl: string;
	apiToken: string;
	bankId: string;
	scoping: HindsightScoping;
	mentalModelsEnabled: boolean;
	hindsight: HindsightConfig;
}

function configPathFromEnv(env: NodeJS.ProcessEnv): string {
	const configured = env.HINDSIGHT_BRIDGE_CONFIG?.trim();
	if (configured) return path.resolve(configured);
	const home = env.HOME?.trim() || os.homedir();
	return path.join(home, ".hindsight", "agent-bridge.json");
}

function stringProperty(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Bridge config key '${key}' must be a non-empty string.`);
	}
	return value.trim();
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
	const configPath = configPathFromEnv(env);
	let parsed: unknown;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(configPath);
		parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to load Hindsight bridge config at ${configPath}: ${detail}`);
	}
	if (!stat.isFile()) throw new Error(`Hindsight bridge config is not a regular file: ${configPath}`);
	const configMode = stat.mode & 0o777;
	if (process.platform !== "win32" && (configMode & 0o077) !== 0) {
		throw new Error(`Hindsight bridge config must not be group/world accessible: ${configPath}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Hindsight bridge config must be a JSON object: ${configPath}`);
	}
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== CONFIG_KEYS.length || keys.some((key, index) => key !== CONFIG_KEYS[index])) {
		throw new Error(`Hindsight bridge config must contain exactly: ${CONFIG_KEYS.join(", ")}.`);
	}

	const apiUrl = stringProperty(record, "apiUrl");
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(apiUrl);
	} catch {
		throw new Error("Bridge config key 'apiUrl' must be an absolute URL.");
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new Error("Bridge config key 'apiUrl' must use http or https.");
	}
	const apiToken = stringProperty(record, "apiToken");
	const bankId = stringProperty(record, "bankId");
	const scoping = record.scoping;
	if (typeof scoping !== "string" || !HINDSIGHT_SCOPING_VALUES.includes(scoping as HindsightScoping)) {
		throw new Error(`Bridge config key 'scoping' must be one of: ${HINDSIGHT_SCOPING_VALUES.join(", ")}.`);
	}
	if (typeof record.mentalModelsEnabled !== "boolean") {
		throw new Error("Bridge config key 'mentalModelsEnabled' must be a boolean.");
	}

	const mentalModelsEnabled = record.mentalModelsEnabled;
	const hindsight = resolveHindsightConfig(
		{
			hindsightApiUrl: apiUrl,
			hindsightApiToken: apiToken,
			bankId,
			scoping: scoping as HindsightScoping,
			mentalModelsEnabled,
		},
		{},
	);
	return {
		configPath,
		configMode,
		apiUrl,
		apiToken,
		bankId,
		scoping: scoping as HindsightScoping,
		mentalModelsEnabled,
		hindsight,
	};
}
