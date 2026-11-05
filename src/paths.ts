import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export function expandHome(value: string): string {
	return value === "~"
		? os.homedir()
		: value.startsWith("~/")
			? path.join(os.homedir(), value.slice(2))
			: path.resolve(value);
}

// Resolve symlink parents even for an unsaved/deleted file or a new destination.
export async function canonicalPath(filename: string): Promise<string> {
	const absolute = path.resolve(filename);
	try {
		return await fs.realpath(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = path.dirname(absolute);
		if (parent === absolute) throw error;
		return path.join(await canonicalPath(parent), path.basename(absolute));
	}
}

export function isWithinDirectory(
	directory: string,
	filename: string,
): boolean {
	const relative = path.relative(directory, filename);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(".." + path.sep) &&
			!path.isAbsolute(relative))
	);
}
