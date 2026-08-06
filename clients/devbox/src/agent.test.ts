import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentModule from "./agent";
import {
  agentEnv,
  agentsFor,
  bootoutIfLoaded,
  installedAgentLabels,
  localForwardPort,
  plistPath,
  renderPlist,
  resolveArgv,
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
function withFakeLaunchctl(behavior: { print?: number; bootout?: number }, fn: () => void): void {
  const bin = mkdtempSync(join(tmpdir(), "devbox-agent-bin-"));
  const script = `#!/bin/sh
case "$1" in
  print) exit ${behavior.print ?? 0} ;;
  bootout) exit ${behavior.bootout ?? 0} ;;
  *) exit 0 ;;
esac
`;
  const path = join(bin, "launchctl");
  writeFileSync(path, script);
  chmodSync(path, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    fn();
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
};

const SUPERVISOR_READY_TIMEOUT_SECONDS = 3;
const BEHAVIORAL_FIXTURE_BUDGET_MS = 5_000;

function fakeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\n${source}`);
  chmodSync(path, 0o755);
}

function supervisorFixture(markerPort: string): SupervisorFixture {
  const root = mkdtempSync(join(tmpdir(), "devbox-browser-supervisor-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const events = join(root, "events");
  mkdirSync(bin);
  mkdirSync(state);

  const chromePath = join(bin, "chrome");
  const curlPath = join(bin, "curl");
  const sshPath = join(bin, "ssh");
  fakeExecutable(chromePath, [
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --user-data-dir=*) data_dir=${arg#--user-data-dir=} ;;',
    '  esac',
    'done',
    'printf "%s\\n/devtools/browser/fake\\n" "$MARKER_PORT" > "$data_dir/DevToolsActivePort"',
    'printf "%s\\n" "$$" > "$STATE/chrome.pid"',
    'printf "%s\\n" "chrome $*" >> "$EVENTS"',
    'trap \'printf "%s\\n" chrome-term >> "$EVENTS"; exit 0\' TERM INT HUP',
    'while :; do sleep 0.01; done',
  ].join("\n"));
  fakeExecutable(curlPath, [
    'printf "%s\\n" "curl $*" >> "$EVENTS"',
    'exit 0',
  ].join("\n"));
  fakeExecutable(sshPath, [
    'printf "%s\\n" "ssh $*" >> "$EVENTS"',
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
    env: { ...process.env, EVENTS: fixture.events, MARKER_PORT: fixture.markerPort, STATE: fixture.state },
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
    expect(mount.argv.slice(-3)).toEqual(["devbox", "mount", "up"]);
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
    withFakeLaunchctl({ print: 0, bootout: 0 }, () => {
      expect(() => bootoutIfLoaded(FAKE)).not.toThrow();
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
