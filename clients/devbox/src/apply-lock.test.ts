import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLockFiles, inventoryTargets } from "./apply-lock";

const sandboxes: string[] = [];

afterEach(() => {
	delete process.env.DEVBOX_APPLY_LOCK_ROOT;
	for (const path of sandboxes.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

function sandbox(): string {
	const root = mkdtempSync(join(tmpdir(), "devbox-apply-lock-"));
	sandboxes.push(root);
	process.env.DEVBOX_APPLY_LOCK_ROOT = join(root, "locks");
	return root;
}

test("host aliases and explicit ansible_host values map to one host lock", () => {
	const root = sandbox();
	const directInventory = join(root, "direct.ini");
	const aliasedInventory = join(root, "aliased.ini");
	const directWorkspace = join(root, "direct-workspace");
	const aliasedWorkspace = join(root, "aliased-workspace");
	writeFileSync(directInventory, "192.0.2.10 ansible_connection=ssh\n");
	writeFileSync(
		aliasedInventory,
		"box-b ansible_host=192.0.2.10 ansible_user=other\n",
	);
	mkdirSync(directWorkspace);
	mkdirSync(aliasedWorkspace);

	const direct = applyLockFiles(directInventory, directWorkspace);
	const aliased = applyLockFiles(aliasedInventory, aliasedWorkspace);
	expect(direct.filter((path) => aliased.includes(path))).toHaveLength(1);
});

test("partially overlapping inventories share exactly the common host lock", () => {
	const root = sandbox();
	const inventoryA = join(root, "multi.ini");
	const inventoryB = join(root, "single.ini");
	const workspaceA = join(root, "workspace-a");
	const workspaceB = join(root, "workspace-b");
	writeFileSync(
		inventoryA,
		"box-a ansible_host=192.0.2.10\nbox-b ansible_host=192.0.2.11\n",
	);
	writeFileSync(inventoryB, "other-alias ansible_host=192.0.2.10\n");
	mkdirSync(workspaceA);
	mkdirSync(workspaceB);

	const multi = applyLockFiles(inventoryA, workspaceA);
	const single = applyLockFiles(inventoryB, workspaceB);
	expect(multi).toHaveLength(3);
	expect(single).toHaveLength(2);
	expect(multi.filter((path) => single.includes(path))).toHaveLength(1);
});

test("INI group variables do not become lock targets", () => {
	const root = sandbox();
	const inventory = join(root, "inventory.ini");
	writeFileSync(
		inventory,
		"[devbox]\nbox-a ansible_host=192.0.2.10\n[devbox:vars]\nansible_user=dev-a\nansible_python_interpreter=/usr/bin/python3\n",
	);

	expect(inventoryTargets(inventory)).toEqual(["192.0.2.10"]);
});

test("an inventory without static hosts fails closed", () => {
	const root = sandbox();
	const inventory = join(root, "inventory.ini");
	writeFileSync(inventory, "[devbox:vars]\nansible_user=dev-a\n");

	expect(() => inventoryTargets(inventory)).toThrow("no static inventory hosts");
});
