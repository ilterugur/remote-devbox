/**
 * config.ts — side-effect-free domain layer for the devbox CLI.
 *
 * Everything here is a pure function or a small fs/spawn helper with NO top-level
 * execution (no loadConfig() call, no cli.parse()). devbox.ts (the CLI entrypoint)
 * and push.ts both import from here. Keeping it side-effect-free is what lets
 * push.ts reuse the targeting/host/connect logic without booting the CLI.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ensureClientTransport } from "./install";
import { resolveEntry, type ResolvedEntry } from "./app-configs/registry";

/**
 * Where this client's config lives. `remote-devbox` is canonical — it is what
 * `gen-editor-config.py --cli` writes and what the project is called. `claude-devbox` is
 * the pre-rename directory, still READ so an existing setup keeps working.
 *
 * One resolution for every file we keep here (config, active profile, live bridges), so
 * a client can never end up with its config in one directory and its state in the other —
 * which is how a config written by one tool became invisible to another.
 */
const CANONICAL_CFG_DIR = (home: string) => join(home, ".config", "remote-devbox");
const LEGACY_CFG_DIR = (home: string) => join(home, ".config", "claude-devbox");

export function resolveCfgDir(home: string = homedir()): string {
  const canonical = CANONICAL_CFG_DIR(home);
  if (existsSync(join(canonical, "config.json"))) return canonical;
  const legacy = LEGACY_CFG_DIR(home);
  if (existsSync(join(legacy, "config.json"))) return legacy;
  return canonical; // nothing yet: a fresh client writes the canonical directory
}

export const cfgDir = (): string => resolveCfgDir();
export const configPath = (): string => join(cfgDir(), "config.json");
export const statePath = (): string => join(cfgDir(), "active-profile");

export type Project = { name: string; repo?: string };
export type LazyMount = { label: string; path: string };
export type EngineId = "mutagen" | "syncthing";
export type Profile = {
  user: string;
  projects: Project[];
  lazyMounts?: LazyMount[];
  syncEngine?: EngineId;
  syncDisk?: boolean;
  lazyMountOnConnect?: boolean;
  appConfigs?: ResolvedEntry[];
};
// `host` is written by gen-editor-config.py for reference only — the CLI resolves
// the box via the ssh alias `${prefix}-${profile}` (HostName lives in ~/.ssh/config).
// `repoPath` is the claude-devbox checkout this config was generated from (written by
// gen-editor-config.py --cli) — `devbox add --write` edits its group_vars/all.yml.
export type Config = { prefix: string; default: string; locale: string; launch: string; host?: string; repoPath?: string; profiles: Profile[] };

export function die(msg: string): never {
  if (process.env.NODE_ENV === "test") throw new Error(msg); // testable: don't kill the runner
  process.stderr.write(`devbox: ${msg}\n`);
  process.exit(1);
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    die(`no config at ${path} — run gen-editor-config.py --cli, or fetch one from the box ` +
        `(\`devbox client-config\` there prints what a client needs)`);
  }
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Config;
    if (!c.profiles?.length) die("config has no profiles");
    // The `profiles` in config.json are a cache written by gen-editor-config.py. When
    // we know the claude-devbox checkout (repoPath), read profiles/projects LIVE from
    // its group_vars/all.yml instead — so `devbox add --write` (which edits all.yml)
    // shows up immediately with no regen. Falls back to the cache if all.yml is gone
    // (checkout moved/deleted) or unparseable.
    if (c.repoPath) {
      const live = profilesFromYaml(c.repoPath);
      if (live?.length) c.profiles = live;
    }
    return c;
  } catch (e) {
    die(`could not read ${path}: ${(e as Error).message}`);
  }
}

/**
 * Read the developer list live from the repo checkout, so a change to the config shows
 * up without regenerating anything.
 *
 * Two shapes are accepted, canonical first: `devbox.yml` (developers) is the source of
 * truth, and `ansible/group_vars/all.yml` (profiles) is the legacy layout kept readable
 * for boxes that have not been migrated yet. Returns null on any problem so callers fall
 * back to the cache written into config.json.
 *
 * The CLI's own vocabulary stays "profile": it means "the account you connect as", which
 * is exactly a developer. Only the file it reads changed.
 */
