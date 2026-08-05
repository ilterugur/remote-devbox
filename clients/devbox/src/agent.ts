/**
 * agent.ts — `devbox agent`: the long-lived pieces of the client, described once and
 * handed to launchd.
 *
 * Two shapes cover what we need. A "daemon" is a process that should simply always be
 * running (the desktop tunnel: KeepAlive restarts it when the network drops it). An
 * "interval" is a reconciler that should run again every so often (the mount bridge:
 * `devbox mount up` is idempotent, so re-running it is how a mount survives sleep/wake).
 *
 * Rendering is pure and tested; runAgentUp/Down/Status do the fs and launchctl work.
 * Honors DEVBOX_DRYRUN=1 (print, don't execute).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { die, hostFor, lazyMountsFor, type Config } from "./config";

export type AgentMode = "daemon" | "interval";

export type AgentSpec = {
  label: string;
  mode: AgentMode;
  argv: string[];
  intervalSeconds?: number;
  description: string;
  /** Named at description time, not at connect time: something about this agent cannot
   *  work as configured, and the plist itself is not where that shows up. */
  warning?: string;
};

/** The box always listens here; only the client side of the forward is configurable. */
const BOX_RDP_PORT = 3389;

export function agentsFor(cfg: Config, profile: string): AgentSpec[] {
  const p = cfg.profiles.find((x) => x.user === profile);
  if (!p) return [];
  const host = hostFor(cfg, profile);
  const out: AgentSpec[] = [];

  if (p.desktop?.clientPort) {
    const port = p.desktop.clientPort;
    // A forward is only a door when something is listening behind it. `tunnel` is what
    // makes xrdp bind 127.0.0.1 on the box; without it the forward binds locally, ssh
    // stays happily alive (ExitOnForwardFailure covers the bind, never the connect) and
    // every RDP attempt is refused at the far end. Say so here — at describe time — since
    // nothing downstream can tell that apart from a healthy tunnel.
    const access = p.desktop.access;
    const warning =
      access && access.length && !access.includes("tunnel")
        ? `desktop.access for "${profile}" is [${access.join(", ")}] — with no "tunnel" the box has ` +
          `no 127.0.0.1:${BOX_RDP_PORT} listener, so this tunnel forwards to nothing. Add "tunnel" ` +
          `to that developer's desktop.access in devbox.yml and re-apply.`
        : undefined;
    out.push({
      label: `com.devbox.${profile}.desktop`,
      mode: "daemon",
      description: `RDP desktop: 127.0.0.1:${port} -> ${host}:${BOX_RDP_PORT}`,
      warning,
      argv: [
        "ssh", "-N",
        // Without this a forward that cannot bind leaves a live, useless ssh — launchd
        // would see a healthy process and never restart it.
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-L", `127.0.0.1:${port}:127.0.0.1:${BOX_RDP_PORT}`,
        host,
      ],
    });
  }

  // Only a profile whose lazy mounts are known gets the reconciler, and today that means
  // a legacy all.yml checkout: neither devbox.yml nor the box's client.json describes lazy
  // mounts yet, so on the canonical path there is nothing to reconcile and no agent.
  if (lazyMountsFor(cfg, profile).length) {
    out.push({
      label: `com.devbox.${profile}.mount`,
      mode: "interval",
      intervalSeconds: 60,
      description: "lazy mounts: re-establish after sleep, wake or a dropped link",
      argv: ["devbox", "mount", "up"],
    });
  }

  return out;
}

export const plistPath = (label: string, home: string = homedir()): string =>
  join(home, "Library", "LaunchAgents", `${label}.plist`);

export const logDirFor = (home: string = homedir()): string =>
  join(home, ".local", "state", "devbox");

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The environment launchd does NOT provide. Its default PATH is /usr/bin:/bin:/usr/sbin:
 * /sbin, which holds none of the things these agents run: `devbox` itself lives in
 * ~/.local/bin, and once it is running `devbox mount up` spawns rclone, ssh and ssh-keygen
 * by bare name from Homebrew. Resolving argv[0] is not enough — the miss then happens one
 * level down, every 60 seconds, into a log nobody reads. HOME is pinned for the same
 * reason: everything the CLI reads (config, bridges, keys) hangs off it.
 */
