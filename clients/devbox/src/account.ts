/**
 * account.ts — the client half of the manual Claude Code account swap.
 *
 * There is exactly ONE implementation of the swap in this repo: `scripts/devbox-account.sh`.
 * The box installs it as a file; this client embeds it as text (`with { type: "text" }`,
 * verified on bun 1.3.14) and materialises it to a temp file per run, so the compiled
 * binary can never drift from the copy the box runs — `account.test.ts` asserts the two
 * are byte-identical.
 *
 * `-p <profile>` does not re-implement anything either: it shells out to the box's
 * `remote-devbox-account` wrapper over `ssh -t`, which runs the very same engine as the
 * right Linux user with that agent profile's CLAUDE_CONFIG_DIR.
 *
 * Manual only, by design: nothing here reads a quota or picks an account for you
 * (docs/superpowers/specs/2026-09-04-claude-account-swap-design.md, "Policy boundary").
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import engineScript from "../../../scripts/devbox-account.sh" with { type: "text" };
import { type Config, die, hostFor, loadConfig, resolveProfile, shQuote } from "./config";
import { pinOmpAfterRemoteUse, pinOmpAfterUse } from "./omp-pin";


/** The engine's verbs, in the order its own usage text lists them. */
export const ACCOUNT_VERBS = ["ls", "status", "add", "use", "rm", "gc"] as const;
export type AccountVerb = (typeof ACCOUNT_VERBS)[number];

/** Verbs that name an account, so a missing label is a usage error, not a default. */
const LABEL_REQUIRED: readonly AccountVerb[] = ["add", "use", "rm"];

/**
 * The engine's own label rule (`scripts/devbox-account.sh` `cmd_add`: `*[!a-zA-Z0-9._-]*`).
 * Duplicated deliberately: a label is interpolated into a vault path and into the remote
 * command string, so the client rejects a bad one before spawning anything.
 */
const LABEL_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The box wrapper's second argument is the AGENT profile (`claude-main`, `claude-work`, …),
 * not the developer. The client's config has no agent-profile field — it only knows the
 * Linux user it calls a "profile" — so the agent profile comes from `--agent-profile` and
 * defaults to the name the installer gives a developer's first Claude profile.
 */
export const DEFAULT_AGENT_PROFILE = "claude-main";

export type AccountOpts = { json?: boolean; force?: boolean; keep?: string | number };

/**
 * The engine argv for one call: verb, label (when given), then `--json`, `--force`,
 * `--keep <n>`. Throws rather than dies so it stays testable and side-effect free; the
 * command action turns a throw into the usual `die()` message.
 */
export function accountArgs(verb: string, label?: string, opts: AccountOpts = {}): string[] {
  if (!(ACCOUNT_VERBS as readonly string[]).includes(verb))
    throw new Error(`unknown account action "${verb}" (have: ${ACCOUNT_VERBS.join(" ")})`);
  const v = verb as AccountVerb;
  if (label !== undefined && label !== "" && !LABEL_RE.test(label))
    throw new Error(`label "${label}" may only contain letters, digits, '.', '_' and '-'`);
  if (LABEL_REQUIRED.includes(v) && !label) throw new Error(`account ${v} needs a label: devbox account ${v} <label>`);

  const argv: string[] = [v];
  if (label) argv.push(label);
  if (opts.json) argv.push("--json");
  if (opts.force) argv.push("--force");
  if (opts.keep !== undefined && opts.keep !== "") argv.push("--keep", String(opts.keep));
  return argv;
}

// The content hash goes in the file name, so an older build's copy is never reused and
// two runs of the same build share one file instead of littering $TMPDIR.
const ENGINE_DIGEST = createHash("sha256").update(engineScript).digest("hex").slice(0, 16);

/** The embedded engine as an executable (0700) file on disk; the same path every call. */
export function engineScriptPath(): string {
  const path = join(tmpdir(), `devbox-account-${ENGINE_DIGEST}.sh`);
  try {
    // lstat, not stat: a symlink planted in a shared $TMPDIR must not pass as our copy —
    // it fails this check and the rename below replaces it.
    const st = lstatSync(path);
    if (st.isFile() && st.size === Buffer.byteLength(engineScript) && (st.mode & 0o777) === 0o700) return path;
  } catch {
    // not materialised yet
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, engineScript, { mode: 0o700 });
  renameSync(tmp, path); // atomic, so a concurrent run never reads a half-written script
  return path;
}

