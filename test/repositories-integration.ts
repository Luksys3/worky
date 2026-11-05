import * as vscode from "vscode";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Worky } from "../src/extension";
import type { Worktree } from "../src/model";
import { git } from "../src/git";
import { RepositoryItem } from "../src/views";

export async function testRepositories(
	worky: Worky,
	root: string,
	repository: string,
	worktree: string,
): Promise<void> {
	const config = vscode.workspace.getConfiguration("worky");
	const other = path.join(root, "cregoratool");
	await fs.mkdir(other);
	await git(other, ["init", "-b", "main"]);
	const internals = worky as unknown as {
		openFolder(worktree: Worktree, newWindow: boolean): Promise<void>;
	};
	const originalFolder = internals.openFolder;
	const opened: [string, boolean][] = [];
	internals.openFolder = async (target, newWindow) => {
		opened.push([target.path, newWindow]);
	};
	try {
		assert.ok(
			(await vscode.commands.getCommands(true)).includes(
				"worky.switchRepository",
			),
		);
		await worky.repository!.state.setLastUsed(worktree);
		await config.update(
			"repositoryDirectories",
			[root],
			vscode.ConfigurationTarget.Global,
		);
		await worky.refreshRepositories(true, true);
		const rows = () =>
			worky.repositoryView.getChildren() as RepositoryItem[];
		// The bare remote, the worktrees directory, and plain directories are not repositories.
		assert.deepEqual(
			rows().map((row) => [row.label, row.description]),
			[
				["applications", "Current · PLAN-integration"],
				["cregoratool", "main"],
			],
		);
		const [current] = rows();
		assert.equal((current!.iconPath as vscode.ThemeIcon).id, "check");
		assert.equal(current!.contextValue, "repository-worktree");

		await vscode.commands.executeCommand("worky.openRepository", current);
		await vscode.commands.executeCommand(
			"worky.openRepositoryNewWindow",
			current,
		);
		await vscode.commands.executeCommand(
			"worky.openRepositoryMain",
			current,
		);
		assert.deepEqual(opened, [
			[worktree, false],
			[worktree, true],
			[repository, false],
		]);

		await vscode.commands.executeCommand("worky.hideRepository", rows()[1]);
		assert.deepEqual(
			vscode.workspace
				.getConfiguration("worky")
				.get("hiddenRepositories"),
			["cregoratool"],
		);
		await worky.refreshRepositories(true, true);
		assert.deepEqual(
			rows().map((row) => row.label),
			["applications"],
		);
		await testPickersWhileLoading(worky);
		console.log(
			"Worky repositories integration passed: discovery, current marker, last used worktree, window overrides, main checkout, hiding, and pickers opening while loading.",
		);
	} finally {
		internals.openFolder = originalFolder;
		for (const setting of ["repositoryDirectories", "hiddenRepositories"])
			await config.update(
				setting,
				undefined,
				vscode.ConfigurationTarget.Global,
			);
		await fs.rm(other, { recursive: true, force: true });
	}
}

async function waitFor(check: () => boolean, description: string) {
	const end = Date.now() + 10_000;
	while (!check()) {
		if (Date.now() > end) throw new Error(`Timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Both pickers open at once with a spinning row, then fill in when loading finishes. */
async function testPickersWhileLoading(worky: Worky): Promise<void> {
	const window = vscode.window as { createQuickPick: unknown };
	const original = vscode.window.createQuickPick;
	let picker: vscode.QuickPick<vscode.QuickPickItem> | undefined;
	window.createQuickPick = () => (picker = original());
	const labels = () => picker!.items.map((item) => item.label);
	try {
		// As right after activation: nothing has loaded yet.
		worky.repository = undefined;
		await vscode.commands.executeCommand("worky.goTo");
		assert.deepEqual(labels(), [
			"Worktrees",
			"$(loading~spin) Loading worktrees…",
			"Pull Requests",
			"$(loading~spin) Loading pull requests…",
		]);
		await waitFor(
			() => labels().includes("$(add) Create New Worktree…"),
			"Go To fills in worktrees",
		);
		await waitFor(
			() => !labels().some((label) => label.includes("Loading")),
			"Go To finishes loading",
		);
		assert.ok(
			labels().some((label) => label.endsWith(" PLAN-integration")),
		);
		picker!.hide();

		worky.repositoryView.items = undefined;
		await vscode.commands.executeCommand("worky.switchRepository");
		assert.deepEqual(labels(), ["$(loading~spin) Loading repositories…"]);
		await waitFor(
			() => labels().includes("$(check) applications"),
			"Switch Repository fills in repositories",
		);
		picker!.hide();
	} finally {
		window.createQuickPick = original;
		picker?.hide();
	}
}
