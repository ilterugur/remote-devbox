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
import type { HealthResult } from "./health";

export type AgentMode = "daemon" | "interval";
export type BrowserMode = "client" | "server";
export type BrowserPortTarget = { project?: string; all?: boolean; port?: number };

export type AgentSpec = {
  label: string;
  mode: AgentMode;
  argv: string[];
  intervalSeconds?: number;
  description: string;
  /** A supervisor-created proof that its SSH local forward survived startup. */
  readyFile?: string;
  /** The loopback listener the agent itself owns, when it is a local forward. */
  forwardPort?: number;
  /** Named at description time, not at connect time: something about this agent cannot
   *  work as configured, and the plist itself is not where that shows up. */
  warning?: string;
};

export interface OwnedAgentRecoveryState {
  healthStatus: "healthy" | "degraded" | "recovering" | "blocked" | "failed" | "unknown";
  reason?: string;
  installedPlist: string | null;
  desiredPlist: string;
  loaded: boolean;
  foreignListener: boolean;
}

export interface OwnedAgentRecoveryActions {
  writePlist: (label: string, contents: string) => void;
  bootout: (label: string) => void;
  bootstrap: (label: string) => void;
}

export type OwnedAgentRecoveryResult = {
  status: "recovered" | "skipped" | "blocked" | "failed";
  reason: string;
};

/**
 * Reconcile one already-resolved AgentSpec. The caller supplies evidence gathered just
 * before this call and actions that are scoped to the exact label. A different plist or
 * a foreign listener is an ownership boundary, never permission to replace or kill it.
 */
export function recoverOwnedAgent(
  spec: AgentSpec,
  state: OwnedAgentRecoveryState,
  actions: OwnedAgentRecoveryActions,
): OwnedAgentRecoveryResult {
  if (state.healthStatus === "healthy") return { status: "skipped", reason: "already_healthy" };
  if (state.healthStatus === "recovering") return { status: "skipped", reason: "recovery_in_progress" };
  if (state.healthStatus === "unknown") return { status: "blocked", reason: "evidence_unknown" };
  if (state.healthStatus === "blocked") return { status: "blocked", reason: "component_blocked" };
  if (state.installedPlist !== null && state.installedPlist !== state.desiredPlist) {
    return { status: "blocked", reason: "config_drift" };
  }
  if (state.foreignListener) return { status: "blocked", reason: "foreign_listener" };

  try {
    if (state.installedPlist === null) {
      actions.writePlist(spec.label, state.desiredPlist);
      actions.bootstrap(spec.label);
      return { status: "recovered", reason: "agent_bootstrapped" };
    }
    if (!state.loaded) {
      actions.bootstrap(spec.label);
      return { status: "recovered", reason: "agent_bootstrapped" };
    }
    actions.bootout(spec.label);
    actions.bootstrap(spec.label);
    return { status: "recovered", reason: "agent_restarted" };
  } catch {
    return { status: "failed", reason: "agent_action_failed" };
  }
}

/** Live adapter for the pure ownership decision above. It touches one exact plist label. */
export function recoverOwnedAgentLive(spec: AgentSpec, health: HealthResult): OwnedAgentRecoveryResult {
  try {
    const resolved = { ...spec, argv: resolveArgv(spec.argv) };
    const desiredPlist = renderPlist(resolved, logDirFor());
    const path = plistPath(spec.label);
    const installedPlist = existsSync(path) ? readFileSync(path, "utf8") : null;
    const loaded = isLoaded(spec.label);
    const port = localForwardPort(spec);
    const foreignListener = !!port && health.status !== "healthy"
      && spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).status === 0;

    return recoverOwnedAgent(spec, {
      healthStatus: health.status,
      reason: health.reason,
      installedPlist,
      desiredPlist,
      loaded,
      foreignListener,
    }, {
      writePlist: (_label, contents) => {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        writeFileSync(path, contents);
      },
      bootout: (label) => {
        bootoutIfLoaded(label);
        if (spec.readyFile) rmSync(spec.readyFile, { force: true });
      },
      bootstrap: () => {
        if (spec.readyFile) rmSync(spec.readyFile, { force: true });
        bootstrapAgent(spec.label, path);
      },
    });
  } catch {
    return { status: "failed", reason: "agent_action_failed" };
  }
}

