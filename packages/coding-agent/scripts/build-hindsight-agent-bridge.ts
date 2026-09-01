#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BridgeBuildTarget {
	id: "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";
	compileTarget: Bun.Build.CompileTarget;
}

export const BRIDGE_BUILD_TARGETS: readonly BridgeBuildTarget[] = [
	{ id: "darwin-arm64", compileTarget: "bun-darwin-arm64" },
	{ id: "darwin-x64", compileTarget: "bun-darwin-x64" },
	{ id: "linux-x64", compileTarget: "bun-linux-x64-modern" },
	{ id: "linux-arm64", compileTarget: "bun-linux-arm64" },
];

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
const binariesDir = path.join(packageDir, "binaries");
const entrypoint = path.join(packageDir, "src", "hindsight-agent-bridge", "cli.ts");

function hostTargetId(): BridgeBuildTarget["id"] {
	if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
	if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
	if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
	if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
	throw new Error(`Unsupported Hindsight bridge build host: ${process.platform}-${process.arch}`);
}

export function resolveBridgeBuildTargets(value: string | undefined): BridgeBuildTarget[] {
	const requested = value?.trim() ? value.split(",").map(item => item.trim()) : [hostTargetId()];
	const unique = [...new Set(requested)];
	return unique.map(id => {
		const target = BRIDGE_BUILD_TARGETS.find(candidate => candidate.id === id);
		if (!target) {
			throw new Error(
				`Unsupported Hindsight bridge target '${id}'. Expected: ${BRIDGE_BUILD_TARGETS.map(item => item.id).join(", ")}`,
			);
		}
		return target;
	});
}

export function bridgeAssetPath(target: BridgeBuildTarget): string {
	return path.join(binariesDir, `hindsight-agent-bridge-${target.id}`);
}

export async function buildHindsightAgentBridge(
	targets: readonly BridgeBuildTarget[],
	options: { dryRun?: boolean } = {},
): Promise<void> {
	await fs.mkdir(binariesDir, { recursive: true });
	for (const target of targets) {
		const outfile = bridgeAssetPath(target);
		if (options.dryRun) {
			console.log(
				`DRY RUN Bun.build target=${target.compileTarget} outfile=${path.relative(repoRoot, outfile)} entrypoint=${path.relative(repoRoot, entrypoint)}`,
			);
			continue;
		}
		const result = await Bun.build({
			entrypoints: [entrypoint],
			root: repoRoot,
			minify: { identifiers: true, keepNames: true },
			compile: {
				target: target.compileTarget,
				outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!result.success) {
			throw new Error(
				`Hindsight bridge build failed for ${target.id}:\n${result.logs.map(log => log.message).join("\n")}`,
			);
		}
		if (target.id.startsWith("darwin-") && process.platform === "darwin") {
			const signer = Bun.spawn(["codesign", "--force", "--sign", "-", outfile], {
				stdout: "ignore",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([signer.exited, new Response(signer.stderr).text()]);
			if (exitCode !== 0) throw new Error(`Ad-hoc signing failed for ${target.id}: ${stderr.trim()}`);
		}
		console.log(`Built ${path.relative(repoRoot, outfile)}`);
	}
}

if (import.meta.main) {
	await buildHindsightAgentBridge(resolveBridgeBuildTargets(Bun.env.RELEASE_TARGETS), {
		dryRun: process.argv.includes("--dry-run"),
	});
}