/** Where the agents phase installs the engine, and each profile's config tree. */
const BOX_ENGINE = "/usr/local/share/remote-devbox/devbox-account.sh";
const boxConfigDir = (user: string, agentProfile: string) => `/home/${user}/.agent-profiles/${agentProfile}`;

/**
 * The ssh argv that runs the engine on the box, as the developer, WITHOUT sudo.
 *
 * `sudo remote-devbox-account` is the OPERATOR's entry point (it switches users and
 * restarts units, so it needs root). The ssh alias here logs in as the developer, who has
 * no sudo at all — going through the wrapper would just fail. The developer owns the
 * profile's config tree and vault, so the engine needs no privilege for park/restore; only
 * the Remote Control restart does, which `useHint` below hands back to the operator.
 * `-t` because macOS/Linux both want a tty for the engine's prompts and clean output.
 */
export function remoteArgv(
  cfg: Config,
  profile: string,
  argv: string[],
  agentProfile: string = DEFAULT_AGENT_PROFILE,
): string[] {
  const env = [
    `CLAUDE_CONFIG_DIR=${shQuote(boxConfigDir(profile, agentProfile))}`,
    "DEVBOX_ACCOUNT_STORE=file",
  ].join(" ");
  const remote = [`env ${env}`, BOX_ENGINE, ...argv.map(shQuote)].join(" ");
  return ["ssh", "-t", hostFor(cfg, profile), remote];
}

/**
 * A `use` that swapped the credential has NOT moved the always-on Remote Control servers:
 * they hold their credential for the life of the session, and only root can restart them.
 * Emitted only when that developer actually has RC units, so a box without projects stays
 * quiet — the check is a read-only `systemctl list-units`, which needs no privilege.
 */
export function useHint(cfg: Config, profile: string, agentProfile: string, label: string): string | null {
  const units = spawnSync(
    "ssh",
    [
      hostFor(cfg, profile),
      `systemctl list-units --all --plain --no-legend 'agent-rc-claude-*.service' | awk '{print $1}'`,
    ],
    { encoding: "utf8" },
  );
  const found = (units.stdout ?? "").split("\n").filter((l) => l.includes(`-${profile}-`));
  if (units.status !== 0 || found.length === 0) return null;
  return (
    `note: ${found.length} Remote Control unit(s) still serve the previous account.\n` +
    `      As the operator: ssh -t <operator>@<box> "sudo remote-devbox-account ${profile} ${agentProfile} use ${label}"`
  );
}

/**
 * Run one engine call — locally, or on the box when `profile` is set — and return the
 * child's exit code so the caller can exit with it. stdio is inherited: the engine owns
 * its output (including `--json`) and macOS keychain prompts must reach the operator.
 */
export function runAccount(argv: string[], opts: { profile?: string; agentProfile?: string } = {}): number {
  if (opts.profile) {
    // loadConfig() only here: a purely local swap must work on a machine that has never
    // been through the installer, and loadConfig() die()s without a client config.
    const cfg = loadConfig();
    const user = resolveProfile(cfg, opts.profile);
    const agentProfile = opts.agentProfile ?? DEFAULT_AGENT_PROFILE;
    const [cmd, ...rest] = remoteArgv(cfg, user, argv, agentProfile);
    const r = spawnSync(cmd!, rest, { stdio: "inherit" });
    if (r.error) die(`could not run ssh: ${r.error.message}`);
    const code = r.status ?? 1;
    if (code === 0 && argv[0] === "use" && argv[1]) {
      pinOmpAfterRemoteUse(hostFor(cfg, user), argv[1]);
      const hint = useHint(cfg, user, agentProfile, argv[1]);
      if (hint) console.log(hint);
    }
    return code;
  }
  // The engine reads CLAUDE_CONFIG_DIR / DEVBOX_ACCOUNT_* from the environment, which
  // spawnSync inherits, so an operator can point a call at another tree or vault.
  const r = spawnSync(engineScriptPath(), argv, { stdio: "inherit" });
  if (r.error) die(`could not run the account engine: ${r.error.message}`);
  const code = r.status ?? 1;
  if (code === 0 && argv[0] === "use" && argv[1]) pinOmpAfterUse(argv[1]);
  return code;
}