export function agentEnv(home: string = homedir()): Record<string, string> {
  const path = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return { PATH: path, HOME: home };
}

export function renderPlist(spec: AgentSpec, logDir: string, home: string = homedir()): string {
  const args = spec.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(agentEnv(home))
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const cadence =
    spec.mode === "daemon"
      ? "  <key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>\n  <true/>"
      : `  <key>StartInterval</key>\n  <integer>${spec.intervalSeconds ?? 60}</integer>\n  <key>RunAtLoad</key>\n  <true/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
${cadence}
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, `${spec.label}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, `${spec.label}.log`))}</string>
</dict>
</plist>
`;
}

const isDry = () => !!process.env.DEVBOX_DRYRUN;
const out = (s: string) => process.stdout.write(s + "\n");

/**
 * launchd does not read a login shell's PATH, so a bare command name in a plist simply
 * never runs — and the failure is silent apart from a line in the log. Resolve here,
 * once, at the boundary between the described agent and the written one.
 */
export function resolveArgv(argv: string[]): string[] {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd.startsWith("/")) return argv;
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  const path = (r.stdout || "").trim();
  if (!path) {
    // A dry run must print what would happen and change nothing, even on a checkout
    // where the command isn't installed yet — show the bare command rather than abort.
    if (isDry()) return argv;
    die(`cannot find '${cmd}' on PATH — launchd needs an absolute path`);
  }
  return [path, ...rest];
}

// env is passed explicitly (not left to spawnSync's default) so a PATH change in the
// current process — e.g. a test pointing at a fake launchctl — actually takes effect;
// otherwise the executable search resolves against a stale, process-start snapshot.
const launchctl = (...args: string[]) => spawnSync("launchctl", args, { encoding: "utf8", env: process.env });

const domain = (): string => `gui/${process.getuid?.() ?? 0}`;

function isLoaded(label: string): boolean {
  return launchctl("print", `${domain()}/${label}`).status === 0;
}

/**
 * Bootout `label` if launchd currently has it loaded — and check the result. A failed
 * bootout (permission issue, launchd race, stale state) must not be swallowed: callers
 * write a new plist or delete the old one right after this, and if the label is still
 * loaded afterward it ends up pointing at a file that changed or vanished out from
 * under it, while the CLI goes on to report success.
 */
export function bootoutIfLoaded(label: string): void {
  if (!isLoaded(label)) return;
  const r = launchctl("bootout", `${domain()}/${label}`);
  if (r.status !== 0) die(`launchctl bootout failed for ${label}: ${(r.stderr || "").trim()}`);
}

function requireMac(): void {
  if (process.platform === "darwin") return;
  out("devbox: client agents are launchd (macOS) only.");
  out("On Linux, place the equivalent systemd --user unit yourself:");
  out("  ~/.config/systemd/user/devbox-<name>.service   (ExecStart = the argv below)");
  out("  systemctl --user daemon-reload && systemctl --user enable --now devbox-<name>");
  process.exit(0);
}

/**
 * Every agent of this profile's that is currently ON DISK, whatever the config now says.
 * The desired set is not enough to reconcile against: flipping `desktop.enabled: false`
 * makes agentsFor return nothing, and an agent nobody describes any more is exactly the
 * one that would otherwise keep running forever.
 *
 * Deliberately narrow: `com.devbox.<profile>.<name>.plist` and nothing else, so a
 * hand-written `com.devbox.mount` from before this command existed is never booted out
 * from under its owner.
 */
export function installedAgentLabels(profile: string, home: string = homedir()): string[] {
  const prefix = `com.devbox.${profile}.`;
  let names: string[];
  try {
    names = readdirSync(join(home, "Library", "LaunchAgents"));
  } catch {
    return []; // no LaunchAgents directory yet — nothing installed
  }
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(".plist") && !n.slice(prefix.length, -6).includes("."))
    .map((n) => n.slice(0, -6))
    .sort();
}

/** Unload and delete one agent. Aborts (via bootoutIfLoaded) rather than deleting a
 *  plist out from under a label launchd still has loaded. */
function removeAgent(label: string, why: string): void {
  const path = plistPath(label);
  if (isDry()) return void out(`  ── would remove ${path}${why}`);
  bootoutIfLoaded(label);
  rmSync(path, { force: true });
  out(`  ✓ ${label} removed${why}`);
}

/** Install (or update) every agent this profile should have running, and remove the ones
 *  it should not. Idempotent. */
export function runAgentUp(cfg: Config, profile: string): void {
  requireMac();
  const specs = agentsFor(cfg, profile);
  const logDir = logDirFor();
  if (specs.length && !isDry()) mkdirSync(logDir, { recursive: true });

  for (const spec of specs) {
    if (spec.warning) out(`  ! ${spec.label} — ${spec.warning}`);
    const resolved: AgentSpec = { ...spec, argv: resolveArgv(spec.argv) };
    const path = plistPath(spec.label);
    const wanted = renderPlist(resolved, logDir);

    if (isDry()) {
      out(`  ── would write ${path}`);
      out(`     ${resolved.argv.join(" ")}`);
      continue;
    }

    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === wanted && isLoaded(spec.label)) {
      out(`  ✓ ${spec.label} already current`);
      continue;
    }
    // bootout BEFORE the write: bootstrap on an already-loaded label is an error, so the
    // reload is what makes a changed plist take effect — and if the bootout fails we abort
    // with the file on disk still being the one launchd loaded. Writing first would leave
    // a live label pointing at content it was never bootstrapped with.
    bootoutIfLoaded(spec.label);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, wanted);
    const r = launchctl("bootstrap", domain(), path);
    if (r.status !== 0) die(`launchctl bootstrap failed for ${spec.label}: ${(r.stderr || "").trim()}`);
    out(`  ✓ ${spec.label} — ${spec.description}`);
  }

  const wantedLabels = new Set(specs.map((s) => s.label));
  for (const label of installedAgentLabels(profile)) {
    if (!wantedLabels.has(label)) removeAgent(label, " (no longer configured)");
  }
  if (!specs.length) out(`devbox: no client agents configured for "${profile}"`);
}

/** Remove this profile's agents — the described ones and any left over from a config
 *  that has since changed. */
export function runAgentDown(cfg: Config, profile: string): void {
  requireMac();
  const labels = new Set([...agentsFor(cfg, profile).map((s) => s.label), ...installedAgentLabels(profile)]);
  if (!labels.size) return void out(`devbox: no client agents installed for "${profile}"`);
  for (const label of labels) removeAgent(label, "");
}

/** What is described, what launchd has, and — for the desktop — what the local end of the
 *  tunnel is actually doing. */
export function runAgentStatus(cfg: Config, profile: string): void {
  const specs = agentsFor(cfg, profile);
  const installed = installedAgentLabels(profile);
  if (!specs.length && !installed.length) return void out(`devbox: no client agents configured for "${profile}"`);
  for (const spec of specs) {
    const loaded = process.platform === "darwin" && isLoaded(spec.label);
    out(`  ${loaded ? "●" : "○"} ${spec.label} — ${spec.description}`);
    if (spec.warning) out(`      ! ${spec.warning}`);
    const forward = spec.argv[spec.argv.indexOf("-L") + 1];
    if (spec.mode === "daemon" && forward) {
      const port = forward.split(":")[1]!;
      const listening = spawnSync("nc", ["-z", "-G", "1", "127.0.0.1", port]).status === 0;
      // Say only what this proves. The listener is ssh's OWN: it accepts the TCP
      // connection first and only then tries to open the channel to the box, so a
      // successful connect means "the tunnel process is alive", never "the box's xrdp
      // answers". Calling that "answers" certified broken desktops as healthy.
      out(
        listening
          ? `      127.0.0.1:${port} accepts connections — that is ssh's own listener, not proof the box's xrdp answers`
          : `      127.0.0.1:${port} refuses connections — the tunnel is not up`,
      );
    }
  }
  const wantedLabels = new Set(specs.map((s) => s.label));
  for (const label of installed) {
    if (!wantedLabels.has(label)) out(`  ? ${label} — installed but no longer configured ('devbox agent up' removes it)`);
  }
}
