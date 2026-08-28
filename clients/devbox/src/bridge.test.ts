import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { lazyMountsFor, syncEngineFor, syncDiskEnabled, lazyMountOnConnect, type Config } from "./config";
import {
  normalizePath, pathsOverlap, readBridges, writeBridges, reconcileBridges, syncDiskRoot, freePort, type LiveMount,
} from "./bridge";

const cfg: Config = {
  prefix: "devbox", default: "work", locale: "en_US.UTF-8", launch: "claude",
  profiles: [
    { user: "work", projects: [], lazyMounts: [{ label: "desktop", path: "~/Desktop" }],
      syncEngine: "mutagen", syncDisk: true, lazyMountOnConnect: true },
    { user: "bare", projects: [] },
  ],
};

describe("config bridge accessors", () => {
  test("lazyMountsFor returns the profile's mounts, [] when absent", () => {
    expect(lazyMountsFor(cfg, "work")).toEqual([{ label: "desktop", path: "~/Desktop" }]);
    expect(lazyMountsFor(cfg, "bare")).toEqual([]);
  });
  test("syncEngineFor defaults to mutagen", () => {
    expect(syncEngineFor(cfg, "work")).toBe("mutagen");
    expect(syncEngineFor(cfg, "bare")).toBe("mutagen");
  });
  test("syncDiskEnabled / lazyMountOnConnect default to false", () => {
    expect(syncDiskEnabled(cfg, "work")).toBe(true);
    expect(syncDiskEnabled(cfg, "bare")).toBe(false);
    expect(lazyMountOnConnect(cfg, "work")).toBe(true);
    expect(lazyMountOnConnect(cfg, "bare")).toBe(false);
  });
});

describe("normalizePath", () => {
  test("expands ~ and strips trailing slash", () => {
    expect(normalizePath("~/Desktop/")).toBe(`${homedir()}/Desktop`);
  });
  test("leaves absolute paths, collapses '.' and '..'", () => {
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
  });
  test("root stays '/'", () => {
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathsOverlap", () => {
  test("equal paths overlap", () => {
    expect(pathsOverlap("~/Desktop", "~/Desktop/")).toBe(true);
  });
  test("ancestor/descendant overlap", () => {
    expect(pathsOverlap("/a/b", "/a/b/c")).toBe(true);
    expect(pathsOverlap("/a/b/c", "/a/b")).toBe(true);
  });
  test("siblings and prefix-but-not-path-boundary do NOT overlap", () => {
    expect(pathsOverlap("/a/b", "/a/c")).toBe(false);
    expect(pathsOverlap("/a/bc", "/a/b")).toBe(false);
  });
});

const sampleMount = (over: Partial<LiveMount> = {}): LiveMount => ({
  profile: "work", label: "desktop", tunnelPort: 5001, rclonePid: 1, sshPid: 1,
  remotePath: "/home/work/mnt/desktop", localPath: "/Users/me/Desktop",
  rcloneIdentity: "started-rclone|rclone exact",
  sshIdentity: "started-ssh|ssh exact",
  createdAt: "2026-06-16T00:00:00Z", ...over,
});

describe("bridges state", () => {
  test("write then read round-trips", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    writeBridges([sampleMount()], p);
    expect(readBridges(p)).toEqual([sampleMount()]);
  });
  test("read of a missing file is []", () => {
    expect(readBridges(pjoin(tmpdir(), "does-not-exist-xyz.json"))).toEqual([]);
  });
  test("malformed state fails closed and is never replaced during reconcile", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    writeFileSync(p, "{not-json\n");
    expect(() => readBridges(p)).toThrow(/invalid bridge state/);
    expect(() => reconcileBridges(p, () => null)).toThrow(/invalid bridge state/);
    expect(readFileSync(p, "utf8")).toBe("{not-json\n");
  });
  test("well-formed JSON with malformed records also fails closed", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    writeFileSync(p, JSON.stringify([{ profile: "work", rclonePid: "41" }]));
    expect(() => readBridges(p)).toThrow(/invalid bridge state/);
  });
  test("reconcile drops entries whose pids are dead", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    const liveMount = sampleMount({ label: "live", rclonePid: 41, sshPid: 42,
      rcloneIdentity: "rclone-birth|rclone exact", sshIdentity: "ssh-birth|ssh exact" });
    writeBridges([liveMount,
                  sampleMount({ label: "dead", rclonePid: 2_000_000_000, sshPid: 2_000_000_000 })], p);
    const commands = new Map<number, string | null>([
      [41, "rclone-birth|rclone exact"],
      [42, "ssh-birth|ssh exact"],
    ]);
    const kept = reconcileBridges(p, (pid) => commands.get(pid) ?? null);
    expect(kept.map((m) => m.label)).toEqual(["live"]);
    expect(readBridges(p).map((m) => m.label)).toEqual(["live"]);
  });

  test("reconcile kills the verified devbox rclone when its ssh peer has exited", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    const mount = sampleMount({ rclonePid: 41, sshPid: 42,
      rcloneIdentity: "rclone-birth|rclone exact", sshIdentity: "ssh-birth|ssh exact" });
    writeBridges([mount], p);
    const commands = new Map<number, string | null>([
      [41, "rclone-birth|rclone exact"],
      [42, null],
    ]);
    const killed: number[] = [];

    const kept = reconcileBridges(p, (pid) => commands.get(pid) ?? null, (pid) => killed.push(pid));

    expect(kept).toEqual([mount]);
    expect(readBridges(p)).toEqual([mount]);
    expect(killed).toEqual([41]);

    commands.set(41, null);
    expect(reconcileBridges(p, (pid) => commands.get(pid) ?? null)).toEqual([]);
  });

  test("reconcile never kills or retains foreign processes after pid reuse", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    writeBridges([sampleMount({ rclonePid: 41, sshPid: 42 })], p);
    const killed: number[] = [];

    const kept = reconcileBridges(
      p,
      (pid) => pid === 41 ? "new-birth|rclone exact" : "new-birth|ssh exact",
      (pid) => killed.push(pid),
    );

    expect(kept).toHaveLength(1);
    expect(killed).toEqual([]);
  });

  test("revalidates the birth identity immediately before signalling a stale sibling", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    const mount = sampleMount({ rclonePid: 41, sshPid: 42,
      rcloneIdentity: "old-birth|rclone exact", sshIdentity: "old-birth|ssh exact" });
    writeBridges([mount], p);
    let rcloneReads = 0;
    const killed: number[] = [];
    reconcileBridges(p, (pid) => {
      if (pid === 42) return null;
      rcloneReads++;
      return rcloneReads === 1 ? "old-birth|rclone exact" : "reused-birth|rclone exact";
    }, (pid) => killed.push(pid));
    expect(killed).toEqual([]);
  });

  test("legacy entries without birth identities are retained as unknown and never signalled", () => {
    const p = pjoin(mkdtempSync(pjoin(tmpdir(), "br-")), "bridges.json");
    const legacy = sampleMount({ rcloneIdentity: undefined, sshIdentity: undefined });
    writeBridges([legacy], p);
    const killed: number[] = [];
    expect(reconcileBridges(p, () => "any", (pid) => killed.push(pid))).toEqual([legacy]);
    expect(killed).toEqual([]);
  });
});

describe("syncDiskRoot", () => {
  test("is ~/devbox/<profile>", () => {
    expect(syncDiskRoot("work")).toBe(`${homedir()}/devbox/work`);
  });
});

describe("freePort", () => {
  test("returns a usable TCP port number", () => {
    const p = freePort();
    expect(p).toBeGreaterThan(1024);
    expect(p).toBeLessThan(65536);
  });
});
