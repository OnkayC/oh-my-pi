import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/**
 * Copy every file under a session-local artifact root into a fresh-session root.
 * Shared by interactive and RPC plan-mode fresh execution so platform/hardening
 * fixes stay in one place.
 */
export async function copyLocalArtifactTree(sourceRoot: string, destinationRoot: string): Promise<void> {
	if (sourceRoot === destinationRoot) return;
	let sourceStat: fsTypes.Stats;
	try {
		sourceStat = await fs.lstat(sourceRoot);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!sourceStat.isDirectory()) return;
	await fs.mkdir(destinationRoot, { recursive: true });
	await copyLocalArtifactEntries(sourceRoot, destinationRoot);
}

async function copyLocalArtifactEntries(sourceDir: string, destinationDir: string): Promise<void> {
	const entries = await fs.readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(sourceDir, entry.name);
		const destinationPath = path.join(destinationDir, entry.name);
		if (entry.isDirectory()) {
			await fs.mkdir(destinationPath, { recursive: true });
			await copyLocalArtifactEntries(sourcePath, destinationPath);
			continue;
		}
		if (entry.isFile()) {
			await fs.mkdir(path.dirname(destinationPath), { recursive: true });
			await fs.copyFile(sourcePath, destinationPath);
		}
	}
}
