/**
 * mutagen.ts — Mutagen-backed SyncEngine. `mutagen sync create` runs over the system
 * ssh (agent auto-installed on the box, no listener). Two-way-safe ONLY — never
 * two-way-resolved (it can silently delete the box side). Pure argv builders are
 * exported for tests.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapAgent, isLoaded, plistPath } from "../agent";
import { die } from "../config";
import type { SyncAutostart, SyncEngine, SyncStatus, SyncUpOpts } from "./engine";

/** The label `mutagen daemon register` writes on macOS (KeepAlive, Aqua session). */
export const MUTAGEN_AGENT_LABEL = "io.mutagen.mutagen";

export const sessionName = (profile: string): string => `devbox-${profile}`;

/** Map the box's `uname -m` to the Mutagen agent bundle filename, or null if unknown. */
export function goAgentFile(uname: string): string | null {
  const m = uname.trim();
  if (m === "x86_64" || m === "amd64") return "linux_amd64";
  if (m === "aarch64" || m === "arm64") return "linux_arm64";
  return null;
}

const sshb = (host: string, cmd: string) => spawnSync("ssh", ["-o", "BatchMode=yes", host, cmd], { encoding: "utf8" });

/** Bounded wait for the daemon to actually exit after `daemon stop` (3s at 0.1s each). */
const REGISTER_ATTEMPTS = 30;

/**
 * Make the Mutagen daemon launchd's problem rather than a side effect of the last
 * `devbox` command that happened to run.
 *
 * Without this the disk stops syncing at every reboot, silently and for as long as
 * nobody runs a devbox command: the daemon is started on demand by whichever mutagen
 * subcommand needs it, so an interactive `devbox sync status` "fixes" it and hides
 * how long the box and the client had been drifting apart. Measured on a client
 * booted 3h earlier: zero sync, 442-file disk, no error anywhere.
 *
 * `mutagen daemon register` writes the plist but REFUSES while a daemon is running,
 * and it never starts what it registered — so registration has to stop the daemon
 * first and hand the restart to launchd. The stop is not destructive: sessions live in
 * the daemon's own on-disk database and resume when it comes back.
 *
 * `daemon stop` returns when the daemon has ACCEPTED the shutdown, not when its process
 * is gone, so a register fired straight after it still loses the race ("unable to alter
 * registration while daemon is running"). Retry in tenths of a second, bounded — the
 * same shape as the launchd waits in agent.ts, and for the same reason: the state either
 * resolves quickly or never does.
 */
export function ensureDaemonAutostart(home: string = homedir()): void {
  if (process.platform !== "darwin") return; // registration is launchd-shaped
  if (isLoaded(MUTAGEN_AGENT_LABEL)) return;
  const plist = plistPath(MUTAGEN_AGENT_LABEL, home);
  // env is passed explicitly on every spawn below: Bun resolves the executable against
  // a PATH snapshot taken at process start otherwise, which makes a test's fake
  // `mutagen`/`launchctl` unreachable (same reason agent.ts does it).
  const daemon = (verb: string) =>
    spawnSync("mutagen", ["daemon", verb], { stdio: "ignore", env: process.env });
  if (!existsSync(plist)) {
    daemon("stop");
    let registered = daemon("register").status === 0;
    for (let attempt = 1; attempt < REGISTER_ATTEMPTS && !registered; attempt++) {
      spawnSync("/bin/sleep", ["0.1"]);
      registered = daemon("register").status === 0;
    }
    if (!registered) {
      // Put back exactly what we stopped rather than leaving the client with neither a
      // registered daemon nor a running one.
      daemon("start");
      return;
    }
  }
  try {
    bootstrapAgent(MUTAGEN_AGENT_LABEL, plist);
  } catch {
    // launchd refused the label; the daemon below still gets the sync running now.
  }
  // No-op ("already running") once launchd started it from the plist.
  daemon("start");
}

/**
 * Pre-stage the Mutagen agent on the box so `mutagen sync create` doesn't have to copy it.
 * On hardened boxes whose OpenSSH 9+ scp transfers via SFTP, scp drops the executable bit, so
 * Mutagen's own agent copy lands non-executable and fails ("Permission denied"). We stage the
 * version-matched agent from the local Homebrew Mutagen bundle (so it always matches the client
 * version) and chmod +x. Best-effort: any failure just falls back to Mutagen's own install.
 */
