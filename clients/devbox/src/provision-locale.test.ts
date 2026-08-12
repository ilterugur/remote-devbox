import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
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
	mkdirSync(join(root, "ansible"));
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
		`printf "ansible:%s|%s|%s\\n" "$LC_ALL" "$LANG" "$LC_CTYPE" >> "$DEVBOX_TEST_CAPTURE"
if [ -n "\${DEVBOX_TEST_APPLY_STATE:-}" ]; then
  if mkdir "$DEVBOX_TEST_APPLY_STATE/ansible-owner" 2>/dev/null; then
    printf "%s\n" "$$" > "$DEVBOX_TEST_APPLY_STATE/ansible-pid"
    : > "$DEVBOX_TEST_APPLY_STATE/entered"
    while [ ! -e "$DEVBOX_TEST_APPLY_STATE/release" ]; do sleep 0.02; done
    rmdir "$DEVBOX_TEST_APPLY_STATE/ansible-owner"
  else
    printf "overlap\\n" >> "$DEVBOX_TEST_CAPTURE"
  fi
fi
exit "\${DEVBOX_TEST_ANSIBLE_EXIT:-0}"`,
	);
	return { root, bin, capture, config, inventory };
}

function run(
	fixture: ReturnType<typeof sandbox>,
	args: string[],
	extraEnv: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd: fixture.root,
		env: {
			...process.env,
			PATH: `${fixture.bin}${delimiter}${process.env.PATH}`,
			DEVBOX_TEST_CAPTURE: fixture.capture,
			DEVBOX_APPLY_LOCK_ROOT: join(fixture.root, "apply-locks"),
			...extraEnv,
			LC_ALL: "en_TR.UTF-8",
			LANG: "en_TR.UTF8",
			LC_CTYPE: "en_TR.UTF-8",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function waitFor(path: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (existsSync(path)) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForMissing(path: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (!existsSync(path)) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${path} to disappear`);
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

	test("a second apply for the same inventory fails before Ansible can overlap", async () => {
		const fixture = sandbox();
		const state = join(fixture.root, "apply-state");
		mkdirSync(state);
		const args = [
			"apply",
			"developers",
			"--config",
			fixture.config,
			"--inventory",
			fixture.inventory,
		];
		const env = {
			...process.env,
			PATH: `${fixture.bin}${delimiter}${process.env.PATH}`,
			DEVBOX_TEST_CAPTURE: fixture.capture,
			DEVBOX_TEST_APPLY_STATE: state,
			DEVBOX_APPLY_LOCK_ROOT: join(fixture.root, "apply-locks"),
			LC_ALL: "en_TR.UTF-8",
			LANG: "en_TR.UTF8",
			LC_CTYPE: "en_TR.UTF-8",
			// Public environment flags are never proof that a kernel lock is held.
			DEVBOX_APPLY_LOCKED_INTERNAL: "1",
			DEVBOX_APPLY_HANDOFF_TOKEN_INTERNAL: "forged",
			DEVBOX_APPLY_HANDOFF_MARKER_INTERNAL: join(state, "forged-marker"),
		};

		const first = Bun.spawn([process.execPath, CLI, ...args], {
			cwd: fixture.root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		let second: ReturnType<typeof Bun.spawnSync> | undefined;
		let firstExit: number | null = null;
		let generatedBeforeSecond = "";
		try {
			await waitFor(join(state, "entered"));
			const generatedVars = join(fixture.root, "ansible", ".generated", "all.yml");
			generatedBeforeSecond = readFileSync(generatedVars, "utf8");
			const competingConfig = join(fixture.root, "devbox-competing.yml");
			writeFileSync(competingConfig, CONFIG.replaceAll("dev-a", "dev-b"));
			const competingArgs = args.map((arg) =>
				arg === fixture.config ? competingConfig : arg,
			);
			second = Bun.spawnSync([process.execPath, CLI, ...competingArgs], {
				cwd: fixture.root,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
		} finally {
			writeFileSync(join(state, "release"), "");
			firstExit = await Promise.race([
				first.exited,
				Bun.sleep(1_000).then(() => null),
			]);
			if (firstExit === null) {
				first.kill();
				await first.exited;
			}
		}

		expect(firstExit).toBe(0);
		expect(second).toBeDefined();
		expect(second!.exitCode).not.toBe(0);
		expect(second!.stderr.toString()).toContain("apply already running");
		expect(
			readFileSync(join(fixture.root, "ansible", ".generated", "all.yml"), "utf8"),
		).toBe(generatedBeforeSecond);
		expect(readFileSync(fixture.capture, "utf8")).not.toContain("overlap");
	});

	test("Ansible exit 75 is not mislabeled as lock contention", () => {
		const fixture = sandbox();
		const result = run(
			fixture,
			[
				"apply",
				"developers",
				"--config",
				fixture.config,
				"--inventory",
				fixture.inventory,
			],
			{ DEVBOX_TEST_ANSIBLE_EXIT: "75" },
		);

		expect(result.exitCode).toBe(75);
		expect(result.stderr.toString()).not.toContain("apply already running");
	});

	test("killing the caller does not unlock its still-running Ansible child", async () => {
		const fixture = sandbox();
		const state = join(fixture.root, "orphan-state");
		mkdirSync(state);
		const args = [
			"apply",
			"developers",
			"--config",
			fixture.config,
			"--inventory",
			fixture.inventory,
		];
		const env = {
			...process.env,
			PATH: `${fixture.bin}${delimiter}${process.env.PATH}`,
			DEVBOX_TEST_CAPTURE: fixture.capture,
			DEVBOX_TEST_APPLY_STATE: state,
			DEVBOX_APPLY_LOCK_ROOT: join(fixture.root, "apply-locks"),
			LC_ALL: "en_TR.UTF-8",
			LANG: "en_TR.UTF8",
			LC_CTYPE: "en_TR.UTF-8",
		};
		const first = Bun.spawn([process.execPath, CLI, ...args], {
			cwd: fixture.root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		let ansiblePid = 0;
		try {
			await waitFor(join(state, "entered"));
			ansiblePid = Number(readFileSync(join(state, "ansible-pid"), "utf8"));
			first.kill(9);
			await first.exited;
			expect(() => process.kill(ansiblePid, 0)).not.toThrow();

			const second = Bun.spawnSync([process.execPath, CLI, ...args], {
				cwd: fixture.root,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(second.exitCode).not.toBe(0);
			expect(second.stderr.toString()).toContain("apply already running");
			expect(readFileSync(fixture.capture, "utf8")).not.toContain("overlap");
		} finally {
			writeFileSync(join(state, "release"), "");
			try {
				await waitForMissing(join(state, "ansible-owner"));
			} catch (error) {
				if (ansiblePid > 0) {
					try {
						process.kill(ansiblePid, "SIGKILL");
					} catch {
						// The process may have completed between the timeout and cleanup.
					}
				}
				throw error;
			}
		}
	});
});
