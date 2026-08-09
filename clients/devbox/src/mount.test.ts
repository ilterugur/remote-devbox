import { describe, expect, test } from "bun:test";
import {
  buildMountRecoveryRemoteCmd,
  buildRcloneServeArgs,
  buildSshfsRemoteCmd,
  buildSshRArgs,
  decideMountRecovery,
  planMounts,
} from "./mount";
import type { Config } from "./config";

describe("buildRcloneServeArgs", () => {
  test("serves the path read-only on localhost with key auth", () => {
    const a = buildRcloneServeArgs("/Users/me/Desktop", 5301, "/tmp/k.pub");
    expect(a).toEqual([
      "serve", "sftp", "/Users/me/Desktop",
      "--addr", "127.0.0.1:5301",
      "--read-only",
      "--user", "mount",
      "--authorized-keys", "/tmp/k.pub",
      "--vfs-cache-mode", "off",
    ]);
  });
});

describe("buildSshfsRemoteCmd", () => {
  test("makes the mountpoint, refuses an existing mount, and execs sshfs read-only", () => {
    const cmd = buildSshfsRemoteCmd(5301, "/home/work/mnt/desktop", "/home/work/.cache/devbox-bridge/desktop.key");
    expect(cmd).toContain("mkdir -p '/home/work/mnt/desktop'");
    expect(cmd).toContain("mountpoint -q '/home/work/mnt/desktop'");
    expect(cmd).not.toContain("fusermount");
    expect(cmd).toContain("exec sshfs -p 5301 mount@127.0.0.1:/ '/home/work/mnt/desktop'");
    expect(cmd).toContain("-o ro,");
    expect(cmd).toContain("IdentityFile='/home/work/.cache/devbox-bridge/desktop.key'");
    expect(cmd).toContain("reconnect");
    expect(cmd).toContain("StrictHostKeyChecking=no");
  });

  test("a clean disconnected recovery uses a normal unmount, never lazy/forced unmount", () => {
    const cmd = buildMountRecoveryRemoteCmd(
      5301,
      "/home/work/mnt/desktop",
      "/home/work/.cache/devbox-bridge/desktop.key",
    );
    expect(cmd).toContain("fusermount -u '/home/work/mnt/desktop'");
    expect(cmd).not.toContain("-uz");
    expect(cmd).not.toContain("-z");
  });
});

describe("decideMountRecovery", () => {
  test("recovers an absent mount and skips a reachable mount", () => {
    expect(decideMountRecovery({ mounted: false, reachable: false, openHandles: 0, ownedBridge: true }))
      .toEqual({ action: "run", reason: "mount_absent", unmountFirst: false });
    expect(decideMountRecovery({ mounted: true, reachable: true, openHandles: 0, ownedBridge: true }))
      .toEqual({ action: "skip", reason: "already_healthy" });
  });

  test("recovers only a provably clean, owned disconnected mount", () => {
    expect(decideMountRecovery({ mounted: true, reachable: false, openHandles: 0, ownedBridge: true }))
      .toEqual({ action: "run", reason: "mount_disconnected_clean", unmountFirst: true });
    expect(decideMountRecovery({ mounted: true, reachable: false, openHandles: 2, ownedBridge: true }))
      .toEqual({ action: "refuse", reason: "mount_busy" });
    expect(decideMountRecovery({ mounted: true, reachable: false, openHandles: null, ownedBridge: true }))
      .toEqual({ action: "refuse", reason: "mount_busy_or_unknown" });
  });

  test("refuses unknown reachability and foreign bridge ownership", () => {
    expect(decideMountRecovery({ mounted: true, reachable: null, openHandles: 0, ownedBridge: true }))
      .toEqual({ action: "refuse", reason: "mount_evidence_unknown" });
    expect(decideMountRecovery({ mounted: false, reachable: false, openHandles: 0, ownedBridge: false }))
      .toEqual({ action: "refuse", reason: "foreign_mount_process" });
  });
});

describe("buildSshRArgs", () => {
  test("forwards box:127.0.0.1:BP -> client 127.0.0.1:RP and runs the remote cmd", () => {
    expect(buildSshRArgs("devbox-work", 5301, 5301, "REMOTE")).toEqual([
      "-T", "-R", "127.0.0.1:5301:127.0.0.1:5301", "devbox-work", "REMOTE",
    ]);
  });
});

const cfg: Config = {
  prefix: "devbox", default: "work", locale: "en_US.UTF-8", launch: "claude",
  profiles: [{ user: "work", projects: [], lazyMounts: [
    { label: "desktop", path: "~/Desktop" },
    { label: "docs", path: "~/Documents" },
  ] }],
};

describe("planMounts", () => {
  test("one entry per configured lazy mount, with box mountpoint + host", () => {
    const plan = planMounts(cfg, "work");
    expect(plan.map((p) => p.label)).toEqual(["desktop", "docs"]);
    expect(plan[0].host).toBe("devbox-work");
    expect(plan[0].remotePath).toBe("/home/work/mnt/desktop");
    expect(plan[0].localPath.endsWith("/Desktop")).toBe(true);
  });
  test("rejects a lazy path that overlaps the sync disk", () => {
    const bad: Config = { ...cfg, profiles: [{ user: "work", projects: [],
      lazyMounts: [{ label: "x", path: "~/devbox/work/sub" }] }] };
    expect(() => planMounts(bad, "work")).toThrow(/overlaps the sync disk/);
  });
});
