import * as fs from "node:fs";
import * as path from "node:path";

interface GitRepositoryLocation {
	repoRoot: string;
	gitDir: string;
	commonDir: string;
}

function fsCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function readOptionalText(filePath: string): string | null {
	for (let attempt = 0; attempt <= 3; attempt += 1) {
		try {
			return fs.readFileSync(filePath, "utf8");
		} catch (error) {
			const code = fsCode(error);
			if (code === "EINTR" && attempt < 3) continue;
			if (["ENOENT", "EISDIR", "ENOTDIR", "ENFILE", "EMFILE", "EACCES", "EPERM"].includes(code ?? "")) {
				return null;
			}
			throw error;
		}
	}
	return null;
}

function entryType(filePath: string): "directory" | "file" | null {
	for (let attempt = 0; attempt <= 3; attempt += 1) {
		try {
			const stat = fs.statSync(filePath);
			if (stat.isDirectory()) return "directory";
			if (stat.isFile()) return "file";
			return null;
		} catch (error) {
			const code = fsCode(error);
			if (code === "EINTR" && attempt < 3) continue;
			if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) return null;
			throw error;
		}
	}
	return null;
}

function resolveGitDirectory(gitEntryPath: string, type: "directory" | "file"): string | null {
	if (type === "directory") return gitEntryPath;
	const pointer = readOptionalText(gitEntryPath);
	const match = pointer ? /^gitdir:\s*(.+)\s*$/iu.exec(pointer.trim()) : null;
	if (!match?.[1]) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), match[1]);
	return entryType(gitDir) === "directory" ? gitDir : null;
}

function resolveRepository(startDirectory: string): GitRepositoryLocation | null {
	let current = path.resolve(startDirectory);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const type = entryType(gitEntryPath);
		if (type) {
			const gitDir = resolveGitDirectory(gitEntryPath, type);
			if (gitDir) {
				const commonDirPointer = readOptionalText(path.join(gitDir, "commondir"))?.trim();
				return {
					repoRoot: current,
					gitDir,
					commonDir: commonDirPointer ? path.resolve(gitDir, commonDirPointer) : gitDir,
				};
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** Resolve a checkout's primary root without subprocesses or OMP runtime dependencies. */
export function resolvePrimaryProjectRoot(directory: string): string | null {
	if (!directory) return null;
	const repository = resolveRepository(directory);
	if (!repository) return null;
	if (path.basename(repository.commonDir) === ".git") return path.dirname(repository.commonDir);
	const linkedWorktree =
		repository.gitDir !== repository.commonDir && entryType(path.join(repository.gitDir, "commondir")) === "file";
	return linkedWorktree ? repository.commonDir : repository.repoRoot;
}
