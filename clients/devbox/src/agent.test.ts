import { describe, expect, test } from "bun:test";
import { agentsFor, plistPath, renderPlist } from "./agent";
import type { Config } from "./config";

const cfg = (profile: Record<string, unknown>): Config => ({
  prefix: "devbox",
  default: "ilterugur",
  locale: "en_US.UTF-8",
  launch: "",
  profiles: [{ user: "ilterugur", projects: [], ...profile } as any],
});

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
