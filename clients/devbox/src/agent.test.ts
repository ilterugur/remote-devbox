import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentModule from "./agent";
import {
  agentEnv,
  agentsFor,
  browserPortAgent,
  browserPortsFor,
  browserAutoBindPorts,
  browserAutoBindAgent,
  browserModeServerAgentLabelsFor,
  browserModeHint,
  readBrowserMode,
  bootoutIfLoaded,
  installedAgentLabels,
  localForwardPort,
  plistPath,
  renderPlist,
  resolveArgv,
  recoverOwnedAgent,
  type OwnedAgentRecoveryState,
} from "./agent";
import type { Config } from "./config";

const cfg = (profile: Record<string, unknown>): Config => ({
  prefix: "devbox",
  default: "ilterugur",
  locale: "en_US.UTF-8",
  launch: "",
  profiles: [{ user: "ilterugur", projects: [], ...profile } as any],
});

/**
 * A fake `launchctl` on PATH so bootoutIfLoaded's tests can force isLoaded/bootout to
 * whatever result they need, without touching this machine's real launchd state.
 * PATH is the only env this touches — deliberately not HOME: Bun caches os.homedir()
 * at process start, so mutating process.env.HOME here would NOT redirect plistPath()/
 * logDirFor() inside a live test process, and a test that assumed it would could end
 * up writing a real plist into the developer's real ~/Library/LaunchAgents. That's why
 * these tests exercise bootoutIfLoaded directly rather than the full runAgentUp/Down —
 * the fs-touching parts of those are covered structurally (they're direct callers of
 * this same, now-tested, checked helper) and manually via DEVBOX_DRYRUN dry runs.
 */
function withFakeLaunchctl(
  behavior: {
    print?: number;
    bootout?: number;
    bootstrap?: number;
    /** `print` reports the label loaded for this many calls, then gone — launchd letting go late. */
    loadedPrints?: number;
    /** `bootstrap` returns launchd's EIO this many times before it takes the plist. */
    bootstrapEio?: number;
  },
  fn: (calls: (subcommand: string) => number) => void,
): void {
  const bin = mkdtempSync(join(tmpdir(), "devbox-agent-bin-"));
  // Each subcommand counts its own invocations on disk: whether a call was retried is the
  // whole behavior under test, and a stateless fake cannot show it.
  const printCase = behavior.loadedPrints === undefined
    ? `  print) bump print; exit ${behavior.print ?? 0} ;;`
    : `  print)
    n=$(bump print)
    if [ "$n" -le ${behavior.loadedPrints} ]; then exit 0; fi
    exit 1
    ;;`;
  const script = `#!/bin/sh
state='${bin}'
bump() {
  n=$(cat "$state/$1.calls" 2>/dev/null || echo 0)
  n=$((n + 1))
  printf '%s\\n' "$n" > "$state/$1.calls"
  printf '%s\\n' "$n"
}
case "$1" in
${printCase}
  bootout) bump bootout; exit ${behavior.bootout ?? 0} ;;
  bootstrap)
    n=$(bump bootstrap)
    if [ "$n" -le ${behavior.bootstrapEio ?? 0} ]; then
      printf '%s\\n' "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    exit ${behavior.bootstrap ?? 0}
    ;;
  *) exit 0 ;;
esac
`;
  const path = join(bin, "launchctl");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  const calls = (subcommand: string): number => {
    const file = join(bin, `${subcommand}.calls`);
    return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : 0;
  };

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    fn(calls);
  } finally {
    process.env.PATH = originalPath;
  }
}

type RenderBrowserSupervisor = (opts: {
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
}) => string;

type SupervisorFixture = {
  chromePath: string;
  curlPath: string;
  sshPath: string;
  dataDir: string;
  events: string;
  state: string;
  markerPort: string;
  chromePid: string;
  sshPid: string;
  curlCalls: string;
  curlFailures: string;
  sshCalls: string;
  sshFailures: string;
  chromeReexec: string;
};

const SUPERVISOR_READY_TIMEOUT_SECONDS = 3;
const BEHAVIORAL_FIXTURE_BUDGET_MS = 5_000;

function fakeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\n${source}`);
  chmodSync(path, 0o755);
}

function supervisorFixture(
  markerPort: string,
  curlFailures = 0,
  sshFailures = 0,
  chromeReexec = false,
): SupervisorFixture {
  const root = mkdtempSync(join(tmpdir(), "devbox-browser-supervisor-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const events = join(root, "events");
  mkdirSync(bin);
  mkdirSync(state);

  const chromePath = join(bin, "chrome");
  const curlPath = join(bin, "curl");
  const sshPath = join(bin, "ssh");
  const curlCalls = join(state, "curl.calls");
  fakeExecutable(chromePath, [
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --user-data-dir=*) data_dir=${arg#--user-data-dir=} ;;',
    '  esac',
    'done',
    'mkdir -p "$data_dir"',
    '# Chrome\'s stale-lock recovery: the profile ends up owned by a process the caller',
    '# never forked, and the one it did fork exits before any marker is written.',
    'if [ "${CHROME_REEXEC:-0}" = "1" ]; then',
    '  CHROME_REEXEC=0 "$0" "$@" &',
    '  exit 0',
    'fi',
    'ln -sfn "$(hostname)-$$" "$data_dir/SingletonLock"',
    'printf "%s\\n/devtools/browser/fake\\n" "$MARKER_PORT" > "$data_dir/DevToolsActivePort"',
    'printf "%s\\n" "$$" > "$STATE/chrome.pid"',
    'printf "%s\\n" "chrome $*" >> "$EVENTS"',
    'trap \'printf "%s\\n" chrome-term >> "$EVENTS"; exit 0\' TERM INT HUP',
    'while :; do sleep 0.01; done',
  ].join("\n"));
  fakeExecutable(curlPath, [
    'printf "%s\\n" "curl $*" >> "$EVENTS"',
    'calls=$(cat "$STATE/curl.calls" 2>/dev/null || echo 0)',
    'calls=$((calls + 1))',
    'printf "%s\\n" "$calls" > "$STATE/curl.calls"',
    'if [ "$calls" -le "$CURL_FAILURES" ]; then exit 1; fi',
    'exit 0',
  ].join("\n"));
  fakeExecutable(sshPath, [
    'printf "%s\\n" "ssh $*" >> "$EVENTS"',
    'calls=$(cat "$STATE/ssh.calls" 2>/dev/null || echo 0)',
    'calls=$((calls + 1))',
    'printf "%s\\n" "$calls" > "$STATE/ssh.calls"',
    'if [ "$calls" -le "$SSH_FAILURES" ]; then',
    '  printf "%s\\n" "Error: remote port forwarding failed for listen port" >&2',
    '  exit 255',
    'fi',
    'printf "%s\\n" "$$" > "$STATE/ssh.pid"',
    'trap \'printf "%s\\n" ssh-term >> "$EVENTS"; exit 0\' TERM INT HUP',
    'while :; do sleep 0.01; done',
  ].join("\n"));

  return {
    chromePath,
    curlPath,
    sshPath,
    dataDir: join(root, "browser-profile"),
    events,
    state,
    markerPort,
    chromePid: join(state, "chrome.pid"),
    sshPid: join(state, "ssh.pid"),
    curlCalls,
    curlFailures: String(curlFailures),
    sshCalls: join(state, "ssh.calls"),
    sshFailures: String(sshFailures),
    chromeReexec: chromeReexec ? "1" : "0",
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

async function waitForExit(process: ReturnType<typeof Bun.spawn>, timeoutMs = 1_500): Promise<number> {
  return await Promise.race([
    process.exited,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error("supervisor did not exit")), timeoutMs)),
  ]);
}

/** Chrome's SingletonLock points at "host-pid", so it is a symlink to nothing on disk. */
function profileHeld(dataDir: string): boolean {
  try {
    return lstatSync(join(dataDir, "SingletonLock")).isSymbolicLink();
  } catch {
    return false;
  }
}

function alive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), 0);
    return true;
  } catch {
    return false;
  }
}

function startSupervisor(script: string, fixture: SupervisorFixture) {
  return Bun.spawn(["/bin/sh", "-c", script], {
    env: {
      ...process.env,
      EVENTS: fixture.events,
      MARKER_PORT: fixture.markerPort,
      STATE: fixture.state,
      CURL_FAILURES: fixture.curlFailures,
      SSH_FAILURES: fixture.sshFailures,
      CHROME_REEXEC: fixture.chromeReexec,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function stopSupervisor(supervisor: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    process.kill(supervisor.pid, "SIGTERM");
  } catch {
    // It may already have exited on the test's expected failure path.
  }
  try {
    await waitForExit(supervisor, BEHAVIORAL_FIXTURE_BUDGET_MS);
  } catch {
    // Preserve the original assertion failure; the fixture still gets its termination signal.
  }
}

describe("agentsFor", () => {
  test("a desktop profile gets a keep-alive ssh tunnel on its own port", () => {
    const [a, ...rest] = agentsFor(cfg({ desktop: { clientPort: 3390 } }), "ilterugur");
    expect(rest).toEqual([]);
    expect(a!.label).toBe("com.devbox.ilterugur.desktop");
    expect(a!.mode).toBe("daemon");
    expect(a!.argv).toEqual([
      "ssh", "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-L", "127.0.0.1:3390:127.0.0.1:3389",
      "devbox-ilterugur",
    ]);
  });

  test("desktop access without 'tunnel' is named as a warning, not left to connect time", () => {
    const [a] = agentsFor(cfg({ desktop: { clientPort: 3390, access: ["tailnet"] } }), "ilterugur");
    expect(a!.warning).toContain("tunnel");
    expect(a!.warning).toContain("3389");
  });

  test("an access list containing 'tunnel' carries no warning", () => {
    const [a] = agentsFor(cfg({ desktop: { clientPort: 3390, access: ["tunnel", "tailnet"] } }), "ilterugur");
    expect(a!.warning).toBeUndefined();
  });

  test("an unknown access list (an older box's client.json) is not treated as a refusal", () => {
    const [a] = agentsFor(cfg({ desktop: { clientPort: 3390 } }), "ilterugur");
    expect(a!.warning).toBeUndefined();
  });

  test("no desktop, no tunnel", () => {
    expect(agentsFor(cfg({}), "ilterugur")).toEqual([]);
  });

  test("a box that runs the monitor gets exactly one dashboard forward, on the default profile", () => {
    const base = cfg({});
    const withMonitor: Config = {
      ...base,
      monitoring: { port: 19999, access: ["tunnel"] },
      profiles: [...base.profiles, { user: "other", projects: [] }],
    };
    const [a, ...rest] = agentsFor(withMonitor, "ilterugur");
    expect(rest).toEqual([]);
    expect(a!.label).toBe("com.devbox.ilterugur.monitoring");
    expect(a!.mode).toBe("daemon");
    expect(a!.forwardPort).toBe(19999);
    expect(a!.description).toContain("http://localhost:19999");
    expect(a!.warning).toBeUndefined();
    // One agent for the whole box: a second profile binding the same local port would
    // leave a launchd agent failing forever.
    expect(agentsFor(withMonitor, "other")).toEqual([]);
  });

  test("monitoring access without 'tunnel' is named as a warning, not left to connect time", () => {
    const base = cfg({});
    const [a] = agentsFor({ ...base, monitoring: { port: 19999, access: ["tailnet"] } }, "ilterugur");
    expect(a!.warning).toContain("tunnel");
    expect(a!.warning).toContain("19999");
  });

  test("a box without the monitor publishes no forward for it", () => {
    expect(agentsFor(cfg({}), "ilterugur")).toEqual([]);
  });

  test("a browser-failover profile gets one ownership-coupled Chrome supervisor", () => {
    const agents = agentsFor(
      cfg({ browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 } }),
      "ilterugur",
    );

    expect(agents).toHaveLength(1);
    const browser = agents[0]!;
    expect(browser.label).toBe("com.devbox.ilterugur.browser");
    expect(browser.mode).toBe("daemon");
    expect(browser.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = browser.argv[2]!;
    expect(script).toContain("--remote-debugging-address=127.0.0.1");
    expect(script).toContain("--remote-debugging-port=0");
    expect(script).not.toContain("9222");
    expect(script).toContain('"--user-data-dir=$data_dir"');
    expect(script).toContain("DevToolsActivePort");
    expect(script.indexOf('rm -f "$marker"')).toBeLessThan(script.indexOf('"$chrome"'));
    expect(script).toContain("/json/version");
    expect(script).toContain('-R "127.0.0.1:$tunnel_port:127.0.0.1:$cdp_port"');
    expect(script).toContain("devbox-ilterugur");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain('kill "$tunnel_pid"');
    expect(script).toContain('kill "$chrome_pid"');
    // A tunnel that cannot bind is a remote-state problem, not a reason to kill this
    // machine's Chrome: only Chrome's own death ends the supervisor.
    expect(script).not.toContain('fail "CDP reverse tunnel exited"');
    expect(script).toContain("tunnel_backoff");
    expect(script).toContain('fail "managed Chrome exited"');
  });

  test("a browser port gets an owned loopback SSH forward", () => {
    const agent = browserPortAgent("ilterugur", 5173, "devbox-ilterugur");
    expect(agent.label).toBe("com.devbox.ilterugur.browser-port-5173");
    expect(agent.mode).toBe("daemon");
    expect(agent.readyFile).toContain("com.devbox.ilterugur.browser-port-5173.ready");
    expect(agent.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(agent.argv[2]).toContain("ExitOnForwardFailure=yes");
    expect(agent.argv[2]).toContain("127.0.0.1:5173:127.0.0.1:5173");
    expect(agent.argv[2]).toContain('-p "$ssh_pid" -iTCP:5173 -sTCP:LISTEN');
    expect(agent.argv[2]).toContain('printf "%s\\n" "$ssh_pid" > "$ready_file"');
  });

  test("autobind ports have a separate owned label and server mode includes legacy tunnels", () => {
    const browserCfg = cfg({ browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 } });
    expect(browserAutoBindAgent("ilterugur", 5173, "devbox-ilterugur").label)
      .toBe("com.devbox.ilterugur.browser-autobind-port-5173");
    expect(browserModeServerAgentLabelsFor(browserCfg, "ilterugur", [
      "com.devbox.ilterugur.browser-port-5173",
      "com.devbox.ilterugur.browser-autobind-port-3000",
    ])).toEqual([
      "com.devbox.ilterugur.browser",
      "com.devbox.agent-chrome",
      "com.devbox.cdp-tunnel",
      "com.devbox.ilterugur.browser-port-5173",
      "com.devbox.ilterugur.browser-autobind-port-3000",
    ]);
  });

  test("browser bind targets are deduplicated from configured project ports", () => {
    const browserCfg = cfg({
      browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 },
      projects: [
        { name: "web", ports: [5173, 3000] },
        { name: "api", ports: [3000, 3100] },
      ],
    });
    expect(browserPortsFor(browserCfg, "ilterugur", { project: "web" })).toEqual([3000, 5173]);
    expect(browserPortsFor(browserCfg, "ilterugur", { all: true })).toEqual([3000, 3100, 5173]);
  });

  test("browser mode defaults to client when no state was saved", () => {
    const home = mkdtempSync(join(tmpdir(), "devbox-browser-mode-"));
    expect(readBrowserMode("ilterugur", home)).toBe("client");
  });

  test("client mode offers a bind hint unless autobind is configured", () => {
    const manual = cfg({
      browserFailover: { cdpPort: 9222, clientTunnelPort: 9322, autoBind: false },
      projects: [{ name: "web", ports: [5173] }],
    });
    expect(browserModeHint(manual, "ilterugur")).toContain("devbox browser bind --all -p ilterugur");

    const automatic = cfg({
      browserFailover: { cdpPort: 9222, clientTunnelPort: 9322, autoBind: true },
      projects: [{ name: "web", ports: [5173, 3000] }],
    });
    expect(browserAutoBindPorts(automatic, "ilterugur")).toEqual([3000, 5173]);
  });

  test("reports a local listener only for an SSH local-forward agent", () => {
    const desktop = agentsFor(cfg({ desktop: { clientPort: 3390 } }), "ilterugur")[0]!;
    const browser = agentsFor(
      cfg({ browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 } }),
      "ilterugur",
    )[0]!;

    expect(localForwardPort(desktop)).toBe("3390");
    expect(localForwardPort(browser)).toBeNull();
  });

  test("the behavioral fixture budget outlives the supervisor ready window", () => {
    expect(BEHAVIORAL_FIXTURE_BUDGET_MS).toBeGreaterThan(SUPERVISOR_READY_TIMEOUT_SECONDS * 1_000);
  });

  test("the browser supervisor forwards only its ready dynamic CDP and tears down both children", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    const first = supervisorFixture("49123");
    const firstSupervisor = startSupervisor(renderSupervisor!({
      dataDir: first.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: first.chromePath,
      curlPath: first.curlPath,
      sshPath: first.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
    }), first);
    try {
      await waitFor(() => existsSync(first.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
      const events = readFileSync(first.events, "utf8").trim().split("\n");
      const chrome = events.findIndex((line) => line.startsWith("chrome "));
      const curl = events.findIndex((line) => line.startsWith("curl "));
      const ssh = events.findIndex((line) => line.startsWith("ssh "));
      expect(events[chrome]).toContain("--remote-debugging-port=0");
      expect(events[curl]).toContain("http://127.0.0.1:49123/json/version");
      expect(events[ssh]).toContain("127.0.0.1:9322:127.0.0.1:49123");
      expect(events.join("\n")).not.toContain("9222");
      expect(chrome).toBeLessThan(curl);
      expect(curl).toBeLessThan(ssh);

      process.kill(firstSupervisor.pid, "SIGTERM");
      await waitForExit(firstSupervisor, BEHAVIORAL_FIXTURE_BUDGET_MS);
      await waitFor(() => !alive(first.chromePid) && !alive(first.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
    } finally {
      await stopSupervisor(firstSupervisor);
    }

    const second = supervisorFixture("49124");
    const secondSupervisor = startSupervisor(renderSupervisor!({
      dataDir: second.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: second.chromePath,
      curlPath: second.curlPath,
      sshPath: second.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
    }), second);
    try {
      await waitFor(() => existsSync(second.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
      process.kill(Number(readFileSync(second.chromePid, "utf8").trim()), "SIGTERM");
      await waitForExit(secondSupervisor, BEHAVIORAL_FIXTURE_BUDGET_MS);
      await waitFor(() => !alive(second.chromePid) && !alive(second.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
    } finally {
      await stopSupervisor(secondSupervisor);
    }
  });

  test("an invalid DevToolsActivePort fails before the supervisor launches SSH", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    const fixture = supervisorFixture("not-a-port");
    const supervisor = startSupervisor(renderSupervisor!({
      dataDir: fixture.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: fixture.chromePath,
      curlPath: fixture.curlPath,
      sshPath: fixture.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
    }), fixture);
    try {
      expect(await waitForExit(supervisor, BEHAVIORAL_FIXTURE_BUDGET_MS)).not.toBe(0);
      expect(existsSync(fixture.sshPid)).toBe(false);
      expect(existsSync(fixture.events) ? readFileSync(fixture.events, "utf8") : "").not.toContain("ssh ");
      await waitFor(() => !alive(fixture.chromePid), BEHAVIORAL_FIXTURE_BUDGET_MS);
    } finally {
      await stopSupervisor(supervisor);
    }
  });

  test("retries the CDP readiness probe until the managed Chrome is ready", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    const fixture = supervisorFixture("49125", 1);
    const supervisor = startSupervisor(renderSupervisor!({
      dataDir: fixture.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: fixture.chromePath,
      curlPath: fixture.curlPath,
      sshPath: fixture.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
    }), fixture);
    try {
      await waitFor(() => existsSync(fixture.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
      expect(Number(readFileSync(fixture.curlCalls, "utf8").trim())).toBeGreaterThanOrEqual(2);
    } finally {
      await stopSupervisor(supervisor);
    }
  }, BEHAVIORAL_FIXTURE_BUDGET_MS + 5_000);

  test("a refused reverse forward is retried without taking the managed Chrome down", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    // The box refuses the first two binds — what a stale sshd session owning the remote
    // port looks like from here — then lets the forward through.
    const fixture = supervisorFixture("49126", 0, 2);
    const supervisor = startSupervisor(renderSupervisor!({
      dataDir: fixture.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: fixture.chromePath,
      curlPath: fixture.curlPath,
      sshPath: fixture.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
      tunnelRetryMaxSeconds: 1,
    }), fixture);
    try {
      await waitFor(() => existsSync(fixture.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
      expect(Number(readFileSync(fixture.sshCalls, "utf8").trim())).toBe(3);
      expect(alive(fixture.chromePid)).toBe(true);
      expect(supervisor.exitCode).toBeNull();
      expect(readFileSync(fixture.events, "utf8")).not.toContain("chrome-term");
    } finally {
      await stopSupervisor(supervisor);
    }
  }, BEHAVIORAL_FIXTURE_BUDGET_MS + 5_000);

  test("adopts the Chrome that a stale-lock re-exec left owning the profile", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    // Chrome's own recovery path: the pid this supervisor forked exits and a process it
    // never forked ends up holding the profile. Reading that as a death is what left the
    // orphan behind that every later relaunch then handed a window to.
    const fixture = supervisorFixture("49127", 0, 0, true);
    const supervisor = startSupervisor(renderSupervisor!({
      dataDir: fixture.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: fixture.chromePath,
      curlPath: fixture.curlPath,
      sshPath: fixture.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
      adoptionGraceSeconds: 2,
    }), fixture);
    try {
      await waitFor(() => existsSync(fixture.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
      expect(supervisor.exitCode).toBeNull();
      expect(alive(fixture.chromePid)).toBe(true);
    } finally {
      await stopSupervisor(supervisor);
    }
  }, BEHAVIORAL_FIXTURE_BUDGET_MS + 5_000);

  test("reaps the adopted Chrome on shutdown instead of orphaning it", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    const fixture = supervisorFixture("49128", 0, 0, true);
    const supervisor = startSupervisor(renderSupervisor!({
      dataDir: fixture.dataDir,
      clientTunnelPort: 9322,
      host: "devbox-ilterugur",
      chromePath: fixture.chromePath,
      curlPath: fixture.curlPath,
      sshPath: fixture.sshPath,
      readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
      pollIntervalSeconds: 0.01,
      monitorIntervalSeconds: 0.01,
      adoptionGraceSeconds: 2,
    }), fixture);
    try {
      await waitFor(() => existsSync(fixture.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
      process.kill(supervisor.pid, "SIGTERM");
      await waitForExit(supervisor, BEHAVIORAL_FIXTURE_BUDGET_MS);
      await waitFor(() => !alive(fixture.chromePid), BEHAVIORAL_FIXTURE_BUDGET_MS);
    } finally {
      await stopSupervisor(supervisor);
    }
  }, BEHAVIORAL_FIXTURE_BUDGET_MS + 5_000);

  test("takes a profile a Chrome that outlived its supervisor still holds", async () => {
    const renderSupervisor = agentModule.renderBrowserSupervisor as RenderBrowserSupervisor | undefined;
    expect(renderSupervisor).toBeDefined();

    // A Chrome that finds the profile held opens no window of its own: it hands one to
    // the holder and exits, which reads here as a browser that never became ready.
    const fixture = supervisorFixture("49129");
    mkdirSync(fixture.dataDir, { recursive: true });
    const holderState = join(fixture.state, "holder");
    mkdirSync(holderState);
    const holderPid = join(holderState, "chrome.pid");
    const holder = Bun.spawn([fixture.chromePath, `--user-data-dir=${fixture.dataDir}`], {
      env: {
        ...process.env,
        EVENTS: join(holderState, "events"),
        MARKER_PORT: "49999",
        STATE: holderState,
        CHROME_REEXEC: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitFor(
        () => profileHeld(fixture.dataDir) && alive(holderPid),
        BEHAVIORAL_FIXTURE_BUDGET_MS,
      );
      const supervisor = startSupervisor(renderSupervisor!({
        dataDir: fixture.dataDir,
        clientTunnelPort: 9322,
        host: "devbox-ilterugur",
        chromePath: fixture.chromePath,
        curlPath: fixture.curlPath,
        sshPath: fixture.sshPath,
        readyTimeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
        pollIntervalSeconds: 0.01,
        monitorIntervalSeconds: 0.01,
        adoptionGraceSeconds: 2,
      }), fixture);
      try {
        await waitFor(() => !alive(holderPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
        await waitFor(() => existsSync(fixture.sshPid), BEHAVIORAL_FIXTURE_BUDGET_MS);
        expect(supervisor.exitCode).toBeNull();
      } finally {
        await stopSupervisor(supervisor);
      }
    } finally {
      try {
        process.kill(holder.pid, "SIGKILL");
      } catch {
        // Already reaped by the supervisor, which is the point of the test.
      }
    }
  }, BEHAVIORAL_FIXTURE_BUDGET_MS + 5_000);

  test("another profile gets no browser agents", () => {
    const browserCfg: Config = {
      prefix: "devbox",
      default: "ilterugur",
      locale: "en_US.UTF-8",
      launch: "",
      profiles: [
        { user: "ilterugur", projects: [], browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 } },
        { user: "other", projects: [] },
      ],
    };

    expect(agentsFor(browserCfg, "other")).toEqual([]);
  });

  test("only the configured browser-failover owner reconciles legacy global browser agents", () => {
    const legacyLabelsFor = agentModule.legacyBrowserAgentLabelsFor as
      | ((cfg: Config, profile: string) => string[])
      | undefined;
    const browserCfg: Config = {
      prefix: "devbox",
      default: "ilterugur",
      locale: "en_US.UTF-8",
      launch: "",
      profiles: [
        { user: "ilterugur", projects: [], browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 } },
        { user: "other", projects: [] },
      ],
    };

    expect(legacyLabelsFor).toBeDefined();
    expect(legacyLabelsFor!(browserCfg, "ilterugur")).toEqual([
      "com.devbox.agent-chrome",
      "com.devbox.cdp-tunnel",
    ]);
    expect(legacyLabelsFor!(browserCfg, "other")).toEqual([]);
  });

  test("agent down includes legacy browser labels only for the matching owner", () => {
    const labelsForDown = agentModule.agentLabelsForDown as
      | ((cfg: Config, profile: string, installed?: string[]) => string[])
      | undefined;
    const browserCfg: Config = {
      prefix: "devbox",
      default: "ilterugur",
      locale: "en_US.UTF-8",
      launch: "",
      profiles: [
        { user: "ilterugur", projects: [], browserFailover: { cdpPort: 9222, clientTunnelPort: 9322 } },
        { user: "other", projects: [] },
      ],
    };

    expect(labelsForDown).toBeDefined();
    expect(labelsForDown!(browserCfg, "ilterugur", [])).toEqual([
      "com.devbox.ilterugur.browser",
      "com.devbox.agent-chrome",
      "com.devbox.cdp-tunnel",
    ]);
    expect(labelsForDown!(browserCfg, "other", [])).toEqual([]);
  });

  test("configured lazy mounts get a 60s reconciler", () => {
    const agents = agentsFor(cfg({ lazyMounts: [{ label: "desktop", path: "/Users/me/Desktop" }] }), "ilterugur");
    const mount = agents.find((a) => a.label === "com.devbox.ilterugur.mount")!;
    expect(mount.mode).toBe("interval");
    expect(mount.intervalSeconds).toBe(60);
    expect(mount.argv).toEqual(["devbox", "mount", "up", "-p", "ilterugur"]);
    expect(mount.argv.slice(0, 3)).toEqual(["devbox", "mount", "up"]);
  });
});

describe("recoverOwnedAgent", () => {
  const spec = agentsFor(cfg({ desktop: { clientPort: 3390 } }), "ilterugur")[0]!;
  const desiredPlist = "exact managed plist";
  const base: OwnedAgentRecoveryState = {
    healthStatus: "failed",
    reason: "agent_not_loaded",
    installedPlist: desiredPlist,
    desiredPlist,
    loaded: false,
    foreignListener: false,
  };

  function run(state: Partial<OwnedAgentRecoveryState> = {}) {
    const actions: string[] = [];
    const result = recoverOwnedAgent(spec, { ...base, ...state }, {
      writePlist: (label) => actions.push(`write:${label}`),
      bootout: (label) => actions.push(`bootout:${label}`),
      bootstrap: (label) => actions.push(`bootstrap:${label}`),
    });
    return { result, actions };
  }

  test("writes and bootstraps only the exact missing owned plist", () => {
    const { result, actions } = run({ installedPlist: null });
    expect(result).toEqual({ status: "recovered", reason: "agent_bootstrapped" });
    expect(actions).toEqual([
      "write:com.devbox.ilterugur.desktop",
      "bootstrap:com.devbox.ilterugur.desktop",
    ]);
  });

  test("bootstraps an unloaded exact plist without rewriting it", () => {
    expect(run().actions).toEqual(["bootstrap:com.devbox.ilterugur.desktop"]);
  });

  test("restarts only the exact loaded owned label", () => {
    const { actions } = run({ loaded: true, reason: "agent_not_running" });
    expect(actions).toEqual([
      "bootout:com.devbox.ilterugur.desktop",
      "bootstrap:com.devbox.ilterugur.desktop",
    ]);
  });

  test("blocks config drift and a foreign listener without mutating either", () => {
    expect(run({ installedPlist: "user-edited plist" })).toEqual({
      result: { status: "blocked", reason: "config_drift" },
      actions: [],
    });
    expect(run({ foreignListener: true, reason: "listener_owner_mismatch" })).toEqual({
      result: { status: "blocked", reason: "foreign_listener" },
      actions: [],
    });
  });

  test("skips a healthy agent and never selects an alternative label or port", () => {
    const { result, actions } = run({ healthStatus: "healthy", reason: undefined, loaded: true });
    expect(result).toEqual({ status: "skipped", reason: "already_healthy" });
    expect(actions).toEqual([]);
  });
});

describe("renderPlist", () => {
  test("a daemon keeps itself alive and runs at load", () => {
    const xml = renderPlist(
      { label: "com.devbox.ilterugur.desktop", mode: "daemon", argv: ["/usr/bin/ssh", "-N"], description: "d" },
      "/Users/me/.local/state/devbox",
    );
    expect(xml).toContain("<key>Label</key>\n  <string>com.devbox.ilterugur.desktop</string>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).not.toContain("StartInterval");
    expect(xml).toContain("<string>/usr/bin/ssh</string>");
    expect(xml).toContain("/Users/me/.local/state/devbox/com.devbox.ilterugur.desktop.log");
  });

  test("an interval agent runs periodically and is not kept alive", () => {
    const xml = renderPlist(
      { label: "com.devbox.ilterugur.mount", mode: "interval", intervalSeconds: 60, argv: ["/bin/echo"], description: "m" },
      "/tmp/log",
    );
    expect(xml).toContain("<key>StartInterval</key>\n  <integer>60</integer>");
    expect(xml).not.toContain("KeepAlive");
  });

  test("carries a PATH launchd does not have, so a spawned rclone/ssh is findable", () => {
    const xml = renderPlist(
      { label: "com.devbox.ilterugur.mount", mode: "interval", argv: ["/bin/echo"], description: "m" },
      "/Users/me/.local/state/devbox",
      "/Users/me",
    );
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    const path = agentEnv("/Users/me").PATH;
    expect(xml).toContain(`<key>PATH</key>\n    <string>${path}</string>`);
    expect(xml).toContain("<key>HOME</key>\n    <string>/Users/me</string>");
    for (const dir of ["/Users/me/.local/bin", "/opt/homebrew/bin", "/Users/me/.bun/bin", "/usr/bin"])
      expect(path.split(":")).toContain(dir);
  });

  test("escapes XML metacharacters in arguments", () => {
    const xml = renderPlist(
      { label: "com.devbox.x", mode: "daemon", argv: ["/bin/sh", "-c", "a && b < c"], description: "" },
      "/tmp/log",
    );
    expect(xml).toContain("a &amp;&amp; b &lt; c");
  });
});

describe("plistPath", () => {
  test("lands in the user's LaunchAgents directory", () => {
    expect(plistPath("com.devbox.ilterugur.desktop", "/Users/me"))
      .toBe("/Users/me/Library/LaunchAgents/com.devbox.ilterugur.desktop.plist");
  });
});

describe("resolveArgv", () => {
  test("turns the leading command into an absolute path launchd can exec", () => {
    const got = resolveArgv(["ssh", "-N", "-L", "127.0.0.1:3390:127.0.0.1:3389", "devbox-ilterugur"]);
    expect(got[0]!.startsWith("/")).toBe(true);
    expect(got[0]!.endsWith("/ssh")).toBe(true);
    expect(got.slice(1)).toEqual(["-N", "-L", "127.0.0.1:3390:127.0.0.1:3389", "devbox-ilterugur"]);
  });

  test("leaves an already-absolute command alone", () => {
    expect(resolveArgv(["/usr/bin/ssh", "-N"])).toEqual(["/usr/bin/ssh", "-N"]);
  });

  test("a dry run never aborts, even when the command is not on PATH", () => {
    const original = process.env.DEVBOX_DRYRUN;
    process.env.DEVBOX_DRYRUN = "1";
    try {
      const argv = ["devbox-agent-fixture-does-not-exist", "mount", "up"];
      expect(resolveArgv(argv)).toEqual(argv);
    } finally {
      if (original === undefined) delete process.env.DEVBOX_DRYRUN;
      else process.env.DEVBOX_DRYRUN = original;
    }
  });
});

describe("bootoutIfLoaded", () => {
  // Labels here are deliberately unmistakable fakes. PATH interception is what keeps
  // these off real launchd, but a label that looks like a real agent is one PATH-
  // resolution change away from aiming a real `bootout` at a real agent.
  const FAKE = "com.devbox.test-fixture.not-a-real-agent";

  test("does nothing, and does not throw, when the label isn't loaded", () => {
    withFakeLaunchctl({ print: 1 }, () => {
      expect(() => bootoutIfLoaded(FAKE)).not.toThrow();
    });
  });

  test("a failed bootout throws naming bootout, not whatever the caller does next", () => {
    withFakeLaunchctl({ print: 0, bootout: 1 }, () => {
      expect(() => bootoutIfLoaded(FAKE)).toThrow(/bootout failed/);
    });
  });

  test("a successful bootout of a loaded label does not throw", () => {
    withFakeLaunchctl({ loadedPrints: 1, bootout: 0 }, () => {
      expect(() => bootoutIfLoaded(FAKE)).not.toThrow();
    });
  });

  test("waits for launchd to finish unloading rather than returning on bootout's word", () => {
    // launchd accepts the bootout and holds the label a moment longer. Returning there is
    // what makes the caller's next bootstrap collide with a service that still exists.
    withFakeLaunchctl({ loadedPrints: 3, bootout: 0 }, (calls) => {
      expect(() => bootoutIfLoaded(FAKE)).not.toThrow();
      expect(calls("print")).toBeGreaterThan(1);
    });
  });

  test("throws when launchd never lets the label go", () => {
    withFakeLaunchctl({ print: 0, bootout: 0 }, () => {
      expect(() => bootoutIfLoaded(FAKE)).toThrow(/still loaded/);
    });
  });
});

describe("bootstrapAgent", () => {
  const FAKE = "com.devbox.test-fixture.not-a-real-agent";
  const FAKE_PLIST = "/nonexistent/com.devbox.test-fixture.not-a-real-agent.plist";
  type BootstrapAgent = (label: string, path: string) => void;

  test("retries the EIO launchd returns while it is still tearing the old service down", () => {
    const bootstrapAgent = agentModule.bootstrapAgent as BootstrapAgent | undefined;
    expect(bootstrapAgent).toBeDefined();

    withFakeLaunchctl({ bootstrapEio: 2 }, (calls) => {
      expect(() => bootstrapAgent!(FAKE, FAKE_PLIST)).not.toThrow();
      expect(calls("bootstrap")).toBe(3);
    });
  });

  test("gives up naming bootstrap when the EIO never clears", () => {
    const bootstrapAgent = agentModule.bootstrapAgent as BootstrapAgent | undefined;
    expect(bootstrapAgent).toBeDefined();

    withFakeLaunchctl({ bootstrapEio: 99 }, () => {
      expect(() => bootstrapAgent!(FAKE, FAKE_PLIST)).toThrow(/bootstrap failed/);
    });
  });

  test("does not retry a bootstrap that failed for some other reason", () => {
    const bootstrapAgent = agentModule.bootstrapAgent as BootstrapAgent | undefined;
    expect(bootstrapAgent).toBeDefined();

    // Only EIO means "still registered". A bad plist retried ten times is ten times the
    // wait for the same answer.
    withFakeLaunchctl({ bootstrap: 1 }, (calls) => {
      expect(() => bootstrapAgent!(FAKE, FAKE_PLIST)).toThrow(/bootstrap failed/);
      expect(calls("bootstrap")).toBe(1);
    });
  });
});

describe("installedAgentLabels", () => {
  /** A fake ~/Library/LaunchAgents holding the given plist filenames. */
  function fakeHome(names: string[]): string {
    const home = mkdtempSync(join(tmpdir(), "devbox-agent-home-"));
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), "");
    return home;
  }

  test("finds this profile's agents whatever the config now says about them", () => {
    const home = fakeHome(["com.devbox.ilterugur.desktop.plist", "com.devbox.ilterugur.mount.plist"]);
    expect(installedAgentLabels("ilterugur", home)).toEqual([
      "com.devbox.ilterugur.desktop",
      "com.devbox.ilterugur.mount",
    ]);
  });

  test("leaves another profile's and hand-written com.devbox agents alone", () => {
    const home = fakeHome([
      "com.devbox.ilterugur.desktop.plist",
      "com.devbox.emre.desktop.plist",
      "com.devbox.mount.plist",
      "com.devbox.cdp-tunnel.plist",
      // The profile's own name with nothing after it: a hand-written agent that shares
      // the whole prefix, and the one this filter is most likely to swallow.
      "com.devbox.ilterugur.plist",
      "com.devbox.ilterugur.desktop.extra.plist",
      "com.apple.something.plist",
    ]);
    expect(installedAgentLabels("ilterugur", home)).toEqual(["com.devbox.ilterugur.desktop"]);
  });

  test("no LaunchAgents directory means nothing installed, not a crash", () => {
    expect(installedAgentLabels("ilterugur", mkdtempSync(join(tmpdir(), "devbox-agent-nohome-")))).toEqual([]);
  });
});