/** The box always listens here; only the client side of the forward is configurable. */
const BOX_RDP_PORT = 3389;
const LEGACY_BROWSER_AGENT_LABELS = ["com.devbox.agent-chrome", "com.devbox.cdp-tunnel"] as const;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CURL = "/usr/bin/curl";
const SSH = "/usr/bin/ssh";
const BROWSER_READY_TIMEOUT_SECONDS = 15;
// How long the supervisor waits, at most, between attempts to rebuild the reverse tunnel.
// Also doubles as "the tunnel has held long enough to call it up again" — see the retry
// loop below.
const BROWSER_TUNNEL_RETRY_MAX_SECONDS = 30;
// How long the supervisor lets the profile change hands before it calls the browser dead.
// Chrome's stale-lock recovery re-execs itself, so between the process this script forked
// exiting and the re-execed one taking the lock, nothing owns the profile.
const BROWSER_ADOPTION_GRACE_SECONDS = 2;
const PORT_FORWARD_READY_ATTEMPTS = 30;
// launchd does not finish tearing a service down synchronously with `bootout`, and it
// answers a `bootstrap` that lands in that window with EIO — its way of saying the label
// is still registered. Both waits have the same shape: poll in tenths of a second,
// bounded, because the state they wait on always resolves or never does.
const LAUNCHD_UNLOAD_ATTEMPTS = 30;
const LAUNCHD_BOOTSTRAP_ATTEMPTS = 10;
const LAUNCHD_STILL_REGISTERED = 5;

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
export const browserAutoBindPortLabel = (profile: string, port: number): string =>
  `com.devbox.${profile}.browser-autobind-port-${port}`;

/** One loopback-only forward per port keeps collision handling inside SSH's checked bind. */
function browserPortAgentWithLabel(profile: string, port: number, host: string, label: string, source: string): AgentSpec {
  if (!validPort(port)) throw new Error("browser port must be an integer in 1..65535");
  const readyFile = join(logDirFor(), `${label}.ready`);
  return {
    label,
    mode: "daemon",
    description: `${source} Devbox port: 127.0.0.1:${port} -> ${host}:127.0.0.1:${port}`,
    readyFile,
    forwardPort: port,
    argv: ["sh", "-c", renderPortForwardSupervisor({ readyFile, port, host })],
  };
}

type PortForwardSupervisorOptions = { readyFile: string; port: number; host: string; sshPath?: string; lsofPath?: string };

/**
 * A foreign process can win a check-then-bind race.  This supervisor writes its marker
 * only after *its own* ExitOnForwardFailure SSH child remains alive, then removes it on
 * every exit path.  The parent CLI never uses a generic TCP listener as readiness proof.
 */
export function renderPortForwardSupervisor(opts: PortForwardSupervisorOptions): string {
  if (!opts.readyFile.startsWith("/")) throw new Error("browser port ready file must be absolute");
  if (!validPort(opts.port)) throw new Error("browser port must be an integer in 1..65535");
  const sshPath = absoluteExecutable(opts.sshPath ?? SSH, "SSH path");
  const lsofPath = absoluteExecutable(opts.lsofPath ?? "/usr/sbin/lsof", "lsof path");
  return `set -eu
ready_file=${shQuote(opts.readyFile)}
ssh=${shQuote(sshPath)}
lsof=${shQuote(lsofPath)}
ssh_host=${shQuote(opts.host)}
rm -f "$ready_file"
ssh_pid=
cleanup() {
  trap - EXIT HUP INT TERM
  rm -f "$ready_file"
  if [ -n "$ssh_pid" ]; then
    kill "$ssh_pid" 2>/dev/null || true
    wait "$ssh_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
"$ssh" -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L ${shQuote(`127.0.0.1:${opts.port}:127.0.0.1:${opts.port}`)} "$ssh_host" &
ssh_pid=$!
for _ in $(seq 1 ${PORT_FORWARD_READY_ATTEMPTS}); do
  sleep 0.1
  kill -0 "$ssh_pid" 2>/dev/null || exit 1
  if "$lsof" -nP -a -p "$ssh_pid" -iTCP:${opts.port} -sTCP:LISTEN >/dev/null 2>&1; then
    printf "%s\\n" "$ssh_pid" > "$ready_file"
    wait "$ssh_pid"
    exit $?
  fi
done
exit 1
`;
}

export function browserPortAgent(profile: string, port: number, host: string): AgentSpec {
  return browserPortAgentWithLabel(profile, port, host, browserPortLabel(profile, port), "manual");
}

