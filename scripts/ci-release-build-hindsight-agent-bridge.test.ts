import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import {
	BRIDGE_BUILD_TARGETS,
	bridgeAssetPath,
	resolveBridgeBuildTargets,
} from "../packages/coding-agent/scripts/build-hindsight-agent-bridge";

const repoRoot = path.join(import.meta.dir, "..");

describe("Hindsight agent bridge release build", () => {
	it("supports the four published targets with stable asset names", () => {
		expect(BRIDGE_BUILD_TARGETS.map(target => target.id)).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-x64",
			"linux-arm64",
		]);
		expect(resolveBridgeBuildTargets("linux-arm64,darwin-x64,linux-arm64").map(target => target.id)).toEqual([
			"linux-arm64",
			"darwin-x64",
		]);
		for (const target of BRIDGE_BUILD_TARGETS) {
			expect(path.basename(bridgeAssetPath(target))).toBe(`hindsight-agent-bridge-${target.id}`);
		}
		expect(() => resolveBridgeBuildTargets("win32-x64")).toThrow("Unsupported Hindsight bridge target");
	});

	it("dry-runs direct Bun compilation without native or OMP bundle generation", async () => {
		const result = await $`bun packages/coding-agent/scripts/build-hindsight-agent-bridge.ts --dry-run`
			.cwd(repoRoot)
			.env({ ...process.env, RELEASE_TARGETS: "darwin-arm64,darwin-x64,linux-x64,linux-arm64" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();
		for (const target of BRIDGE_BUILD_TARGETS) {
			expect(output).toContain(`target=${target.compileTarget}`);
			expect(output).toContain(`outfile=packages/coding-agent/binaries/hindsight-agent-bridge-${target.id}`);
		}
		expect(output).not.toContain("gen:native");
		expect(output).not.toContain("compileCodingAgent");
		expect(output).not.toContain("docs-index");
	});

	it("keeps the release workflow aligned with every build target", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/release-hindsight-agent-bridge.yml")).text();
		for (const target of BRIDGE_BUILD_TARGETS) {
			expect(workflow).toContain(`target_id: ${target.id}`);
			expect(workflow).toContain(`packages/coding-agent/binaries/hindsight-agent-bridge-${target.id}`);
		}
	});
});
