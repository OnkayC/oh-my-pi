#!/usr/bin/env bun
/**
 * Sync unpublished upstream releases into this fork.
 *
 * A single new tag still merge-or-PRs against the target branch. When several
 * tags are missing, later tags are stacked: each conflict PR targets the
 * previous release branch instead of opening another PR against main.
 *
 * Usage:
 *   bun scripts/sync-upstream-release.ts
 *   bun scripts/sync-upstream-release.ts --dry-run
 */
import { $ } from "bun";

export const RELEASE_PR_PREFIX = "upstream-release/";

export interface UpstreamRelease {
	tag: string;
	sha: string;
}

export interface OpenReleasePr {
	number: number;
	base: string;
	head: string;
	sha: string;
}

export type StackAction =
	| { type: "retarget_pr"; number: number; base: string }
	| { type: "ensure_pr"; tag: string; sha: string; branch: string; base: string };

export function conflictBranchName(tag: string, sha: string): string {
	const safe = tag.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
	return `${RELEASE_PR_PREFIX}${safe}-${sha.slice(0, 12)}`;
}

/**
 * Walk the open release-PR chain starting at `targetBranch`. When two PRs
 * share a base, the lower number is treated as earlier in the stack.
 */
export function stackTip(
	targetBranch: string,
	mainSha: string,
	openPrs: readonly OpenReleasePr[],
): { branch: string; sha: string; heads: Set<string> } {
	const heads = new Set<string>();
	let branch = targetBranch;
	let sha = mainSha;
	while (true) {
		const next = openPrs
			.filter(pr => pr.base === branch && !heads.has(pr.head))
			.toSorted((a, b) => a.number - b.number)[0];
		if (!next) return { branch, sha, heads };
		heads.add(next.head);
		branch = next.head;
		sha = next.sha;
	}
}

export async function planUpstreamReleaseStack(input: {
	targetBranch: string;
	mainSha: string;
	missingReleases: readonly UpstreamRelease[];
	openPrs: readonly OpenReleasePr[];
	isAncestor: (commit: string, tip: string) => boolean | Promise<boolean>;
}): Promise<StackAction[]> {
	const openPrs = input.openPrs.map(pr => ({ ...pr }));
	const actions: StackAction[] = [];
	let { branch: tipBranch, sha: tipSha, heads } = stackTip(input.targetBranch, input.mainSha, openPrs);

	if (tipBranch === input.targetBranch) {
		const firstOrphan = firstMissingPr(
			input.missingReleases,
			openPrs.filter(pr => !heads.has(pr.head)),
		);
		if (firstOrphan && firstOrphan.base !== input.targetBranch) {
			actions.push({ type: "retarget_pr", number: firstOrphan.number, base: input.targetBranch });
			firstOrphan.base = input.targetBranch;
			({ branch: tipBranch, sha: tipSha, heads } = stackTip(input.targetBranch, input.mainSha, openPrs));
		}
	}

	for (const release of input.missingReleases) {
		if (await input.isAncestor(release.sha, tipSha)) continue;

		const branch = conflictBranchName(release.tag, release.sha);
		const existing = openPrs.find(pr => pr.sha === release.sha || pr.head === branch);
		if (existing) {
			if (existing.head === tipBranch) continue;
			if (existing.base !== tipBranch) {
				actions.push({ type: "retarget_pr", number: existing.number, base: tipBranch });
				existing.base = tipBranch;
			}
			heads.add(existing.head);
			tipBranch = existing.head;
			tipSha = existing.sha;
			continue;
		}

		actions.push({ type: "ensure_pr", tag: release.tag, sha: release.sha, branch, base: tipBranch });
		openPrs.push({ number: Number.MAX_SAFE_INTEGER, base: tipBranch, head: branch, sha: release.sha });
		heads.add(branch);
		tipBranch = branch;
		tipSha = release.sha;
	}

	return actions;
}

function firstMissingPr(
	missingReleases: readonly UpstreamRelease[],
	candidates: readonly OpenReleasePr[],
): OpenReleasePr | undefined {
	for (const release of missingReleases) {
		const branch = conflictBranchName(release.tag, release.sha);
		const match = candidates.find(pr => pr.sha === release.sha || pr.head === branch);
		if (match) return match;
	}
	return candidates.toSorted((a, b) => a.number - b.number)[0];
}

