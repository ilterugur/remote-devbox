import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const CLI = join(import.meta.dir, "devbox.ts");
const sandboxes: string[] = [];
const FALLBACK =
	process.platform === "darwin"
		? "UTF-8"
		: process.platform === "linux"
			? "C.utf8"
			: "en_US.UTF-8";
const CONFIG = `config_version: 3
platform: {distribution: ubuntu, version: "26.04", architecture: amd64}
operator: {user: devbox-admin, ssh_authorized_keys: ["ssh-ed25519 AAAA test@client"]}
network: {tailscale: {enabled: false}, ssh: {access: [public]}}
container: {default_engine: podman-rootless, install_engines: [podman-rootless]}
developers:
  - user: dev-a
    login_ssh_keys: ["ssh-ed25519 AAAA test@client"]
    git_identities: {work: {name: Test, email: test@example.com}}
`;

function executable(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function sandbox(): {
	root: string;
	bin: string;
	capture: string;
	config: string;
	inventory: string;
} {
	const root = mkdtempSync(join(tmpdir(), "devbox-locale-"));
	sandboxes.push(root);
	const bin = join(root, "bin");
	const capture = join(root, "capture.log");
	const config = join(root, "devbox.yml");
	const inventory = join(root, "inventory.ini");
	mkdirSync(bin);
	writeFileSync(config, CONFIG);
	writeFileSync(inventory, "localhost ansible_connection=local\n");
	executable(
		join(bin, "locale"),
		'printf "C\\nC.utf8\\nen_US.UTF-8\\nUTF-8\\n"',
	);
	executable(
		join(bin, "defaults"),
		'printf "keyboard:%s|%s|%s\\n" "$LC_ALL" "$LANG" "$LC_CTYPE" >> "$DEVBOX_TEST_CAPTURE"\nprintf \'{ "KeyboardLayout Name" = "U.S."; }\\n\'',
	);
	executable(
		join(bin, "setxkbmap"),
		'printf "keyboard:%s|%s|%s\\n" "$LC_ALL" "$LANG" "$LC_CTYPE" >> "$DEVBOX_TEST_CAPTURE"\nprintf "layout: us\\n"',
	);
	executable(
		join(bin, "ansible-playbook"),
		'printf "ansible:%s|%s|%s\\n" "$LC_ALL" "$LANG" "$LC_CTYPE" >> "$DEVBOX_TEST_CAPTURE"',
	);
	return { root, bin, capture, config, inventory };
}

function run(
	fixture: ReturnType<typeof sandbox>,
	args: string[],
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd: fixture.root,
		env: {
			...process.env,
			PATH: `${fixture.bin}${delimiter}${process.env.PATH}`,
			DEVBOX_TEST_CAPTURE: fixture.capture,
			LC_ALL: "en_TR.UTF-8",
			LANG: "en_TR.UTF8",
			LC_CTYPE: "en_TR.UTF-8",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

afterEach(() => {
	for (const path of sandboxes.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("provisioning child locale", () => {
	test("plan passes a supported UTF-8 locale to keyboard detection", () => {
		const fixture = sandbox();

		const result = run(fixture, ["plan", "--config", fixture.config]);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(readFileSync(fixture.capture, "utf8")).toBe(
			`keyboard:${FALLBACK}|${FALLBACK}|${FALLBACK}\n`,
		);
	});

	test("apply passes the same supported UTF-8 locale to detection and Ansible", () => {
		const fixture = sandbox();

		const result = run(fixture, [
			"apply",
			"developers",
			"--config",
			fixture.config,
			"--inventory",
			fixture.inventory,
		]);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(readFileSync(fixture.capture, "utf8")).toBe(
			`keyboard:${FALLBACK}|${FALLBACK}|${FALLBACK}\nansible:${FALLBACK}|${FALLBACK}|${FALLBACK}\n`,
		);
	});
});
