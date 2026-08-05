import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsFor, bootoutIfLoaded, plistPath, renderPlist, resolveArgv } from "./agent";
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
  test("does nothing, and does not throw, when the label isn't loaded", () => {
    withFakeLaunchctl({ print: 1 }, () => {
      expect(() => bootoutIfLoaded("com.devbox.not-loaded")).not.toThrow();
    });
  });

  test("a failed bootout throws naming bootout, not whatever the caller does next", () => {
    withFakeLaunchctl({ print: 0, bootout: 1 }, () => {
      expect(() => bootoutIfLoaded("com.devbox.ilterugur.desktop")).toThrow(/bootout failed/);
    });
  });

  test("a successful bootout of a loaded label does not throw", () => {
    withFakeLaunchctl({ print: 0, bootout: 0 }, () => {
      expect(() => bootoutIfLoaded("com.devbox.ilterugur.desktop")).not.toThrow();
    });
  });
});