function ensureBoxAgent(host: string): void {
  const ver = spawnSync("mutagen", ["version"], { encoding: "utf8" }).stdout?.trim();
  if (!ver) return;
  const remote = `.mutagen/agents/${ver}/mutagen-agent`;
  if (sshb(host, `test -x ${remote}`).status === 0) return; // already staged & executable

  const prefix = spawnSync("brew", ["--prefix", "mutagen"], { encoding: "utf8" }).stdout?.trim();
  if (!prefix) return; // not a Homebrew install — let Mutagen try its own copy
  const bundle = join(prefix, "libexec", "mutagen-agents.tar.gz");
  if (!existsSync(bundle)) return;

  const uname = sshb(host, "uname -m").stdout ?? "";
  const agentFile = goAgentFile(uname);
  if (!agentFile) return;

  const tmp = mkdtempSync(join(tmpdir(), "devbox-magent-"));
  try {
    if (spawnSync("tar", ["xzf", bundle, "-C", tmp, agentFile]).status !== 0) return;
    if (sshb(host, `mkdir -p .mutagen/agents/${ver}`).status !== 0) return;
    if (spawnSync("scp", ["-q", join(tmp, agentFile), `${host}:${remote}`]).status !== 0) return;
    sshb(host, `chmod +x ${remote}`); // scp (SFTP) drops the exec bit; restore it
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function buildCreateArgs(o: SyncUpOpts): string[] {
  return [
    "sync", "create",
    `--name=${sessionName(o.profile)}`,
    "--label=devbox=true",
    "--sync-mode=two-way-safe",
    "--ignore-vcs",
    ...o.ignores.map((p) => `--ignore=${p}`),
    o.localRoot,
    `${o.host}:${o.remoteRoot}`,
  ];
}

export function buildStatusArgs(): string[] {
  // Fields verified against mutagen 0.18.1: each list element exposes .Name / .Status /
  // .Conflicts directly. The char between }} and {{ is a literal TAB (Go emits it verbatim).
  //
  // .Conflicts is promoted from the embedded SessionState, which is a nil pointer while a
  // session is paused. Reaching through it aborts the whole run — Go prints the row and
  // then fails with "indirection through nil pointer to embedded struct field
  // SessionState", exiting non-zero — so one paused session would blank out every other
  // session's status. Guarding on the embedded struct keeps the row and reports the only
  // honest conflict count for a paused session: none are known.
  return [
    "sync", "list", "--label-selector=devbox=true",
    "--template",
    '{{range .}}{{.Name}}\t{{.Status}}\t{{if .SessionState}}{{len .Conflicts}}{{else}}unknown{{end}}{{"\\n"}}{{end}}',
  ];
}

/** Parse the tab-separated rows the status template emits. Pure — exported for tests. */
export function parseStatusOutput(stdout: string): SyncStatus[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [name = "", state = "", rawConflicts] = l.split("\t");
      const conflicts = rawConflicts !== undefined && /^[0-9]+$/.test(rawConflicts)
        ? Number(rawConflicts)
        : null;
      return { name, state, conflicts };
    });
}

const mutagen = (args: string[]) => spawnSync("mutagen", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

export class MutagenEngine implements SyncEngine {
  readonly id = "mutagen" as const;

  // Mutagen is driven by synchronous spawnSync; the methods are async only to satisfy
  // the SyncEngine contract (Syncthing genuinely needs async).
  async up(o: SyncUpOpts): Promise<void> {
    // FIRST, and outside the idempotence check below: the existence probe is itself a
    // mutagen subcommand, so it starts the daemon, and `daemon register` refuses once
    // that has happened. Registering here is also the only path that reaches a client
    // whose session was created before this existed.
    ensureDaemonAutostart();
    // idempotent: skip if the named session exists. Use the exit code of
    // `mutagen sync list <name>` (robust — does NOT depend on --template field paths).
    const exists = spawnSync("mutagen", ["sync", "list", sessionName(o.profile)], { stdio: "ignore" }).status === 0;
    if (exists) return;
    ensureBoxAgent(o.host); // pre-stage the agent (hardened-box scp drops +x) — best-effort
    const r = mutagen(buildCreateArgs(o));
    if (r.status !== 0) die(`mutagen sync create failed (exit ${r.status})`);
  }

  autostart(): SyncAutostart | null {
    if (process.platform !== "darwin") return null;
    return { registered: isLoaded(MUTAGEN_AGENT_LABEL) };
  }

  ensureAutostart(): void {
    ensureDaemonAutostart();
  }

  async down(profile: string): Promise<void> {
    spawnSync("mutagen", ["sync", "terminate", sessionName(profile)], { stdio: "inherit" });
  }

  async pause(profile: string): Promise<void> {
    spawnSync("mutagen", ["sync", "pause", sessionName(profile)], { stdio: "inherit" });
  }

  async resume(profile: string): Promise<void> {
    spawnSync("mutagen", ["sync", "resume", sessionName(profile)], { stdio: "inherit" });
  }

  async status(): Promise<SyncStatus[]> {
    const r = mutagen(buildStatusArgs());
    // Mutagen streams rows as it ranges, so a template failure on one session still leaves
    // the earlier rows on stdout. Parse whatever arrived rather than reporting "no sessions"
    // — an empty list reads as "sync is not running", which is a worse lie than a short one.
    if (!r.stdout) return [];
    return parseStatusOutput(r.stdout);
  }
}
