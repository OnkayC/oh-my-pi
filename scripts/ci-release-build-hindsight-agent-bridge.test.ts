import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $, YAML } from "bun";
import {
	BRIDGE_BUILD_TARGETS,
	bridgeAssetPath,
	resolveBridgeBuildTargets,
} from "../packages/coding-agent/scripts/build-hindsight-agent-bridge";

const repoRoot = path.join(import.meta.dir, "..");

interface BridgeReleaseWorkflow {
	jobs: {
		build: { strategy: { matrix: { include: Array<{ target_id: string }> } } };
		"verify-macos": { strategy: { matrix: { include: Array<{ target_id: string }> } } };
	};
}

describe("Hindsight agent bridge release build", () => {
	it("supports all four published targets with stable asset names", () => {
		expect(BRIDGE_BUILD_TARGETS.map(target => target.id)).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-x64",
			"linux-arm64",
		]);
		expect(
			resolveBridgeBuildTargets("linux-arm64,darwin-x64,darwin-arm64,linux-arm64").map(target => target.id),
		).toEqual(["linux-arm64", "darwin-x64", "darwin-arm64"]);
		for (const target of BRIDGE_BUILD_TARGETS) {
			expect(path.basename(bridgeAssetPath(target))).toBe(`hindsight-agent-bridge-${target.id}`);
		}
		expect(() => resolveBridgeBuildTargets("win32-x64")).toThrow("Unsupported Hindsight bridge target");
	});

	it("keeps published and verified targets aligned with the build targets", async () => {
		const workflow = YAML.parse(
			await Bun.file(path.join(repoRoot, ".github", "workflows", "release-hindsight-agent-bridge.yml")).text(),
		) as BridgeReleaseWorkflow;
		const buildTargetIds = BRIDGE_BUILD_TARGETS.map(target => target.id);
		expect(workflow.jobs.build.strategy.matrix.include.map(target => target.target_id).toSorted()).toEqual(
			buildTargetIds.toSorted(),
		);
		expect(workflow.jobs["verify-macos"].strategy.matrix.include.map(target => target.target_id).toSorted()).toEqual(
			buildTargetIds.filter(target => target.startsWith("darwin-")).toSorted(),
		);
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
		const workflow = await Bun.file(
			path.join(repoRoot, ".github/workflows/release-hindsight-agent-bridge.yml"),
		).text();
		for (const target of BRIDGE_BUILD_TARGETS) {
			expect(workflow).toContain(`target_id: ${target.id}`);
			expect(workflow).toContain(`packages/coding-agent/binaries/hindsight-agent-bridge-${target.id}`);
		}
	});

	it("keeps native signing smoke bridge-compatible and never launches cross-built binaries on Linux", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-signing-"));
		try {
			const bashEnv = path.join(root, "signing-env.sh");
			const binary = path.join(root, "bridge");
			await fs.writeFile(
				bashEnv,
				`uname() {
	if [[ "\${1:-}" == -m ]]; then printf '%s\\n' arm64; else printf '%s\\n' "$SIGN_HOST"; fi
}
curl() { :; }
shasum() { cat >/dev/null; }
sha256sum() { cat >/dev/null; }
tar() {
	printf '#!/usr/bin/env bash\\nprintf "rcodesign:%%s\\\\n" "$1"\\n' >"$4/rcodesign"
	chmod +x "$4/rcodesign"
}
codesign() { :; }
zip() { :; }
`,
			);
			await fs.writeFile(binary, '#!/usr/bin/env bash\nprintf "binary:%s\\n" "$1"\n', { mode: 0o755 });
			for (const [host, customSmoke] of [
				["Darwin", true],
				["Darwin", false],
				["Linux", true],
			] as const) {
				const smokeCommand = customSmoke
					? [
							"bash",
							"-c",
							'printf "bridge-smoke:%s\\n" "$1"; test "$HOME" != "$ORIGINAL_HOME"',
							"_",
							"argument with spaces",
						]
					: [];
				const result = await $`bash scripts/ci-macos-sign.sh ${binary} ${smokeCommand}`
					.cwd(repoRoot)
					.env({
						...process.env,
						BASH_ENV: bashEnv,
						SIGN_HOST: host,
						ORIGINAL_HOME: process.env.HOME ?? "",
						APPLE_CERTIFICATE_P12: "Y2VydA==",
						APPLE_CERTIFICATE_PASSWORD: "password",
						APPLE_API_KEY_ID: "key-id",
						APPLE_API_ISSUER_ID: "issuer-id",
						APPLE_API_KEY: "a2V5",
					})
					.quiet()
					.nothrow();
				expect(result.exitCode).toBe(0);
				const output = result.text();
				expect(output).toContain("rcodesign:sign");
				expect(output).toContain("rcodesign:notary-submit");
				if (host === "Darwin") {
					expect(output).toContain("binary:--version");
					if (customSmoke) {
						expect(output).toContain("bridge-smoke:argument with spaces");
						expect(output).not.toContain("binary:--smoke-test");
						expect(output.indexOf("bridge-smoke:")).toBeLessThan(output.indexOf("rcodesign:notary-submit"));
					} else {
						expect(output).toContain("binary:--smoke-test");
						expect(output).not.toContain("bridge-smoke:");
					}
				} else {
					expect(output).not.toContain("binary:");
					expect(output).not.toContain("bridge-smoke:");
				}
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
