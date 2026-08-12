import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

export function inventoryTargets(inventory: string): string[] {
	const targets = new Set<string>();
	let section = "";
	for (const rawLine of readFileSync(inventory, "utf8").split("\n")) {
		const line = rawLine.replace(/\s+#.*$/, "").trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1).trim().toLowerCase();
			continue;
		}
		if (section.endsWith(":vars") || section.endsWith(":children")) continue;

		const fields = line.split(/\s+/);
		if (!fields[0] || fields[0].includes("=")) continue;
		const explicit = fields.find((field) => field.startsWith("ansible_host="));
		const target = unquote(
			explicit ? explicit.slice("ansible_host=".length) : fields[0],
		)
			.replace(/\.$/, "")
			.toLowerCase();
		if (target) targets.add(target);
	}
	if (targets.size === 0) {
		throw new Error(`no static inventory hosts found in ${basename(inventory)}`);
	}
	return [...targets].sort();
}

function resourceKey(resource: string): string {
	return createHash("sha256").update(resource).digest("hex");
}

/**
 * One persistent advisory-lock file per shared generated-input workspace and
 * per target host. Kernel locks, rather than lock-directory deletion, provide
 * atomic exclusion and are released automatically when their owner exits.
 */
export function applyLockFiles(inventory: string, workspaceRoot: string): string[] {
	const root =
		process.env.DEVBOX_APPLY_LOCK_ROOT ??
		join(homedir(), ".cache", "remote-devbox", "apply-locks");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const resources = [
		`workspace:${realpathSync(workspaceRoot)}`,
		...inventoryTargets(inventory).map((target) => `host:${target}`),
	].sort();
	return resources.map((resource) => join(root, `${resourceKey(resource)}.lock`));
}

export type LockedCommand = {
	command: string;
	args: string[];
	options: SpawnSyncOptions;
};

/**
 * Execute a command under every lock in stable order. `lockf`/`flock` owns the
 * lock while its child runs, so killing the calling CLI cannot orphan a live
 * Ansible process without a lock. Persistent lock files are inert after exit;
 * there is no stale owner or recovery claim to race over.
 */
export function runWithApplyLocks(
	lockFiles: string[],
	locked: LockedCommand,
): ReturnType<typeof spawnSync> {
	let command = locked.command;
	let args = locked.args;
	for (const lockFile of [...lockFiles].reverse()) {
		if (process.platform === "darwin") {
			args = ["-k", "-t", "0", lockFile, command, ...args];
			command = "/usr/bin/lockf";
		} else {
			args = ["-n", "-E", "75", lockFile, command, ...args];
			command = "/usr/bin/flock";
		}
	}
	return spawnSync(command, args, locked.options);
}