export interface PublishedRelease {
	tag: string;
	publishedAt: string;
}

export function releasesNewerThan(releases: readonly PublishedRelease[], currentVersion: string): PublishedRelease[] {
	return releases.filter(release => Bun.semver.order(release.tag.replace(/^v/, ""), currentVersion) > 0);
}

async function listPublishedReleases(upstream: string): Promise<PublishedRelease[]> {
	const raw =
		await $`gh api --paginate ${`repos/${upstream}/releases?per_page=100`} --jq ${".[] | select(.draft == false and .published_at != null) | {tag: .tag_name, publishedAt: .published_at}"}`.text();
	const published: PublishedRelease[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const parsed = JSON.parse(trimmed) as { tag: string; publishedAt: string };
		published.push(parsed);
	}
	return published.toSorted((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

async function listOpenReleasePrs(repo: string): Promise<OpenReleasePr[]> {
	const raw =
		await $`gh api --paginate ${`repos/${repo}/pulls?state=open&per_page=100`} --jq ${`.[] | select(.head.ref | startswith("${RELEASE_PR_PREFIX}")) | {number, base: .base.ref, head: .head.ref, sha: .head.sha}`}`.text();
	const openPrs: OpenReleasePr[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		openPrs.push(JSON.parse(trimmed) as OpenReleasePr);
	}
	return openPrs;
}

async function isAncestor(commit: string, tip: string): Promise<boolean> {
	const result = await $`git merge-base --is-ancestor ${commit} ${tip}`.quiet().nothrow();
	return result.exitCode === 0;
}

async function tryMergeRelease(release: UpstreamRelease, targetBranch: string): Promise<boolean> {
	const merged = await $`git merge --no-ff ${release.sha} -m ${`Merge upstream release ${release.tag}`}`.nothrow();
	if (merged.exitCode === 0) {
		await $`git push origin ${`HEAD:${targetBranch}`}`;
		console.log(`Merged upstream release ${release.tag} into ${targetBranch}.`);
		return true;
	}

	const unmerged = (await $`git diff --name-only --diff-filter=U`.text()).trim();
	await $`git merge --abort`.nothrow();
	if (!unmerged) {
		throw new Error(`The merge of ${release.tag} failed without producing conflicts.`);
	}
	console.log(`Merge conflicts detected for ${release.tag}:`);
	console.log(unmerged);
	return false;
}

async function ensureRemote(name: string, url: string): Promise<void> {
	const remotes = (await $`git remote`.text()).trim().split("\n").filter(Boolean);
	if (!remotes.includes(name)) {
		await $`git remote add ${name} ${url}`;
	}
}

async function existingPrNumber(repo: string, base: string, head: string): Promise<number | undefined> {
	const raw = await $`gh pr list --repo ${repo} --base ${base} --head ${head} --state open --json number`.text();
	const parsed = JSON.parse(raw) as Array<{ number: number }>;
	return parsed[0]?.number;
}

function prBody(input: { upstream: string; targetBranch: string; tag: string; sha: string; base: string }): string {
	const stacked =
		input.base === input.targetBranch
			? `This branch points at upstream release commit ${input.sha}, so the conflicts can be resolved in this pull request.`
			: `This pull request is stacked on \`${input.base}\`, which carries the previous unpublished upstream release. Merge that pull request first.\n\nThis branch points at upstream release commit ${input.sha}.`;
	return [
		`The automated merge of upstream release ${input.tag} into ${input.targetBranch} found conflicts.`,
		"",
		stacked,
		"",
		`Upstream release: https://github.com/${input.upstream}/releases/tag/${input.tag}`,
		"",
	].join("\n");
}

async function executeAction(
	action: StackAction,
	input: { repo: string; upstream: string; targetBranch: string; dryRun: boolean },
): Promise<void> {
	if (action.type === "retarget_pr") {
		if (input.dryRun) {
			console.log(`Would retarget PR #${action.number} onto ${action.base}.`);
			return;
		}
		await $`gh pr edit ${String(action.number)} --repo ${input.repo} --base ${action.base}`;
		console.log(`Retargeted PR #${action.number} onto ${action.base}.`);
		return;
	}

	if (input.dryRun) {
		console.log(`Would open ${action.branch} onto ${action.base} for ${action.tag}.`);
		return;
	}

	await $`git checkout -B ${action.branch} ${action.sha}`;
	await $`git push origin ${`HEAD:refs/heads/${action.branch}`}`;

	const existing = await existingPrNumber(input.repo, action.base, action.branch);
	if (existing !== undefined) {
		console.log(`Conflict pull request #${existing} already exists.`);
		return;
	}

	const bodyFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/upstream-release-pr.md`;
	await Bun.write(
		bodyFile,
		prBody({
			upstream: input.upstream,
			targetBranch: input.targetBranch,
			tag: action.tag,
			sha: action.sha,
			base: action.base,
		}),
	);
	await $`gh pr create --repo ${input.repo} --base ${action.base} --head ${action.branch} --title ${`chore: merge upstream release ${action.tag}`} --body-file ${bodyFile}`;
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	const upstream = process.env.UPSTREAM_REPOSITORY ?? "can1357/oh-my-pi";
	const targetBranch = process.env.TARGET_BRANCH ?? "main";
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) throw new Error("GITHUB_REPOSITORY is required");

	await $`git config user.name github-actions[bot]`;
	await $`git config user.email 41898282+github-actions[bot]@users.noreply.github.com`;
	await ensureRemote("upstream", `https://github.com/${upstream}.git`);

	const published = await listPublishedReleases(upstream);
	if (published.length === 0) {
		console.log(`No published release found in ${upstream}.`);
		return;
	}

	const manifest = (await Bun.file(`${import.meta.dir}/../packages/coding-agent/package.json`).json()) as {
		version: string;
	};
	const newReleases = releasesNewerThan(published, manifest.version);
	if (newReleases.length === 0) {
		console.log(`No upstream releases are newer than v${manifest.version}.`);
		return;
	}

	const refspecs = newReleases.map(release => `refs/tags/${release.tag}:refs/tags/${release.tag}`);
	await $`git fetch --force upstream ${refspecs}`;
	await $`git fetch origin ${targetBranch}`;
	await $`git checkout -B ${targetBranch} ${`origin/${targetBranch}`}`;

	const releases: UpstreamRelease[] = [];
	for (const release of newReleases) {
		const sha = (await $`git rev-parse ${`${release.tag}^{commit}`}`.text()).trim();
		releases.push({ tag: release.tag, sha });
	}

	let mainSha = (await $`git rev-parse HEAD`.text()).trim();
	const missing = async (): Promise<UpstreamRelease[]> => {
		const out: UpstreamRelease[] = [];
		for (const release of releases) {
			if (!(await isAncestor(release.sha, mainSha))) out.push(release);
		}
		return out;
	};

	let remaining = await missing();
	if (remaining.length === 0) {
		console.log(`All published upstream releases are already present on ${targetBranch}.`);
		return;
	}

	let openPrs = await listOpenReleasePrs(repo);
	const stackAlreadyOpen = openPrs.some(pr => pr.base === targetBranch);
	if (!stackAlreadyOpen && !dryRun) {
		for (const release of remaining) {
			if (await isAncestor(release.sha, mainSha)) continue;
			if (await tryMergeRelease(release, targetBranch)) {
				mainSha = (await $`git rev-parse HEAD`.text()).trim();
				continue;
			}
			break;
		}
		remaining = await missing();
		if (remaining.length === 0) return;
		openPrs = await listOpenReleasePrs(repo);
	}

	const actions = await planUpstreamReleaseStack({
		targetBranch,
		mainSha,
		missingReleases: remaining,
		openPrs,
		isAncestor,
	});
	if (actions.length === 0) {
		console.log("No stacked release pull requests to open.");
		return;
	}

	for (const action of actions) {
		await executeAction(action, { repo, upstream, targetBranch, dryRun });
	}
}

if (import.meta.main) {
	await main();
}
