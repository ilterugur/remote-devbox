import { describe, expect, test } from "bun:test";
import {
  buildMountRecoveryRemoteCmd,
  buildRemoteMountProbe,
  buildOwnedUnmountRemoteCmd,
  buildRcloneServeArgs,
  buildSshfsRemoteCmd,
  buildSshRArgs,
  decideMountRecovery,
  mountHealthFromEvidence,
  decideMountStart,
  collectMountHealth,
  parseMountProbe,
  parseMountIdentity,
  planMounts,
  waitForLocalPort,
  waitForRemoteMount,
  processIdentityMatches,
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

describe("processIdentityMatches", () => {
  test("requires the executable and every exact mount-specific argv fragment", () => {
    const identity = "Fri Aug 28 01:02:03 2026 /usr/bin/ssh -T -o BatchMode=yes -R 127.0.0.1:5301:127.0.0.1:5301 devbox-work exec sshfs -f /home/work/mnt/desktop";
    expect(processIdentityMatches(identity, "ssh", ["BatchMode=yes", "127.0.0.1:5301", "devbox-work", "exec sshfs -f", "/home/work/mnt/desktop"]))
      .toBe(true);
    expect(processIdentityMatches(identity, "ssh", ["devbox-other"])).toBe(false);
    expect(processIdentityMatches(identity, "rclone", ["devbox-work"])).toBe(false);
  });
});

describe("buildSshfsRemoteCmd", () => {
  test("makes the mountpoint, refuses an existing mount, and execs sshfs read-only", () => {
    const cmd = buildSshfsRemoteCmd(5301, "/home/work/mnt/desktop", "/home/work/.cache/devbox-bridge/desktop.key", "nonce-1");
    expect(cmd).toContain("mkdir -p '/home/work/mnt/desktop'");
    expect(cmd).toContain("mountpoint -q '/home/work/mnt/desktop'");
    expect(cmd).not.toContain("fusermount");
    expect(cmd).toContain("exec sshfs -f -p 5301 mount@127.0.0.1:/ '/home/work/mnt/desktop'");
    expect(cmd).toContain("-o ro,");
    expect(cmd).toContain("IdentityFile='/home/work/.cache/devbox-bridge/desktop.key'");
    expect(cmd).toContain("reconnect");
    expect(cmd).toContain("StrictHostKeyChecking=no");
    expect(cmd).toContain("fsname=devbox-nonce-1");
  });

  test("a clean disconnected recovery uses a normal unmount, never lazy/forced unmount", () => {
    const cmd = buildMountRecoveryRemoteCmd(
      5301,
      "/home/work/mnt/desktop",
      "/home/work/.cache/devbox-bridge/desktop.key",
      "nonce-1",
    );
    expect(cmd).toContain('fusermount -u "$mp"');
    expect(cmd).not.toContain("-uz");
    expect(cmd).not.toContain("-z");
  });
});

describe("buildRemoteMountProbe", () => {
  test("detects disconnected FUSE mounts from the mount table without statting the endpoint", () => {
    const command = buildRemoteMountProbe("/home/work/mnt/desktop");
    expect(command).toContain("findmnt -rn --nocanonicalize -M \"$mp\"");
    expect(command).toContain("timeout 3 fuser -m \"$mp\"");
    expect(command).toContain("handles=unknown");
    expect(command).not.toContain('"$fuser_status" -eq 1');
    expect(command).not.toContain("mountpoint -q");
  });

  test("verifies fuse.sshfs, read-only options and the exact startup nonce", () => {
    const command = buildRemoteMountProbe("/home/work/mnt/desktop", "nonce-1");
    expect(command).toContain("FSTYPE");
    expect(command).toContain("OPTIONS");
    expect(command).toContain("SOURCE");
    expect(command).toContain("devbox-nonce-1");
    expect(parseMountIdentity("mounted=1\nidentity=1\n")).toBe(true);
    expect(parseMountIdentity("mounted=1\nidentity=0\n")).toBe(false);
  });

  test("owned unmount refuses a foreign or writable mount", () => {
    const command = buildOwnedUnmountRemoteCmd("/home/work/mnt/desktop", "nonce-1");
    expect(command).toContain("fuse.sshfs");
    expect(command).toContain("devbox-nonce-1");
    expect(command).toContain("mount identity mismatch; refusing unmount");
    expect(command).toContain("fusermount -u");
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

  test("maps the decision boundary into a stable health component", () => {
    expect(mountHealthFromEvidence("work", "desktop", {
      mounted: false, reachable: false, openHandles: 0, ownedBridge: true,
    })).toMatchObject({
      id: "client.mount.work.desktop",
      status: "failed",
      reason: "mount_absent",
      recovery: "automatic",
    });
    expect(mountHealthFromEvidence("work", "desktop", {
      mounted: true, reachable: false, openHandles: 1, ownedBridge: true,
    })).toMatchObject({ status: "blocked", reason: "mount_busy" });
  });
});

describe("decideMountStart", () => {
  test("starts only for a proven absent mount", () => {
    expect(decideMountStart({ status: "failed", reason: "mount_absent" }))
      .toEqual({ action: "start", reason: "mount_absent" });
  });

  test("refuses duplicate startup when the remote mount is present or unknown", () => {
    expect(decideMountStart({ status: "blocked", reason: "foreign_mount_process" }))
      .toEqual({ action: "refuse", reason: "foreign_mount_process" });
    expect(decideMountStart({ status: "unknown", reason: "mount_evidence_unknown" }))
      .toEqual({ action: "refuse", reason: "mount_evidence_unknown" });
    expect(decideMountStart({ status: "healthy" }))
      .toEqual({ action: "skip", reason: "already_healthy" });
  });
});

describe("waitForLocalPort", () => {
  test("waits until the rclone listener accepts connections", () => {
    const statuses = [1, 1, 0];
    let pauses = 0;
    expect(waitForLocalPort(5301, () => statuses.shift() ?? 1, () => { pauses++; }, 5)).toBe(true);
    expect(pauses).toBe(2);
  });

  test("fails closed when the listener never becomes ready", () => {
    let probes = 0;
    expect(waitForLocalPort(5301, () => { probes++; return 1; }, () => {}, 3)).toBe(false);
    expect(probes).toBe(3);
  });
});

describe("waitForRemoteMount", () => {
  test("waits for the remote mount to be present and reachable", () => {
    const evidence = [
      "mounted=0\nreachable=0\nhandles=0\n",
      "mounted=1\nreachable=1\nhandles=unknown\nidentity=1\n",
    ];
    let pauses = 0;
    expect(waitForRemoteMount("devbox-work", "/home/work/mnt/desktop", "nonce-1", () => ({
      status: 0, stdout: evidence.shift() ?? "", stderr: "",
    }), () => { pauses++; }, 3)).toBe(true);
    expect(pauses).toBe(1);
  });

  test("fails closed on probe errors or a mount that never becomes reachable", () => {
    expect(waitForRemoteMount("devbox-work", "/home/work/mnt/desktop", "nonce-1", () => ({
      status: 255, stdout: "", stderr: "ssh failed",
    }), () => {}, 2)).toBe(false);
  });
});

test("collectMountHealth joins exact bridge ownership with sanitized remote evidence", () => {
  const commands: string[] = [];
  const result = collectMountHealth(cfg, "work", (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "ssh") return { status: 0, stdout: "mounted=1\nreachable=1\nhandles=0\nidentity=1\n", stderr: "" };
    if (args.includes("41")) return { status: 0, stdout: "ssh-birth|ssh exact\n", stderr: "" };
    return { status: 0, stdout: "rclone-birth|rclone exact\n", stderr: "" };
  }, [{
    profile: "work", label: "desktop", tunnelPort: 5301, sshPid: 41, rclonePid: 42,
    remotePath: "/home/work/mnt/desktop", localPath: "/Users/me/Desktop",
    sshIdentity: "ssh-birth|ssh exact", rcloneIdentity: "rclone-birth|rclone exact",
    mountNonce: "nonce-1", createdAt: "now",
  }]);
  expect(result.find((item) => item.id === "client.mount.work.desktop")?.status).toBe("healthy");
  expect(result.find((item) => item.id === "client.mount.work.docs")?.status).toBe("blocked");
  expect(commands.some((command) => command.includes("ConnectTimeout=8"))).toBe(true);
  expect(parseMountProbe("mounted=1\nreachable=0\nhandles=2\n")).toEqual({
    mounted: true, reachable: false, openHandles: 2,
  });
});

describe("buildSshRArgs", () => {
  test("forwards box:127.0.0.1:BP -> client 127.0.0.1:RP and runs the remote cmd", () => {
    expect(buildSshRArgs("devbox-work", 5301, 5301, "REMOTE")).toEqual([
      "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
      "-R", "127.0.0.1:5301:127.0.0.1:5301", "devbox-work", "REMOTE",
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
