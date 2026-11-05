import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git, mapLimited, parseWorktrees } from "./git";
import { message, Worktree } from "./model";
import { canonicalPath, expandHome } from "./paths";
import { StateStore } from "./state";

export interface Repository {
	name: string;
	path: string;
	/** Parent directory, set only when another listed repository has the same name. */
	location?: string;
	/** Where opening the repository goes: its last used worktree, else the main checkout. */
	target?: Worktree;
	error?: string;
}

/**
 * Direct subdirectories of `directories` that have their own `.git` directory,
 * sorted by name. Worktrees and submodules have a `.git` file instead, so they
 * are not listed. Hidden entries match a repository name or path; hiding one
 * also hides its symlinked aliases.
 */
export async function findRepositories(
	directories: string[],
	hidden: string[],
): Promise<Repository[]> {
	const hiddenNames = new Set(hidden);
	const hiddenPaths = new Set(
		await Promise.all(
			hidden
				.filter((entry) => entry.includes("/"))
				.map((entry) => canonicalPath(expandHome(entry))),
		),
	);
	const all: Repository[] = [];
	for (const directory of directories) {
		const parent = expandHome(directory);
		const entries = await fs
			.readdir(parent, { withFileTypes: true })
			.catch(() => []);
		const candidates = await Promise.all(
			entries
				.filter(
					(entry) =>
						!entry.name.startsWith(".") &&
						(entry.isDirectory() || entry.isSymbolicLink()),
				)
				.map(async (entry) => {
					const candidate = path.join(parent, entry.name);
					const dotGit = await fs
						.stat(path.join(candidate, ".git"))
						.catch(() => undefined);
					return dotGit?.isDirectory()
						? {
								name: entry.name,
								path: await canonicalPath(candidate),
							}
						: undefined;
				}),
		);
		for (const candidate of candidates) if (candidate) all.push(candidate);
	}
	for (const candidate of all)
		if (hiddenNames.has(candidate.name)) hiddenPaths.add(candidate.path);
	// Prefer a repository's own folder name over a symlink alias's name.
	all.sort(
		(a, b) =>
			Number(path.basename(a.path) !== a.name) -
			Number(path.basename(b.path) !== b.name),
	);
	const found = new Map<string, Repository>();
	for (const candidate of all)
		if (!found.has(candidate.path) && !hiddenPaths.has(candidate.path))
			found.set(candidate.path, candidate);
	const repositories = [...found.values()];
	for (const repository of repositories)
		if (
			repositories.some(
				(other) =>
					other !== repository && other.name === repository.name,
			)
		)
			repository.location = tildePath(path.dirname(repository.path));
	return repositories.sort(
		(a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
	);
}

function tildePath(value: string): string {
	const home = os.homedir();
	return value === home
		? "~"
		: value.startsWith(home + path.sep)
			? "~" + value.slice(home.length)
			: value;
}

export async function repositoryTarget(
	repositoryPath: string,
	main = false,
): Promise<Worktree> {
	const worktrees = parseWorktrees(
		await git(repositoryPath, ["worktree", "list", "--porcelain", "-z"]),
	);
	const checkout = worktrees[0];
	if (!checkout || checkout.bare)
		throw new Error(`${repositoryPath} has no main checkout to open.`);
	if (main) return checkout;
	const common = (
		await git(repositoryPath, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		])
	).trim();
	const last = await new StateStore(common).lastUsed();
	const used = worktrees.find(
		(item) => item.path === last && !item.bare && !item.prunable,
	);
	// Git keeps locked worktrees whose directory is gone without marking them prunable.
	return used && (await fs.stat(used.path).catch(() => undefined))
		? used
		: checkout;
}

export async function listRepositories(
	directories: string[],
	hidden: string[],
): Promise<Repository[]> {
	return mapLimited(
		await findRepositories(directories, hidden),
		4,
		async (repository) => {
			try {
				return {
					...repository,
					target: await repositoryTarget(repository.path),
				};
			} catch (error) {
				return { ...repository, error: message(error) };
			}
		},
	);
}
