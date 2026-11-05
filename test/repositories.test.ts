import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "../src/git";
import {
	findRepositories,
	listRepositories,
	repositoryTarget,
} from "../src/repositories";
import { StateStore } from "../src/state";

async function repository(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	await git(directory, ["init", "-b", "main"]);
	await git(directory, [
		"-c",
		"user.name=Worky Test",
		"-c",
		"user.email=worky-test@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"initial",
	]);
}

test("lists only directories with their own .git directory, alphabetically, minus hidden ones", async (t) => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "worky-repos-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const dev = path.join(root, "dev");
	for (const name of [
		"cregoratool",
		"applications",
		"nanoloans",
		".dotfiles",
	])
		await repository(path.join(home, name));
	await repository(path.join(dev, "applications"));
	await fs.mkdir(path.join(home, "plain"));
	await fs.writeFile(path.join(home, "file.txt"), "");
	// A worktree has a .git file, not a directory.
	await git(path.join(home, "applications"), [
		"worktree",
		"add",
		"-b",
		"PLAN-1",
		path.join(home, "PLAN-1"),
	]);
	await fs.symlink(path.join(home, "cregoratool"), path.join(home, "link"));

	assert.deepEqual(
		(
			await findRepositories(
				[home, dev, path.join(root, "missing")],
				["nanoloans", path.join(dev, "applications")],
			)
		).map((item) => [item.name, item.path]),
		[
			["applications", path.join(home, "applications")],
			["cregoratool", path.join(home, "cregoratool")],
		],
	);
	for (const hidden of ["cregoratool", "link"])
		assert.deepEqual(
			(await findRepositories([home], [hidden])).map((item) => item.name),
			["applications", "nanoloans"],
			`hiding ${hidden} also hides its symlink alias`,
		);
	assert.deepEqual(
		(await findRepositories([home, dev], ["cregoratool", "nanoloans"])).map(
			(item) => [item.name, item.location],
		),
		[
			["applications", dev],
			["applications", home],
		],
		"repositories with the same name show where they are",
	);
});

test("opens the last used worktree, falling back to the main checkout", async (t) => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "worky-repos-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const main = path.join(root, "applications");
	const worktree = path.join(root, "PLAN-1");
	await repository(main);
	await git(main, ["worktree", "add", "-b", "PLAN-1", worktree]);
	const state = new StateStore(path.join(main, ".git"));

	assert.equal((await repositoryTarget(main)).path, main, "nothing used yet");
	await state.setLastUsed(worktree);
	assert.equal(await state.lastUsed(), worktree);
	assert.equal((await repositoryTarget(main)).branch, "PLAN-1");
	assert.equal((await repositoryTarget(main, true)).path, main);
	const [listed] = await listRepositories([root], []);
	assert.equal(listed?.target?.path, worktree);

	await fs.rm(worktree, { recursive: true });
	assert.equal(
		(await repositoryTarget(main)).path,
		main,
		"a deleted worktree is skipped",
	);
	// Git keeps a locked worktree whose directory is gone without marking it prunable.
	const locked = path.join(root, "PLAN-2");
	await git(main, ["worktree", "add", "-b", "PLAN-2", locked]);
	await git(main, ["worktree", "lock", locked]);
	await fs.rm(locked, { recursive: true });
	await state.setLastUsed(locked);
	assert.equal((await repositoryTarget(main)).path, main);
	await state.setLastUsed("/elsewhere");
	assert.equal((await repositoryTarget(main)).path, main);
});
