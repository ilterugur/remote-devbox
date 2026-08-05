import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEnv,
  agentsFor,
  bootoutIfLoaded,
  installedAgentLabels,
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
      "com.devbox.ilterugur.desktop.extra.plist",
      "com.apple.something.plist",
    ]);
    expect(installedAgentLabels("ilterugur", home)).toEqual(["com.devbox.ilterugur.desktop"]);
  });

  test("no LaunchAgents directory means nothing installed, not a crash", () => {
    expect(installedAgentLabels("ilterugur", mkdtempSync(join(tmpdir(), "devbox-agent-nohome-")))).toEqual([]);
  });
});
