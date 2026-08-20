import { describe, expect, test } from "bun:test";
import {
	conflictBranchName,
	type OpenReleasePr,
	planUpstreamReleaseStack,
	releasesNewerThan,
	stackTip,
	type UpstreamRelease,
} from "./sync-upstream-release";

const MAIN = "main";
const MAIN_SHA = "mainsha0001";

function linearAncestor(order: string[]): (commit: string, tip: string) => boolean {
	return (commit, tip) => {
		const commitIndex = order.indexOf(commit);
		const tipIndex = order.indexOf(tip);
		if (commitIndex < 0 || tipIndex < 0) return commit === tip;
		return commitIndex <= tipIndex;
	};
}

function release(tag: string, sha: string): UpstreamRelease {
	return { tag, sha };
}

function pr(number: number, base: string, head: string, sha: string): OpenReleasePr {
	return { number, base, head, sha };
}

describe("conflictBranchName", () => {
	test("keeps the tag and a 12-character sha suffix", () => {
		expect(conflictBranchName("v17.3.7", "8500092296621a6826b7136e840f8a59ea338958")).toBe(
			"upstream-release/v17.3.7-850009229662",
		);
	});

	test("sanitizes characters that cannot appear in a branch name", () => {
		expect(conflictBranchName("v17.3.7+build", "abc123def4567890")).toBe(
			"upstream-release/v17.3.7-build-abc123def456",
		);
	});
});

describe("releasesNewerThan", () => {
	test("excludes historical and current releases", () => {
		const releases = ["v17.3.5", "v17.3.7", "v17.3.8", "v18.0.0"].map((tag, index) => ({
			tag,
			publishedAt: String(index),
		}));
		expect(releasesNewerThan(releases, "17.3.7").map(release => release.tag)).toEqual(["v17.3.8", "v18.0.0"]);
	});
});

describe("stackTip", () => {
	test("stays on the target branch when no release PRs are open", () => {
		expect(stackTip(MAIN, MAIN_SHA, [])).toEqual({ branch: MAIN, sha: MAIN_SHA, heads: new Set() });
	});

	test("walks the lowest-numbered PR when two PRs both target main", () => {
		const older = pr(14, MAIN, "upstream-release/v17.3.5-aaaaaaaaaaaa", "sha-v1735");
		const newer = pr(15, MAIN, "upstream-release/v17.3.7-bbbbbbbbbbbb", "sha-v1737");
		const tip = stackTip(MAIN, MAIN_SHA, [newer, older]);
		expect(tip.branch).toBe(older.head);
		expect(tip.sha).toBe(older.sha);
	});

	test("follows a stacked chain off main", () => {
		const first = pr(14, MAIN, "upstream-release/v17.3.5-aaaaaaaaaaaa", "sha-v1735");
		const second = pr(15, first.head, "upstream-release/v17.3.7-bbbbbbbbbbbb", "sha-v1737");
		const tip = stackTip(MAIN, MAIN_SHA, [first, second]);
		expect(tip.branch).toBe(second.head);
		expect(tip.sha).toBe(second.sha);
	});
});

describe("planUpstreamReleaseStack", () => {
	test("opens one PR against main for a single missing tag", async () => {
		const v1 = release("v17.3.7", "sha-v1737");
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v1],
				openPrs: [],
				isAncestor: () => false,
			}),
		).toEqual([
			{
				type: "ensure_pr",
				tag: v1.tag,
				sha: v1.sha,
				branch: conflictBranchName(v1.tag, v1.sha),
				base: MAIN,
			},
		]);
	});

	test("stacks later tags onto the previous release branch instead of main", async () => {
		const v1 = release("v17.3.6", "sha-v1736");
		const v2 = release("v17.3.7", "sha-v1737");
		const firstBranch = conflictBranchName(v1.tag, v1.sha);
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v1, v2],
				openPrs: [],
				isAncestor: () => false,
			}),
		).toEqual([
			{ type: "ensure_pr", tag: v1.tag, sha: v1.sha, branch: firstBranch, base: MAIN },
			{
				type: "ensure_pr",
				tag: v2.tag,
				sha: v2.sha,
				branch: conflictBranchName(v2.tag, v2.sha),
				base: firstBranch,
			},
		]);
	});

	test("stacks a newer tag onto an already-open first release PR", async () => {
		const v1 = release("v17.3.5", "sha-v1735");
		const v2 = release("v17.3.7", "sha-v1737");
		const firstHead = conflictBranchName(v1.tag, v1.sha);
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v1, v2],
				openPrs: [pr(14, MAIN, firstHead, v1.sha)],
				isAncestor: linearAncestor([v1.sha, v2.sha]),
			}),
		).toEqual([
			{
				type: "ensure_pr",
				tag: v2.tag,
				sha: v2.sha,
				branch: conflictBranchName(v2.tag, v2.sha),
				base: firstHead,
			},
		]);
	});

	test("skips tags already contained in the current stack tip", async () => {
		const v1 = release("v17.3.5", "sha-v1735");
		const v2 = release("v17.3.6", "sha-v1736");
		const v3 = release("v17.3.7", "sha-v1737");
		const firstHead = conflictBranchName(v2.tag, v2.sha);
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v1, v2, v3],
				openPrs: [pr(14, MAIN, firstHead, v2.sha)],
				isAncestor: linearAncestor([v1.sha, v2.sha, v3.sha]),
			}),
		).toEqual([
			{
				type: "ensure_pr",
				tag: v3.tag,
				sha: v3.sha,
				branch: conflictBranchName(v3.tag, v3.sha),
				base: firstHead,
			},
		]);
	});

	test("retargets a parallel main PR onto the older stack entry", async () => {
		const v1 = release("v17.3.5", "sha-v1735");
		const v2 = release("v17.3.7", "sha-v1737");
		const firstHead = conflictBranchName(v1.tag, v1.sha);
		const secondHead = conflictBranchName(v2.tag, v2.sha);
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v1, v2],
				openPrs: [pr(14, MAIN, firstHead, v1.sha), pr(15, MAIN, secondHead, v2.sha)],
				isAncestor: () => false,
			}),
		).toEqual([{ type: "retarget_pr", number: 15, base: firstHead }]);
	});

	test("keeps the existing main PR when the same release branch is stacked elsewhere", async () => {
		const v1 = release("v3.25.0", "sha-v3250");
		const head = conflictBranchName(v1.tag, v1.sha);
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v1],
				openPrs: [pr(17, MAIN, head, v1.sha), pr(372, "upstream-release/older", head, v1.sha)],
				isAncestor: (commit, tip) => commit === tip,
			}),
		).toEqual([]);
	});

	test("retargets an orphan stacked PR onto main when the base PR is gone", async () => {
		const v2 = release("v17.3.7", "sha-v1737");
		const secondHead = conflictBranchName(v2.tag, v2.sha);
		expect(
			await planUpstreamReleaseStack({
				targetBranch: MAIN,
				mainSha: MAIN_SHA,
				missingReleases: [v2],
				openPrs: [pr(15, "upstream-release/v17.3.5-aaaaaaaaaaaa", secondHead, v2.sha)],
				isAncestor: () => false,
			}),
		).toEqual([{ type: "retarget_pr", number: 15, base: MAIN }]);
	});
});