export function browserAutoBindAgent(profile: string, port: number, host: string): AgentSpec {
  return browserPortAgentWithLabel(profile, port, host, browserAutoBindPortLabel(profile, port), "autobind");
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

/** Everything server mode must stop to let HAProxy fall back to Devbox Chrome. */
export function browserModeServerAgentLabelsFor(cfg: Config, profile: string, installedPorts: string[]): string[] {
  browserProfile(cfg, profile);
  return [
    `com.devbox.${profile}.browser`,
    ...legacyBrowserAgentLabelsFor(cfg, profile),
    ...installedPorts,
  ];
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
  tunnelRetryMaxSeconds?: number;
  adoptionGraceSeconds?: number;
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

function boundedIntegerSeconds(value: number | undefined, fallback: number, name: string): string {
  const seconds = value ?? fallback;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)
    throw new Error(`${name} must be an integer number of seconds in [1, 60]`);
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
  const tunnelRetryMaxSeconds = boundedIntegerSeconds(
    opts.tunnelRetryMaxSeconds,
    BROWSER_TUNNEL_RETRY_MAX_SECONDS,
    "browser tunnel retry ceiling",
  );
  const adoptionGraceSeconds = boundedIntegerSeconds(
    opts.adoptionGraceSeconds,
    BROWSER_ADOPTION_GRACE_SECONDS,
    "browser adoption grace",
  );

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

# The pid this script forks is not always the browser that ends up owning the profile:
# Chrome's stale-lock recovery re-execs itself and the process it forked exits. So ask the
# profile who holds it rather than trusting $!.
profile_owner_pid() {
  owner=$(readlink "$data_dir/SingletonLock" 2>/dev/null || true)
  owner_pid=\${owner##*-}
  case "$owner_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$owner_pid" -gt 1 ] || return 1
  kill -0 "$owner_pid" 2>/dev/null || return 1
  # A recycled pid is not the browser that took this profile.
  ps -p "$owner_pid" -o command= 2>/dev/null | grep -qF -e "--user-data-dir=$data_dir" || return 1
  printf '%s\\n' "$owner_pid"
}

# A previous supervisor can leave this profile owned by a Chrome that outlived it. Take the
# profile back before launching, because a Chrome that finds it held opens no window of its
# own: it hands one to the holder and exits, this script fails on a browser that never
# became ready, and launchd puts it straight back for another round. That is a browser that
# opens a window every ThrottleInterval, forever, over a lock only a human ever cleared.
claim_profile() {
  held=$(profile_owner_pid) || held=
  if [ -n "$held" ]; then
    printf '%s\\n' "profile still held by pid $held — ending it before taking over" >&2
    kill "$held" 2>/dev/null || true
    claim_deadline=$(( $(date +%s) + ${adoptionGraceSeconds} ))
    while kill -0 "$held" 2>/dev/null; do
      if [ "$(date +%s)" -ge "$claim_deadline" ]; then
        kill -9 "$held" 2>/dev/null || true
        break
      fi
      sleep ${pollIntervalSeconds}
    done
  fi
  rm -f "$data_dir/SingletonLock" "$data_dir/SingletonCookie" "$data_dir/SingletonSocket"
}

# Grace, not a verdict: the re-execed Chrome needs a moment to take the lock, and by then
# the pid this script forked is already gone. Adopting it keeps the supervisor and the
# browser on the same lifetime, which is also what lets cleanup reap the right process.
browser_alive() {
  if kill -0 "$chrome_pid" 2>/dev/null; then
    return 0
  fi
  adopt_deadline=$(( $(date +%s) + ${adoptionGraceSeconds} ))
  while :; do
    adopted=$(profile_owner_pid) || adopted=
    if [ -n "$adopted" ] && [ "$adopted" != "$chrome_pid" ]; then
      printf '%s\\n' "managed Chrome re-execed — adopting pid $adopted" >&2
      chrome_pid=$adopted
      return 0
    fi
    if [ "$(date +%s)" -ge "$adopt_deadline" ]; then
      return 1
    fi
    sleep ${pollIntervalSeconds}
  done
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

mkdir -p "$data_dir"
chmod 700 "$data_dir"
claim_profile
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
  if ! browser_alive; then
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
  if ! browser_alive; then
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

start_tunnel() {
  "$ssh" -N \\
    -o ExitOnForwardFailure=yes \\
    -o ServerAliveInterval=15 \\
    -o ServerAliveCountMax=3 \\
    -R "127.0.0.1:$tunnel_port:127.0.0.1:$cdp_port" \\
    "$ssh_host" &
  tunnel_pid=$!
  tunnel_started=$(date +%s)
}

# The tunnel and the browser have independent lifetimes on purpose. A reverse forward can
# fail for reasons this machine cannot fix and did not cause — most often a previous
# session of this very agent whose client vanished (sleep, a new IP) and whose sshd on the
# box still owns $tunnel_port. Ending the supervisor there would take Chrome down with it
# and launchd would relaunch the pair every ThrottleInterval: a browser that opens and
# closes forever, over remote state that only time fixes. So keep Chrome, retry the tunnel
# with a backoff, and let Chrome's own death be the only thing that ends this script.
# Meanwhile the box's CDP pool health-checks $tunnel_port and serves its local browser.
tunnel_backoff=1
tunnel_started=0
tunnel_reported_down=0
start_tunnel

while :; do
  if ! browser_alive; then
    fail "managed Chrome exited"
  fi
  if kill -0 "$tunnel_pid" 2>/dev/null; then
    # Held for a full retry ceiling: this one is up, not merely young.
    if [ "$(( $(date +%s) - tunnel_started ))" -ge ${tunnelRetryMaxSeconds} ]; then
      if [ "$tunnel_reported_down" -eq 1 ]; then
        printf '%s\\n' "CDP reverse tunnel re-established" >&2
        tunnel_reported_down=0
      fi
      tunnel_backoff=1
    fi
    sleep ${monitorIntervalSeconds}
    continue
  fi
  wait "$tunnel_pid" 2>/dev/null || true
  # One line per outage, not per attempt: an offline laptop retries all night.
  if [ "$tunnel_reported_down" -eq 0 ]; then
    printf '%s\\n' "CDP reverse tunnel down — Chrome stays up, retrying" >&2
    tunnel_reported_down=1
  fi
  sleep "$tunnel_backoff"
  tunnel_backoff=$(( tunnel_backoff * 2 ))
  if [ "$tunnel_backoff" -gt ${tunnelRetryMaxSeconds} ]; then
    tunnel_backoff=${tunnelRetryMaxSeconds}
  fi
  start_tunnel
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
      argv: ["devbox", "mount", "up", "-p", profile],
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
  // `bootout` returning is launchd accepting the request, not finishing it. Callers treat
  // this function as "the label is gone now" and bootstrap a replacement immediately, so
  // wait for that to be true rather than handing them a domain that still owns the label.
  for (let attempt = 0; attempt < LAUNCHD_UNLOAD_ATTEMPTS; attempt++) {
    if (!isLoaded(label)) return;
    spawnSync("/bin/sleep", ["0.1"]);
  }
  die(`${label} is still loaded after a successful bootout; launchd did not release it`);
}

/**
 * Bootstrap `path` into this user's launchd domain, tolerating the one failure that is not
 * one: launchd answers EIO while it is still tearing the label's previous service down,
 * and the identical call a moment later is accepted. Every other failure — a malformed
 * plist, a path launchd cannot read — says the same thing on every attempt, so it is
 * reported at once rather than waited out. Throws rather than dying: one caller reports
 * the failure and stops, the other folds it into a recovery result.
 */
export function bootstrapAgent(label: string, path: string): void {
  let result = launchctl("bootstrap", domain(), path);
  for (
    let attempt = 1;
    attempt < LAUNCHD_BOOTSTRAP_ATTEMPTS && result.status === LAUNCHD_STILL_REGISTERED;
    attempt++
  ) {
    spawnSync("/bin/sleep", ["0.1"]);
    result = launchctl("bootstrap", domain(), path);
  }
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed for ${label}: ${(result.stderr || "").trim()}`);
  }
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

function installedBrowserPortLabelsWithPrefix(profile: string, prefix: string, home: string): string[] {
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

export function installedBrowserPortAgentLabels(profile: string, home: string = homedir()): string[] {
  return installedBrowserPortLabelsWithPrefix(profile, `com.devbox.${profile}.browser-port-`, home);
}

export function installedBrowserAutoBindPortAgentLabels(profile: string, home: string = homedir()): string[] {
  return installedBrowserPortLabelsWithPrefix(profile, `com.devbox.${profile}.browser-autobind-port-`, home);
}

export function installedAnyBrowserPortAgentLabels(profile: string, home: string = homedir()): string[] {
  return [...new Set([
    ...installedBrowserPortAgentLabels(profile, home),
    ...installedBrowserAutoBindPortAgentLabels(profile, home),
  ])].sort();
}

/** Unload and delete one agent. Aborts (via bootoutIfLoaded) rather than deleting a
 *  plist out from under a label launchd still has loaded. */
function removeAgent(label: string, why: string): void {
  const path = plistPath(label);
  if (isDry()) return void out(`  ── would remove ${path}${why}`);
  bootoutIfLoaded(label);
  rmSync(path, { force: true });
  rmSync(join(logDirFor(), `${label}.ready`), { force: true });
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
    if (current === wanted && isLoaded(spec.label) && (!spec.readyFile || existsSync(spec.readyFile))) {
      out(`  ✓ ${spec.label} already current`);
      continue;
    }
    bootoutIfLoaded(spec.label);
    if (spec.readyFile) rmSync(spec.readyFile, { force: true });
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, wanted);
    try {
      bootstrapAgent(spec.label, path);
    } catch (e) {
      die((e as Error).message);
    }
    if (spec.readyFile) {
      let ready = false;
      for (let attempt = 0; attempt < PORT_FORWARD_READY_ATTEMPTS; attempt++) {
        if (existsSync(spec.readyFile)) {
          ready = true;
          break;
        }
        spawnSync("/bin/sleep", ["0.1"]);
      }
      if (!ready) {
        bootoutIfLoaded(spec.label);
        rmSync(path, { force: true });
        rmSync(spec.readyFile, { force: true });
        die(`${spec.label} did not prove its SSH local forward was ready; binding was not kept`);
      }
    }
    out(`  ✓ ${spec.label} — ${spec.description}`);
  }
}

/** Reconcile only the dedicated autobind namespace; manual binds must survive it. */
function reconcileAutoBindPorts(cfg: Config, profile: string): void {
  const specs = browserAutoBindPorts(cfg, profile)
    .map((port) => browserAutoBindAgent(profile, port, hostFor(cfg, profile)));
  const wanted = new Set(specs.map((spec) => spec.label));
  for (const label of installedBrowserAutoBindPortAgentLabels(profile)) {
    if (!wanted.has(label)) removeAgent(label, " (no longer configured for autobind)");
  }
  installAgents(specs);
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
  if (isDry()) out(`  ── would set browser mode for ${profile} -> ${mode}`);
  if (mode === "server") {
    for (const label of browserModeServerAgentLabelsFor(cfg, profile, installedAnyBrowserPortAgentLabels(profile)))
      removeAgent(label, " (server browser mode)");
    if (!isDry()) writeBrowserMode(profile, mode);
    out(`browser mode -> server — browser localhost now resolves on the Devbox`);
    return;
  }
  for (const label of legacyBrowserAgentLabelsFor(cfg, profile))
    removeAgent(label, " (replaced by profile-scoped browser failover)");
  installAgents([browserSupervisor(cfg, profile)]);
  reconcileAutoBindPorts(cfg, profile);
  if (!isDry()) writeBrowserMode(profile, mode);
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
  const browserEnabled = cfg.profiles.find((item) => item.user === profile)?.browserFailover !== undefined;
  const specs = agentsFor(cfg, profile)
    .filter((spec) => spec.label !== `com.devbox.${profile}.browser` || mode === "client");
  installAgents(specs);
  if (browserEnabled && mode === "client") reconcileAutoBindPorts(cfg, profile);

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
    ...installedAnyBrowserPortAgentLabels(profile),
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
  if (spec.forwardPort) return String(spec.forwardPort);
  const index = spec.argv.indexOf("-L");
  const forward = index >= 0 ? spec.argv[index + 1] : undefined;
  const match = forward?.match(/^127\.0\.0\.1:([1-9][0-9]*):/);
  return match?.[1] ?? null;
}

/** What is described, what launchd has, and — for the desktop — what the local end of the
 *  tunnel is actually doing. */
export function runAgentStatus(cfg: Config, profile: string): void {
  const mode = readBrowserMode(profile);
  const browserEnabled = cfg.profiles.find((item) => item.user === profile)?.browserFailover !== undefined;
  const specs = agentsFor(cfg, profile)
    .filter((spec) => spec.label !== `com.devbox.${profile}.browser` || mode === "client");
  if (browserEnabled && mode === "client") {
    for (const port of browserAutoBindPorts(cfg, profile))
      specs.push(browserAutoBindAgent(profile, port, hostFor(cfg, profile)));
  }
  const installed = installedAgentLabels(profile);
  const browserPorts = installedAnyBrowserPortAgentLabels(profile);
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