export function profilesFromYaml(repoPath: string): Profile[] | null {
  return developersFromDevboxYaml(repoPath) ?? profilesFromLegacyYaml(repoPath);
}

/** Canonical layout: `<repoPath>/devbox.yml`, `developers:`. */
function developersFromDevboxYaml(repoPath: string): Profile[] | null {
  try {
    const doc = Bun.YAML.parse(readFileSync(join(repoPath, "devbox.yml"), "utf8")) as any;
    const devs = doc?.developers;
    if (!Array.isArray(devs) || devs.length === 0) return null;
    const out: Profile[] = [];
    for (const d of devs) {
      if (!d?.user) return null; // malformed — prefer the cache over a partial list
      const profile: Profile = {
        user: String(d.user),
        projects: Array.isArray(d.projects)
          ? d.projects.map((pr: any) => ({ name: String(pr.name), repo: pr.repo ? String(pr.repo) : "" }))
          : [],
      };
      if (d.file_bridge?.sync_disk) profile.syncDisk = true;
      if (d.file_bridge?.engine) profile.syncEngine = d.file_bridge.engine as EngineId;
      const rawPaths = d.app_configs?.enabled ? (d.app_configs.paths ?? []) : [];
      const entries = rawPaths.flatMap((raw: any) => {
        const r = resolveEntry(raw);
        return "entry" in r ? [r.entry] : [];
      });
      if (entries.length) profile.appConfigs = entries;
      out.push(profile);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Legacy layout: `<repoPath>/ansible/group_vars/all.yml`, `profiles:`. Mirrors the
 * mapping in gen-editor-config.py's write_cli_config so the live read and the fallback
 * cache behave identically.
 */
function profilesFromLegacyYaml(repoPath: string): Profile[] | null {
  try {
    const path = join(repoPath, "ansible", "group_vars", "all.yml");
    const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as any;
    const profs = doc?.profiles;
    if (!Array.isArray(profs) || profs.length === 0) return null;
    const out: Profile[] = [];
    for (const p of profs) {
      if (!p?.user) return null;
      const profile: Profile = {
        user: String(p.user),
        projects: Array.isArray(p.projects)
          ? p.projects.map((pr: any) => ({ name: String(pr.name), repo: pr.repo ? String(pr.repo) : "" }))
          : [],
      };
      if (Array.isArray(p.lazy_mounts) && p.lazy_mounts.length)
        profile.lazyMounts = p.lazy_mounts.map((m: any) => ({ label: String(m.label), path: String(m.path) }));
      if (p.sync_engine) profile.syncEngine = p.sync_engine as EngineId;
      if (p.sync_disk) profile.syncDisk = true;
      if (p.lazy_mount_on_connect) profile.lazyMountOnConnect = true;
      out.push(profile);
    }
    return out;
  } catch {
    return null;
  }
}

export const users = (cfg: Config) => cfg.profiles.map((p) => p.user);

export function readState(): string | null {
  try {
    return readFileSync(statePath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeState(prof: string) {
  mkdirSync(cfgDir(), { recursive: true });
  writeFileSync(statePath(), prof + "\n");
}

export function resolveProfile(cfg: Config, override?: string): string {
  const prof = override || readState() || cfg.default;
  if (!users(cfg).includes(prof)) die(`unknown profile "${prof}" (have: ${users(cfg).join(" ")})`);
  return prof;
}

/** Normalize a git remote URL to host/owner/repo (lowercased, no scheme/.git). */
export function normRepo(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//, ""); // scheme
  u = u.replace(/^git@/, "");
  u = u.replace(/^[^@/]*@/, ""); // user@
  u = u.replace(":", "/"); // git@host:path -> host/path
  u = u.replace(/\/+$/, "");
  u = u.replace(/\.git$/, "");
  return u.replace(/\/+$/, "");
}

/**
 * Return ALL config profiles/projects whose repo matches the origin of the git
 * repo at `cwd` (default: process.cwd()). Empty array if `cwd` is not a git repo,
 * has no origin, or nothing matches. push uses the full list to detect ambiguity;
 * the connect path uses the first entry.
 */
export function gitMatch(cfg: Config, cwd: string = process.cwd()): { profile: string; project: string }[] {
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" }).status !== 0) return [];
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  const want = normRepo(r.stdout);
  const out: { profile: string; project: string }[] = [];
  for (const p of cfg.profiles)
    for (const pr of p.projects) if (pr.repo && normRepo(pr.repo) === want) out.push({ profile: p.user, project: pr.name });
  return out;
}

/**
 * True when `cwd` is a linked git worktree. In a worktree, --absolute-git-dir is
 * .../.git/worktrees/<name> while --git-common-dir resolves to the main .../.git;
 * in the main checkout they are the same.
 */
export function isWorktree(cwd: string): boolean {
  const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8" });
  const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (gitDir.status !== 0 || commonDir.status !== 0) return false;
  return resolve(cwd, gitDir.stdout.trim()) !== resolve(cwd, commonDir.stdout.trim());
}

/** POSIX single-quote a value for safe embedding in a remote command string. */
export const shQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** The ssh/mosh host alias for a profile (e.g. `devbox-work`). */
export const hostFor = (cfg: Config, prof: string) => `${cfg.prefix}-${prof}`;

/** Connection transport into the box-side tmux session. "auto" = et > mosh > ssh. */
export type Transport = "auto" | "et" | "mosh" | "ssh";

/** Resolve the wanted transport: explicit per-call opt > DEVBOX_TRANSPORT env > legacy
 *  DEVBOX_NO_MOSH (forces ssh) > "auto". "none" is accepted as an alias for "ssh". */
export function resolveTransport(opt?: Transport): Transport {
  const raw = (opt ?? process.env.DEVBOX_TRANSPORT ?? "").toLowerCase();
  if (raw === "none") return "ssh";
  if (raw === "et" || raw === "mosh" || raw === "ssh" || raw === "auto") return raw;
  if (raw) { process.stderr.write(`devbox: unknown transport "${raw}" (et|mosh|ssh|auto) — using auto\n`); }
  if (process.env.DEVBOX_NO_MOSH != null) return "ssh"; // back-compat
  return "auto";
}

/** Effective hostname/port for an ssh alias, straight from ssh's own config parser. */
export function resolveSshHostPort(alias: string): { host: string; port: number } | null {
  const r = spawnSync("ssh", ["-G", alias], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  let host = "";
  let port = 22;
  for (const line of r.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1).trim();
    if (key === "hostname" && value) host = value;
    else if (key === "port" && value) port = Number(value) || 22;
  }
  return host ? { host, port } : null;
}

/** TCP reachability probe. Returns true when we cannot test, so a missing `nc` degrades
 *  to the old behaviour rather than blocking a connection that would have worked. */
export function portOpen(host: string, port: number, timeoutSec = 3): boolean {
  if (Bun.which("nc") == null) return true;
  return spawnSync("nc", ["-z", "-w", String(timeoutSec), host, String(port)]).status === 0;
}

/** The TCP port a transport needs, or null when it cannot be probed. */
export const transportPort = (t: Transport, sshPort: number): number | null =>
  t === "et" ? 2022 : t === "ssh" ? sshPort : null; // mosh is UDP — no cheap probe

/**
 * Which transport to actually use. Split out from connect() so the decision is testable
 * without a network: "auto" used to mean "whichever accelerator is installed HERE",
 * which is only half the question. Eternal Terminal's port is commonly reachable on one
 * path and firewalled on another (here it is tailnet-only), so on the other path the old
 * logic picked it and failed instead of falling back to ssh, which would have worked.
 *
 * mosh is left unprobed: its UDP range has no cheap equivalent of a TCP connect, so a
 * blocked range still shows up as mosh's own "nothing received" timeout.
 */
export function pickTransport(opts: {
  want: Transport;
  has: (bin: string) => boolean;
  canReach: (t: Transport) => boolean;
  offerInstall?: (t: Transport) => boolean;
}): { pick: Transport; note?: string } {
  const { want, has, canReach } = opts;
  const offerInstall = opts.offerInstall ?? (() => false);

  if (want === "ssh") return { pick: "ssh" };

  if (want === "auto") {
    for (const t of ["et", "mosh"] as const) {
      if (!has(t)) continue;
      if (canReach(t)) return { pick: t };
      return { pick: "ssh", note: NOT_REACHABLE(t) };
    }
    if (offerInstall("et") && canReach("et")) return { pick: "et" };
    return { pick: "ssh" };
  }

  // An explicit choice still offers to install, but is not forced through when the box
  // cannot be reached that way — failing with the user's own flag is not more honest
  // than telling them why it cannot work here.
  if (!has(want) && !offerInstall(want)) return { pick: "ssh" };
  if (!canReach(want)) return { pick: "ssh", note: NOT_REACHABLE(want) };
  return { pick: want };
}

const NOT_REACHABLE = (t: Transport) =>
  t + " is installed but its port is not reachable on this path — using ssh";

export function connect(
  cfg: Config,
  prof: string,
  project: string | null,
  opts: { shellOnly?: boolean; launch?: string; dir?: string; transport?: Transport } = {},
) {
  const sess = project || "main"; // treat "" like null (an empty tmux -s name is rejected)
  const dir = opts.dir ?? (project ? `/home/${prof}/projects/${project}` : `/home/${prof}`);
  const host = hostFor(cfg, prof);
  const env = { ...process.env, LANG: cfg.locale, LC_ALL: cfg.locale, LC_CTYPE: cfg.locale };
  const tmux = ["tmux", "new", "-A", "-s", sess, "-c", dir];
  const launch = opts.launch ?? cfg.launch;
  if (!opts.shellOnly && launch) tmux.push("bash", "-lc", `${launch}; exec bash`);
  // Tune the session for a remote terminal, chained as extra tmux commands via literal
  // ";" args (works for both the mosh argv and the ssh string — tmux treats a bare ";"
  // as a command separator). Default tmux over mosh/ssh feels broken otherwise:
  //   escape-time 0    default 500ms makes keystrokes lag/drop over the link.
  //   set-clipboard on copy escapes to the *system* clipboard via OSC-52 instead of
  //                    landing only in tmux's internal buffer ("copied to tmux session").
  //   mouse off        let the terminal own selection/scroll, so ⌘C/⌘V and native
  //                    selection just work; tmux's mouse mode otherwise hijacks them.
  //   status off       hide tmux's green status strip for this session.
  tmux.push(";", "set", "-g", "escape-time", "0");
  tmux.push(";", "set", "-g", "set-clipboard", "on");
  tmux.push(";", "set", "-g", "mouse", "off");
  tmux.push(";", "set", "status", "off");

  // Pick the transport. All three attach the SAME box-side tmux session, so they're
  // interchangeable per-connect:
  //   et (Eternal Terminal): TCP, auto-reconnect/roaming like mosh but no predictive
  //     echo — the fix for mosh dropping/garbling keystrokes on macOS. Needs `et`
  //     locally (brew install et) and etserver on the box (et_enabled).
  //   mosh: roaming over UDP, but predictive echo misbehaves on some macOS clients.
  //   ssh: plain; tmux still gives persistence, just no roaming/auto-reconnect.
  // Choose via --et/--mosh/--ssh, --transport <t>, or DEVBOX_TRANSPORT; default "auto"
  // prefers et > mosh > ssh by what's installed. A missing client binary triggers a
  // confirm-then-install prompt (ensureClientTransport); decline/failure falls back to
  // ssh. In auto mode we only offer to install when NO accelerator is present (so a box
  // that already has mosh isn't nagged); an explicit choice always offers to install it.
  const want = resolveTransport(opts.transport);
  const has = (b: string) => Bun.which(b) != null;
  let pick: Transport;
  if (process.env.DEVBOX_DRYRUN) {
    pick = want === "auto" ? (has("et") ? "et" : has("mosh") ? "mosh" : "ssh") : want;
  } else {
    const endpoint = resolveSshHostPort(host);
    const chosen = pickTransport({
      want,
      has,
      // An alias ssh itself cannot resolve: let ssh report that, rather than guessing.
      canReach: (t) => {
        if (!endpoint) return true;
        const port = transportPort(t, endpoint.port);
        return port == null ? true : portOpen(endpoint.host, port);
      },
      offerInstall: (t) => (t === "et" || t === "mosh") && ensureClientTransport(t),
    });
    pick = chosen.pick;
    if (chosen.note) process.stderr.write("devbox: " + chosen.note + "\n");
  }
  // mosh forwards argv after `--` intact (no shell). et and ssh take one shell-parsed
  // command string on the box, so build a properly-quoted string for them.
  const remote = tmux.map(shQuote).join(" ");
  let cmd: string, args: string[];
  if (pick === "et") { cmd = "et"; args = [host, "-c", remote]; }
  else if (pick === "mosh") { cmd = "mosh"; args = [host, "--", ...tmux]; }
  else { cmd = "ssh"; args = ["-t", host, remote]; }

  if (process.env.DEVBOX_DRYRUN) {
    process.stdout.write(JSON.stringify([cmd, ...args]) + "\n");
    return;
  }
  const child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("error", (e) => die(`failed to run ${cmd}: ${e.message}`));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

export function projectsOf(cfg: Config, prof: string): string[] {
  return (cfg.profiles.find((p) => p.user === prof)?.projects ?? []).map((p) => p.name);
}

// ── file-bridge accessors (lazy mounts + sync disk) ──────────────────────────
const profileOf = (cfg: Config, prof: string): Profile | undefined => cfg.profiles.find((p) => p.user === prof);

export const lazyMountsFor = (cfg: Config, prof: string): LazyMount[] => profileOf(cfg, prof)?.lazyMounts ?? [];
export const syncEngineFor = (cfg: Config, prof: string): EngineId => profileOf(cfg, prof)?.syncEngine ?? "mutagen";
export const syncDiskEnabled = (cfg: Config, prof: string): boolean => profileOf(cfg, prof)?.syncDisk ?? false;
export const lazyMountOnConnect = (cfg: Config, prof: string): boolean => profileOf(cfg, prof)?.lazyMountOnConnect ?? false;
export const appConfigsFor = (cfg: Config, prof: string): ResolvedEntry[] => profileOf(cfg, prof)?.appConfigs ?? [];

/** The box's reachable hostname/IP behind the ssh alias (from `ssh -G <host>`), for
 *  pinning Syncthing's peer address. Falls back to the alias itself. */
export function sshHostName(host: string): string {
  const r = spawnSync("ssh", ["-G", host], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return host;
  const m = /^hostname\s+(\S+)/m.exec(r.stdout);
  return m ? m[1] : host;
}

// ── session / transcript helpers ─────────────────────────────────────────────

/** The Claude Code projects root: ~/.claude/projects. */
export const projectsRoot = () => join(homedir(), ".claude", "projects");

/**
 * Claude Code's encoded-dir rule: an absolute cwd becomes a dir name by replacing
 * every non-alphanumeric char ('/', '.', '_', '@', space, …) with '-'. This must
 * match exactly, or dash-encoded self-references (e.g. a worktree's bridge-cse_<id>
 * path) won't remap on push/pull. Lossy (so ENCODE-only; never decode a dir name).
 */
export const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** ~/.claude/projects/<encoded-cwd> for a given working directory. */
export const sessionsDir = (cwd: string) => join(projectsRoot(), encodeCwd(cwd));

export type SessionItem = { id: string; mtime: number; firstPrompt: string; file: string; dir: string };

/** First genuine human prompt in a transcript, skipping SDK/meta/command injections. */
export function firstHumanPrompt(jsonlPath: string): string {
  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch {
    return "";
  }
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec: any;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    if (rec.type !== "user" || rec.isMeta === true || rec.promptSource === "sdk") continue;
    const c = rec.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    text = text.trim();
    if (!text || text.startsWith("<command-") || text.startsWith("<system-reminder") || text.startsWith("Caveat:"))
      continue;
    return text;
  }
  return "";
}

/** The first non-null `cwd` recorded in a transcript (the session's working dir). */
export function readSessionCwd(jsonlPath: string): string | null {
  const content = readFileSync(jsonlPath, "utf8");
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec: any;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
  }
  return null;
}

/** Recent sessions for a project's encoded dir, newest first. */
export function listSessions(projectCwd: string): SessionItem[] {
  const dir = sessionsDir(projectCwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const items: SessionItem[] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = join(dir, n);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    items.push({ id: n.slice(0, -6), mtime: st.mtimeMs, firstPrompt: firstHumanPrompt(file), file, dir });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

/** Locate a session .jsonl by id across all project dirs. */
export function findSessionFile(id: string): { file: string; dir: string } | null {
  const root = projectsRoot();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = join(root, d, `${id}.jsonl`);
    if (existsSync(file)) return { file, dir: join(root, d) };
  }
  return null;
}

/** True if a session id is currently live on this client (in the pid registry). */
export function localLiveSession(id: string): boolean {
  const dir = join(homedir(), ".claude", "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (rec?.sessionId === id) return true;
    } catch {
      /* ignore unreadable/partial */
    }
  }
  return false;
}

// ── box-side (remote) session discovery, for `devbox pull` ───────────────────

export type RemoteSession = { id: string; mtime: number; boxRoot: string; firstPrompt: string; file: string };

/**
 * Pull the first genuine human prompt AND the session cwd out of a few transcript
 * records (the remote enumeration greps only the first handful of "type":"user"
 * lines, which carry both `cwd` and the message content). Skips SDK/meta/command
 * injections the same way firstHumanPrompt does.
 */
function scanLines(lines: string[]): { firstPrompt: string; cwd: string | null } {
  let firstPrompt = "";
  let cwd: string | null = null;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let rec: any;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    if (cwd === null && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
    if (!firstPrompt && rec.type === "user" && rec.isMeta !== true && rec.promptSource !== "sdk") {
      const c = rec.message?.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      text = text.trim();
      if (text && !text.startsWith("<command-") && !text.startsWith("<system-reminder") && !text.startsWith("Caveat:"))
        firstPrompt = text;
    }
    if (firstPrompt && cwd) break;
  }
  return { firstPrompt, cwd };
}

/** Run a read-only command on the box; die with a clear message if ssh fails. */
function sshRead(host: string, remote: string, maxBuffer = 64 * 1024 * 1024): string {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remote], { encoding: "utf8", maxBuffer });
  if (r.status !== 0) die(`could not reach ${host}: ${(r.stderr || "").trim() || "ssh failed"}`);
  return r.stdout ?? "";
}

// Parse the streamed "@@@<tab>mtime<tab>file" header lines + the grepped user
// records that follow each, into RemoteSession records. Shared by list + by-id.
function parseRemoteStream(stdout: string): RemoteSession[] {
  const out: RemoteSession[] = [];
  let cur: { mtime: number; file: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const { firstPrompt, cwd } = scanLines(cur.lines);
    out.push({
      id: basename(cur.file).replace(/\.jsonl$/, ""),
      mtime: cur.mtime * 1000,
      boxRoot: cwd ?? "",
      firstPrompt,
      file: cur.file,
    });
    cur = null;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@@\t")) {
      flush();
      const [, mt = "", file = ""] = line.split("\t");
      cur = { mtime: parseInt(mt, 10) || 0, file, lines: [] };
    } else if (cur && line.trim()) {
      cur.lines.push(line);
    }
  }
  flush();
  return out;
}

// Remote shell that, for each matching jsonl, emits a header line then the first
// few "type":"user" records (grep -m stops early, so it's fast even on big files).
const enumScript = (glob: string) =>
  `shopt -s nullglob; for f in ${glob}; do printf '@@@\\t%s\\t%s\\n' "$(stat -c %Y "$f" 2>/dev/null)" "$f"; ` +
  `grep -a -m6 '"type":"user"' "$f" 2>/dev/null || true; done`;

/** Enumerate every Claude session under /home/<profile>/.claude/projects, newest first. */
export function listRemoteSessions(host: string, profile: string): RemoteSession[] {
  const glob = `/home/${profile}/.claude/projects/*/*.jsonl`;
  const sessions = parseRemoteStream(sshRead(host, enumScript(glob)));
  sessions.sort((a, b) => b.mtime - a.mtime);
  // The same session id can live under several box project dirs (a session resumed
  // in more than one cwd). Collapse to one row per id — newest wins — so each session
  // shows once and downstream React keys stay unique.
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/** Locate a single box session by id (across the profile's project dirs). */
export function getRemoteSession(host: string, profile: string, id: string): RemoteSession | null {
  const glob = `/home/${profile}/.claude/projects/*/${id}.jsonl`;
  const sessions = parseRemoteStream(sshRead(host, enumScript(glob)));
  // Same id can match in multiple project dirs — resolve to the newest, matching
  // what listRemoteSessions shows.
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions[0] ?? null;
}
