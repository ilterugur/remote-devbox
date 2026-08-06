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
import { die, hostFor, lazyMountsFor, resolveCfgDir, shQuote, type Config } from "./config";

export type AgentMode = "daemon" | "interval";
export type BrowserMode = "client" | "server";
export type BrowserPortTarget = { project?: string; all?: boolean; port?: number };

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
const LEGACY_BROWSER_AGENT_LABELS = ["com.devbox.agent-chrome", "com.devbox.cdp-tunnel"] as const;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CURL = "/usr/bin/curl";
const SSH = "/usr/bin/ssh";
const BROWSER_READY_TIMEOUT_SECONDS = 15;

export const browserModePath = (profile: string, home: string = homedir()): string =>
  join(resolveCfgDir(home), `browser-mode-${profile}`);

/** Missing/invalid state retains the pre-switch behavior: client Chrome is primary. */
export function readBrowserMode(profile: string, home: string = homedir()): BrowserMode {
  try {
    return readFileSync(browserModePath(profile, home), "utf8").trim() === "server" ? "server" : "client";
  } catch {
    return "client";
  }
}

export function writeBrowserMode(profile: string, mode: BrowserMode, home: string = homedir()): void {
  const dir = resolveCfgDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(browserModePath(profile, home), mode + "\n");
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function browserProfile(cfg: Config, profile: string) {
  const selected = cfg.profiles.find((item) => item.user === profile);
  if (!selected?.browserFailover)
    die(`browser failover is not configured for "${profile}"`);
  return selected;
}

export const browserPortLabel = (profile: string, port: number): string =>
  `com.devbox.${profile}.browser-port-${port}`;

/** One loopback-only forward per port keeps collision handling inside SSH's checked bind. */
export function browserPortAgent(profile: string, port: number, host: string): AgentSpec {
  if (!validPort(port)) throw new Error("browser port must be an integer in 1..65535");
  return {
    label: browserPortLabel(profile, port),
    mode: "daemon",
    description: `Devbox port: 127.0.0.1:${port} -> ${host}:127.0.0.1:${port}`,
    argv: [
      "ssh", "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-L", `127.0.0.1:${port}:127.0.0.1:${port}`,
      host,
    ],
  };
}

/** Resolve exactly one binding target and collapse duplicated declarations to one port. */
export function browserPortsFor(cfg: Config, profile: string, target: BrowserPortTarget): number[] {
  const selected = browserProfile(cfg, profile);
  const chosen = Number(!!target.project) + Number(target.all === true) + Number(target.port !== undefined);
  if (chosen !== 1) die("choose exactly one browser bind target: <project>, --all, or --port <port>");
  if (target.port !== undefined) {
    if (!validPort(target.port)) die("browser port must be an integer in 1..65535");
    return [target.port];
  }
  const projects = target.all
    ? selected.projects
    : selected.projects.filter((project) => project.name === target.project);
  if (!projects.length) die(`no project named "${target.project}" is configured for "${profile}"`);
  const ports = projects.flatMap((project) => project.ports ?? []).filter(validPort);
  if (!ports.length) {
    const noun = target.all ? "configured projects" : `project "${target.project}"`;
    die(`${noun} has no declared ports to bind`);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** Autobind is opt-in; an empty project-port set is a harmless no-op on mode change. */
export function browserAutoBindPorts(cfg: Config, profile: string): number[] {
  const selected = browserProfile(cfg, profile);
  if (selected.browserFailover?.autoBind !== true) return [];
  return [...new Set(selected.projects.flatMap((project) => project.ports ?? []).filter(validPort))]
    .sort((a, b) => a - b);
}

export function browserModeHint(cfg: Config, profile: string): string | null {
  const selected = browserProfile(cfg, profile);
  if (selected.browserFailover?.autoBind === true) return null;
  return `bind Devbox project ports when needed: devbox browser bind --all -p ${profile}`;
}

/**
 * The original browser failover agents were global and could retain a reverse tunnel
 * owned by a different local account. Reconcile them only for the profile that is
 * explicitly configured to own browser failover.
 */
export function legacyBrowserAgentLabelsFor(cfg: Config, profile: string): string[] {
  return cfg.profiles.find((p) => p.user === profile)?.browserFailover
    ? [...LEGACY_BROWSER_AGENT_LABELS]
    : [];
}

/**
 * Chrome selects an unused local CDP port itself and writes it into DevToolsActivePort.
 * Keep the reverse tunnel in this same supervisor: otherwise a surviving SSH process
 * could forward some unrelated Chrome that happened to bind the old fixed port. The
 * executable/timing options are intentionally narrow test seams; production callers
 * use the absolute system paths and conservative defaults below.
 */
export type BrowserSupervisorOptions = {
  dataDir: string;
  clientTunnelPort: number;
  host: string;
  chromePath?: string;
  curlPath?: string;
  sshPath?: string;
  readyTimeoutSeconds?: number;
  pollIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
};

function absoluteExecutable(path: string, name: string): string {
  if (!path.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  return path;
}

function boundedSeconds(value: number | undefined, fallback: number, name: string): string {
  const seconds = value ?? fallback;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60)
    throw new Error(`${name} must be a number in (0, 60]`);
  return String(seconds);
}

export function renderBrowserSupervisor(opts: BrowserSupervisorOptions): string {
  if (!opts.dataDir.startsWith("/")) throw new Error("browser data directory must be absolute");
  if (!Number.isInteger(opts.clientTunnelPort) || opts.clientTunnelPort < 1 || opts.clientTunnelPort > 65_535)
    throw new Error("browser client tunnel port must be an integer in 1..65535");
  const chromePath = absoluteExecutable(opts.chromePath ?? CHROME, "Chrome path");
  const curlPath = absoluteExecutable(opts.curlPath ?? CURL, "curl path");
  const sshPath = absoluteExecutable(opts.sshPath ?? SSH, "ssh path");
  const readyTimeoutSeconds = boundedSeconds(
    opts.readyTimeoutSeconds,
    BROWSER_READY_TIMEOUT_SECONDS,
    "browser ready timeout",
  );
  const pollIntervalSeconds = boundedSeconds(opts.pollIntervalSeconds, 0.1, "browser marker poll interval");
  const monitorIntervalSeconds = boundedSeconds(opts.monitorIntervalSeconds, 1, "browser monitor interval");

  return `set -eu
umask 077
data_dir=${shQuote(opts.dataDir)}
marker="$data_dir/DevToolsActivePort"
chrome=${shQuote(chromePath)}
curl=${shQuote(curlPath)}
ssh=${shQuote(sshPath)}
ssh_host=${shQuote(opts.host)}
tunnel_port=${shQuote(String(opts.clientTunnelPort))}
chrome_pid=
tunnel_pid=

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$tunnel_pid" ]; then
    kill "$tunnel_pid" 2>/dev/null || true
    wait "$tunnel_pid" 2>/dev/null || true
  fi
  if [ -n "$chrome_pid" ]; then
    kill "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
  fi
}

fail() {
  printf '%s\\n' "$1" >&2
  exit 1
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

mkdir -p "$data_dir"
chmod 700 "$data_dir"
rm -f "$marker"

"$chrome" \\
  "--user-data-dir=$data_dir" \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-debugging-port=0 \\
  --no-first-run \\
  --no-default-browser-check &
chrome_pid=$!

deadline=$(( $(date +%s) + ${readyTimeoutSeconds} ))
cdp_port=
while :; do
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    fail "managed Chrome exited before CDP became ready"
  fi
  if [ -s "$marker" ]; then
    cdp_port=$(sed -n '1p' "$marker")
    case "$cdp_port" in
      ''|*[!0-9]*) fail "invalid DevToolsActivePort" ;;
    esac
    if [ "$cdp_port" -lt 1 ] || [ "$cdp_port" -gt 65535 ]; then
      fail "invalid DevToolsActivePort"
    fi
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "timed out waiting for DevToolsActivePort"
  fi
  sleep ${pollIntervalSeconds}
done

while :; do
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    fail "managed Chrome exited before CDP became ready"
  fi
  if "$curl" --fail --silent --show-error --max-time 1 \\
    "http://127.0.0.1:$cdp_port/json/version" >/dev/null; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "managed Chrome CDP endpoint did not become ready"
  fi
  sleep ${pollIntervalSeconds}
done

"$ssh" -N \\
  -o ExitOnForwardFailure=yes \\
  -o ServerAliveInterval=15 \\
  -o ServerAliveCountMax=3 \\
  -R "127.0.0.1:$tunnel_port:127.0.0.1:$cdp_port" \\
  "$ssh_host" &
tunnel_pid=$!

while :; do
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    fail "managed Chrome exited"
  fi
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    fail "CDP reverse tunnel exited"
  fi
  sleep ${monitorIntervalSeconds}
done
`;
}

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

  if (p.browserFailover) {
    const { clientTunnelPort } = p.browserFailover;
    out.push({
      label: `com.devbox.${profile}.browser`,
      mode: "daemon",
      description: `isolated Chrome with CDP reverse tunnel to ${host}:127.0.0.1:${clientTunnelPort}`,
      argv: [
        "sh",
        "-c",
        renderBrowserSupervisor({
          dataDir: join(homedir(), ".local", "share", "devbox", "browser", profile),
          clientTunnelPort,
          host,
        }),
      ],
    });
  }

  // Only a profile that declares lazy mounts gets the reconciler — there is otherwise
  // nothing to reconcile. `devbox mount up` is idempotent (it skips labels already live),
  // which is what makes re-running it every minute the whole recovery story for a mount
  // that a sleep, a wake or a dropped link took down.
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
    // The name between the prefix and ".plist" must be exactly one segment: an empty one
    // means the file is com.devbox.<profile>.plist — a hand-written agent that merely
    // shares our prefix, and booting it out is the one thing this filter exists to avoid.
    .filter((n) => {
      if (!n.startsWith(prefix) || !n.endsWith(".plist")) return false;
      const name = n.slice(prefix.length, -6);
      // Port forwards have their own explicit lifecycle. `agent up` must not erase a
      // manual `devbox browser bind` simply because autobind is off.
      return ["desktop", "browser", "mount"].includes(name);
    })
    .map((n) => n.slice(0, -6))
    .sort();
}

export function installedBrowserPortAgentLabels(profile: string, home: string = homedir()): string[] {
  const prefix = `com.devbox.${profile}.browser-port-`;
  let names: string[];
  try {
    names = readdirSync(join(home, "Library", "LaunchAgents"));
  } catch {
    return [];
  }
  return names
    .filter((name) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([1-9][0-9]*)\\.plist$`).test(name))
    .map((name) => name.slice(0, -6))
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

/** Install/update a narrow set of owned specs. Callers decide reconciliation scope. */
function installAgents(specs: AgentSpec[]): void {
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
    bootoutIfLoaded(spec.label);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, wanted);
    const result = launchctl("bootstrap", domain(), path);
    if (result.status !== 0) die(`launchctl bootstrap failed for ${spec.label}: ${(result.stderr || "").trim()}`);
    out(`  ✓ ${spec.label} — ${spec.description}`);
  }
}

function browserSupervisor(cfg: Config, profile: string): AgentSpec {
  const spec = agentsFor(cfg, profile).find((candidate) => candidate.label === `com.devbox.${profile}.browser`);
  if (!spec) die(`browser failover is not configured for "${profile}"`);
  return spec;
}

export function runBrowserBind(cfg: Config, profile: string, target: BrowserPortTarget): void {
  requireMac();
  if (readBrowserMode(profile) !== "client")
    die(`browser mode is server — switch first: devbox browser mode client -p ${profile}`);
  const ports = browserPortsFor(cfg, profile, target);
  installAgents(ports.map((port) => browserPortAgent(profile, port, hostFor(cfg, profile))));
}

export function runBrowserUnbind(cfg: Config, profile: string, target: BrowserPortTarget): void {
  requireMac();
  const ports = browserPortsFor(cfg, profile, target);
  for (const port of ports) removeAgent(browserPortLabel(profile, port), "");
}

export function runBrowserMode(cfg: Config, profile: string, mode: BrowserMode): void {
  requireMac();
  browserProfile(cfg, profile);
  writeBrowserMode(profile, mode);
  if (mode === "server") {
    removeAgent(`com.devbox.${profile}.browser`, " (server browser mode)");
    for (const label of installedBrowserPortAgentLabels(profile)) removeAgent(label, " (server browser mode)");
    out(`browser mode -> server — browser localhost now resolves on the Devbox`);
    return;
  }
  for (const label of legacyBrowserAgentLabelsFor(cfg, profile))
    removeAgent(label, " (replaced by profile-scoped browser failover)");
  installAgents([browserSupervisor(cfg, profile)]);
  const ports = browserAutoBindPorts(cfg, profile);
  if (ports.length) installAgents(ports.map((port) => browserPortAgent(profile, port, hostFor(cfg, profile))));
  out(`browser mode -> client — browser localhost now resolves on this machine`);
  const hint = browserModeHint(cfg, profile);
  if (hint) out(`  ${hint}`);
}

/** Install (or update) every agent this profile should have running, and remove the ones
 *  it should not. Idempotent. */
export function runAgentUp(cfg: Config, profile: string): void {
  requireMac();
  // Do this before the new reverse tunnel is bootstrapped: the stale global tunnel may
  // still own the remote port and would make ExitOnForwardFailure reject the new agent.
  for (const label of legacyBrowserAgentLabelsFor(cfg, profile))
    removeAgent(label, " (replaced by profile-scoped browser failover)");

  const mode = readBrowserMode(profile);
  const specs = agentsFor(cfg, profile)
    .filter((spec) => spec.label !== `com.devbox.${profile}.browser` || mode === "client");
  if (mode === "client") {
    for (const port of browserAutoBindPorts(cfg, profile))
      specs.push(browserPortAgent(profile, port, hostFor(cfg, profile)));
  }
  installAgents(specs);

  const wantedLabels = new Set(specs.map((s) => s.label));
  for (const label of installedAgentLabels(profile)) {
    if (!wantedLabels.has(label)) removeAgent(label, " (no longer configured)");
  }
  if (!specs.length) out(`devbox: no client agents configured for "${profile}"`);
}

/** Remove this profile's agents — the described ones and any left over from a config
 *  that has since changed. */
export function agentLabelsForDown(
  cfg: Config,
  profile: string,
  installed: string[] = installedAgentLabels(profile),
): string[] {
  return [...new Set([
    ...agentsFor(cfg, profile).map((spec) => spec.label),
    ...installed,
    ...installedBrowserPortAgentLabels(profile),
    ...legacyBrowserAgentLabelsFor(cfg, profile),
  ])];
}

export function runAgentDown(cfg: Config, profile: string): void {
  requireMac();
  const labels = new Set(agentLabelsForDown(cfg, profile));
  if (!labels.size) return void out(`devbox: no client agents installed for "${profile}"`);
  for (const label of labels) removeAgent(label, "");
}

/** The client-side listener of an SSH `-L` agent, if this spec has one. Browser CDP
 * failover deliberately uses a dynamic reverse forward, so it has no static local port
 * that `agent status` can probe. */
export function localForwardPort(spec: AgentSpec): string | null {
  const index = spec.argv.indexOf("-L");
  const forward = index >= 0 ? spec.argv[index + 1] : undefined;
  const match = forward?.match(/^127\.0\.0\.1:([1-9][0-9]*):/);
  return match?.[1] ?? null;
}

/** What is described, what launchd has, and — for the desktop — what the local end of the
 *  tunnel is actually doing. */
export function runAgentStatus(cfg: Config, profile: string): void {
  const mode = readBrowserMode(profile);
  const specs = agentsFor(cfg, profile)
    .filter((spec) => spec.label !== `com.devbox.${profile}.browser` || mode === "client");
  if (mode === "client") {
    for (const port of browserAutoBindPorts(cfg, profile))
      specs.push(browserPortAgent(profile, port, hostFor(cfg, profile)));
  }
  const installed = installedAgentLabels(profile);
  const browserPorts = installedBrowserPortAgentLabels(profile);
  if (!specs.length && !installed.length && !browserPorts.length) return void out(`devbox: no client agents configured for "${profile}"`);
  if (cfg.profiles.find((item) => item.user === profile)?.browserFailover) out(`browser mode: ${mode}`);
  for (const spec of specs) {
    const loaded = process.platform === "darwin" && isLoaded(spec.label);
    out(`  ${loaded ? "●" : "○"} ${spec.label} — ${spec.description}`);
    if (spec.warning) out(`      ! ${spec.warning}`);
    const port = localForwardPort(spec);
    if (spec.mode === "daemon" && port) {
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
  for (const label of browserPorts) {
    const loaded = process.platform === "darwin" && isLoaded(label);
    out(`  ${loaded ? "●" : "○"} ${label} — manual browser port binding`);
  }
}

export function runBrowserStatus(cfg: Config, profile: string): void {
  browserProfile(cfg, profile);
  runAgentStatus(cfg, profile);
}
