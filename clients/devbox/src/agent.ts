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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    out.push({
      label: `com.devbox.${profile}.desktop`,
      mode: "daemon",
      description: `RDP desktop: 127.0.0.1:${port} -> ${host}:${BOX_RDP_PORT}`,
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

export function renderPlist(spec: AgentSpec, logDir: string): string {
  const args = spec.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
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

/** Install (or update) every agent this profile should have running. Idempotent. */
export function runAgentUp(cfg: Config, profile: string): void {
  requireMac();
  const specs = agentsFor(cfg, profile);
  if (!specs.length) return void out(`devbox: no client agents configured for "${profile}"`);
  const logDir = logDirFor();
  if (!isDry()) mkdirSync(logDir, { recursive: true });

  for (const spec of specs) {
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
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, wanted);
    // bootout first: bootstrap on an already-loaded label is an error, and reloading is
    // the only way a changed plist takes effect.
    bootoutIfLoaded(spec.label);
    const r = launchctl("bootstrap", domain(), path);
    if (r.status !== 0) die(`launchctl bootstrap failed for ${spec.label}: ${(r.stderr || "").trim()}`);
    out(`  ✓ ${spec.label} — ${spec.description}`);
  }
}

/** Remove this profile's agents. */
export function runAgentDown(cfg: Config, profile: string): void {
  requireMac();
  const specs = agentsFor(cfg, profile);
  if (!specs.length) return void out(`devbox: no client agents configured for "${profile}"`);
  for (const spec of specs) {
    const path = plistPath(spec.label);
    if (isDry()) { out(`  ── would remove ${path}`); continue; }
    // Abort before removing anything if bootout fails — don't delete the plist and
    // claim success while the agent is still (or now orphan-)loaded.
    bootoutIfLoaded(spec.label);
    rmSync(path, { force: true });
    out(`  ✓ ${spec.label} removed`);
  }
}

/** What is described, what launchd has, and — for the desktop — whether it answers. */
export function runAgentStatus(cfg: Config, profile: string): void {
  const specs = agentsFor(cfg, profile);
  if (!specs.length) return void out(`devbox: no client agents configured for "${profile}"`);
  for (const spec of specs) {
    const loaded = process.platform === "darwin" && isLoaded(spec.label);
    out(`  ${loaded ? "●" : "○"} ${spec.label} — ${spec.description}`);
    const forward = spec.argv[spec.argv.indexOf("-L") + 1];
    if (spec.mode === "daemon" && forward) {
      const port = forward.split(":")[1]!;
      const answering = spawnSync("nc", ["-z", "-G", "1", "127.0.0.1", port]).status === 0;
      out(`      127.0.0.1:${port} ${answering ? "answers" : "does NOT answer"}`);
    }
  }
}
