/**
 * mount.ts — `devbox mount`: expose configured client paths to the box as ephemeral,
 * read-only, full-depth mounts. A client-side `rclone serve sftp` (jailed to the path,
 * --read-only, key-auth) is reached by the box over an `ssh -R` reverse tunnel and
 * mounted with `sshfs -f`. Pure builders are exported for unit tests; runMountUp/Down
 * orchestrate. Honors DEVBOX_DRYRUN=1 (print, don't execute).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { die, hostFor, lazyMountsFor, shQuote, type Config } from "./config";
import {
  freePort,
  normalizePath,
  pathsOverlap,
  readBridges,
  reconcileBridges,
  syncDiskRoot,
  writeBridges,
  type LiveMount,
} from "./bridge";
import type { LocalHealthResult } from "./health";

const SSHFS_OPTS = [
  "ro",
  "reconnect",
  "ServerAliveInterval=15",
  "ServerAliveCountMax=3",
  "StrictHostKeyChecking=no",
  "UserKnownHostsFile=/dev/null",
  "follow_symlinks",
];

export function buildRcloneServeArgs(servePath: string, port: number, authKeysFile: string): string[] {
  return [
    "serve", "sftp", servePath,
    "--addr", `127.0.0.1:${port}`,
    "--read-only",
    "--user", "mount",
    "--authorized-keys", authKeysFile,
    "--vfs-cache-mode", "off",
  ];
}

export function buildSshfsRemoteCmd(boxPort: number, mountpoint: string, keyFile: string): string {
  const mp = shQuote(mountpoint);
  const opts = [...SSHFS_OPTS, `IdentityFile=${shQuote(keyFile)}`].join(",");
  return [
    `mkdir -p ${mp}`,
    `if mountpoint -q ${mp}; then echo 'devbox: mountpoint already mounted; refusing replacement' >&2; exit 73; fi`,
    `exec sshfs -p ${boxPort} mount@127.0.0.1:/ ${mp} -o ${opts}`,
  ].join("; ");
}

export function buildMountRecoveryRemoteCmd(boxPort: number, mountpoint: string, keyFile: string): string {
  const mp = shQuote(mountpoint);
  return `fusermount -u ${mp} && ${buildSshfsRemoteCmd(boxPort, mountpoint, keyFile)}`;
}

export interface MountRecoveryEvidence {
  mounted: boolean;
  reachable: boolean | null;
  openHandles: number | null;
  ownedBridge: boolean | null;
}

export type MountRecoveryDecision =
  | { action: "run"; reason: "mount_absent" | "mount_disconnected_clean"; unmountFirst: boolean }
  | { action: "skip" | "refuse"; reason: string };

/** A stale mount is mutable only when ownership, disconnection and zero open handles are all proven. */
export function decideMountRecovery(evidence: MountRecoveryEvidence): MountRecoveryDecision {
  if (evidence.ownedBridge === null) return { action: "refuse", reason: "mount_evidence_unknown" };
  if (!evidence.ownedBridge) return { action: "refuse", reason: "foreign_mount_process" };
  if (!evidence.mounted) return { action: "run", reason: "mount_absent", unmountFirst: false };
  if (evidence.reachable === true) return { action: "skip", reason: "already_healthy" };
  if (evidence.reachable === null) return { action: "refuse", reason: "mount_evidence_unknown" };
  if (evidence.openHandles === null) return { action: "refuse", reason: "mount_busy_or_unknown" };
  if (evidence.openHandles > 0) return { action: "refuse", reason: "mount_busy" };
  return { action: "run", reason: "mount_disconnected_clean", unmountFirst: true };
}

export function mountHealthFromEvidence(
  profile: string,
  label: string,
  evidence: MountRecoveryEvidence,
): LocalHealthResult {
  const decision = decideMountRecovery(evidence);
  const observed = [
    `mounted ${evidence.mounted}`,
    `reachable ${evidence.reachable === null ? "unknown" : evidence.reachable}`,
    `open handles ${evidence.openHandles === null ? "unknown" : evidence.openHandles}`,
    `owned bridge ${evidence.ownedBridge}`,
  ];
  const base = {
    id: `client.mount.${profile}.${label}`,
    expected: ["owned read-only mount reachable with no unsafe recovery boundary"],
    observed,
    recovery: "automatic" as const,
  };
  if (decision.action === "skip") return { ...base, status: "healthy" };
  if (decision.action === "run") return { ...base, status: "failed", reason: decision.reason };
  if (decision.reason === "mount_evidence_unknown" || decision.reason === "mount_busy_or_unknown") {
    return { ...base, status: "unknown", reason: decision.reason };
  }
  return { ...base, status: "blocked", reason: decision.reason };
}

export type MountProbeRunner = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

const defaultMountProbeRunner: MountProbeRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export function parseMountProbe(output: string): Omit<MountRecoveryEvidence, "ownedBridge"> {
  const values = Object.fromEntries(output.trim().split("\n").map((line) => line.split("=", 2)));
  if (values.mounted !== "0" && values.mounted !== "1") throw new Error("invalid mount evidence");
  if (values.reachable !== "0" && values.reachable !== "1" && values.reachable !== "unknown") {
    throw new Error("invalid mount reachability evidence");
  }
  if (values.handles !== "unknown" && !/^[0-9]+$/.test(values.handles ?? "")) {
    throw new Error("invalid mount handle evidence");
  }
  return {
    mounted: values.mounted === "1",
    reachable: values.reachable === "unknown" ? null : values.reachable === "1",
    openHandles: values.handles === "unknown" ? null : Number(values.handles),
  };
}

function remoteMountProbe(mountpoint: string): string {
  const mp = shQuote(mountpoint);
  return `mp=${mp}; if ! mountpoint -q "$mp"; then printf 'mounted=0\\nreachable=0\\nhandles=0\\n'; exit 0; fi; `
    + `reachable=0; timeout 3 stat "$mp" >/dev/null 2>&1 && reachable=1; `
    + `if command -v fuser >/dev/null 2>&1; then handles=$(fuser -m "$mp" 2>/dev/null | wc -w | tr -d ' '); else handles=unknown; fi; `
    + `printf 'mounted=1\\nreachable=%s\\nhandles=%s\\n' "$reachable" "$handles"`;
}

function bridgeOwnership(bridge: LiveMount, runner: MountProbeRunner): boolean | null {
  const checks: Array<[number, string]> = [[bridge.sshPid, "ssh"], [bridge.rclonePid, "rclone"]];
  let anyManaged = false;
  for (const [pid, expected] of checks) {
    let result: ReturnType<MountProbeRunner>;
    try {
      result = runner("ps", ["-p", String(pid), "-o", "comm="]);
    } catch {
      return null;
    }
    if (result.status === 1) continue;
    if (result.status !== 0) return null;
    const executable = result.stdout.trim().split("/").at(-1);
    if (executable !== expected) return false;
    anyManaged = true;
  }
  // Two absent PIDs are a stale Devbox record, not evidence of a foreign process.
  return anyManaged || checks.length > 0;
}

export function collectMountHealth(
  cfg: Config,
  profile: string,
  runner: MountProbeRunner = defaultMountProbeRunner,
  bridges: LiveMount[] = readBridges(),
): LocalHealthResult[] {
  return planMounts(cfg, profile).map((plan) => {
    const bridge = bridges.find((candidate) => candidate.profile === profile && candidate.label === plan.label);
    let remote;
    try {
      const result = runner("ssh", [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", plan.host, remoteMountProbe(plan.remotePath),
      ]);
      if (result.status !== 0) throw new Error("remote probe failed");
      remote = parseMountProbe(result.stdout);
    } catch {
      return mountHealthFromEvidence(profile, plan.label, {
        mounted: false, reachable: null, openHandles: null, ownedBridge: null,
      });
    }
    const ownedBridge = bridge
      ? bridgeOwnership(bridge, runner)
      : remote.mounted ? false : true;
    return mountHealthFromEvidence(profile, plan.label, { ...remote, ownedBridge });
  });
}

export function buildSshRArgs(host: string, boxPort: number, localPort: number, remoteCmd: string): string[] {
  return ["-T", "-R", `127.0.0.1:${boxPort}:127.0.0.1:${localPort}`, host, remoteCmd];
}

export type MountPlan = { label: string; localPath: string; remotePath: string; host: string };

/** Pure: turn a profile's configured lazy mounts into per-label plan entries, enforcing
 *  the overlap rule against the sync disk. Throws (via die) on a bad config. */
export function planMounts(cfg: Config, profile: string): MountPlan[] {
  const host = hostFor(cfg, profile);
  const disk = syncDiskRoot(profile);
  return lazyMountsFor(cfg, profile).map((m) => {
    const localPath = normalizePath(m.path);
    if (pathsOverlap(localPath, disk)) die(`lazy mount "${m.label}" (${localPath}) overlaps the sync disk ${disk}`);
    return { label: m.label, localPath, remotePath: `/home/${profile}/mnt/${m.label}`, host };
  });
}

const isDry = () => !!process.env.DEVBOX_DRYRUN;
const out = (s: string) => process.stdout.write(s + "\n");

/** Establish all configured lazy mounts for a profile. Idempotent: reconciles + skips
 *  labels already live. Each mount = one detached rclone serve + one detached `ssh -R`
 *  running `sshfs -f` (foreground, so the ssh process is the mount's lifecycle). */
export function runMountUp(cfg: Config, profile: string): void {
  const plans = planMounts(cfg, profile);
  if (!plans.length) return void out(`devbox: no lazy_mounts configured for profile "${profile}"`);
  const live = reconcileBridges();
  const host = hostFor(cfg, profile);

  for (const p of plans) {
    if (live.some((m) => m.profile === profile && m.label === p.label)) {
      out(`  ✓ ${p.label} already mounted`);
      continue;
    }
    const rp = freePort();
    const bp = rp; // reuse the same number for the box-side forward
    const keydir = mkdtempSync(join(tmpdir(), "devbox-mnt-"));
    const keyFile = join(keydir, "id");
    const remoteKey = `/home/${profile}/.cache/devbox-bridge/${p.label}.key`;

    if (isDry()) {
      out(`  ── would mount ${p.localPath} -> ${host}:${p.remotePath} (rclone :${rp}, ssh -R ${bp})`);
      out(`     rclone ${buildRcloneServeArgs(p.localPath, rp, `${keyFile}.pub`).join(" ")}`);
      out(`     ssh ${buildSshRArgs(host, bp, rp, buildSshfsRemoteCmd(bp, p.remotePath, remoteKey)).join(" ")}`);
      rmSync(keydir, { recursive: true, force: true });
      continue;
    }

    // 1) ephemeral keypair (box-user isolation: the -R port is localhost-reachable by any box user)
    const kg = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyFile]);
    if (kg.status !== 0) die(`ssh-keygen failed for ${p.label}`);

    // 2) ship the PRIVATE key to the box (0600) so sshfs can auth to rclone
    const ship = `umask 077; mkdir -p /home/${profile}/.cache/devbox-bridge; cat > ${shQuote(remoteKey)}`;
    const sk = spawnSync("ssh", ["-o", "BatchMode=yes", host, ship], { input: readFileSync(keyFile) });
    if (sk.status !== 0) die(`could not place mount key on ${host}: ${(sk.stderr || "").toString().trim()}`);

    // 3) start rclone serve (detached, survives this CLI invocation)
    const rclone = spawn("rclone", buildRcloneServeArgs(p.localPath, rp, `${keyFile}.pub`), {
      detached: true, stdio: "ignore",
    });
    rclone.unref();

    // 4) open the reverse tunnel + foreground sshfs (detached; this ssh IS the mount)
    const remoteCmd = buildSshfsRemoteCmd(bp, p.remotePath, remoteKey);
    const ssh = spawn("ssh", buildSshRArgs(host, bp, rp, remoteCmd), { detached: true, stdio: "ignore" });
    ssh.unref();

    const entry: LiveMount = {
      profile, label: p.label, tunnelPort: bp,
      rclonePid: rclone.pid ?? -1, sshPid: ssh.pid ?? -1,
      remotePath: p.remotePath, localPath: p.localPath,
      createdAt: new Date().toISOString(),
    };
    writeBridges([...reconcileBridges(), entry]);
    out(`  ✓ ${p.label}: ${p.localPath} -> ${host}:${p.remotePath} (read-only)`);
  }
}

function killPid(pid: number): void {
  try { process.kill(pid); } catch { /* already gone */ }
}

/** Tear down lazy mounts. `label` undefined => all of the profile's mounts. */
export function runMountDown(cfg: Config, profile: string, label?: string): void {
  const host = hostFor(cfg, profile);
  const all = reconcileBridges();
  const victims = all.filter((m) => m.profile === profile && (!label || m.label === label));
  if (!victims.length) return void out(`devbox: no live mounts to remove for "${profile}"${label ? ` (${label})` : ""}`);
  for (const m of victims) {
    if (isDry()) { out(`  ── would unmount ${host}:${m.remotePath} (kill ${m.sshPid}, ${m.rclonePid})`); continue; }
    const unmount = spawnSync("ssh", ["-o", "BatchMode=yes", host,
      `fusermount -u ${shQuote(m.remotePath)} && rm -f /home/${profile}/.cache/devbox-bridge/${m.label}.key`]);
    if (unmount.status !== 0) {
      die(`could not safely unmount ${m.label}; it may be busy, so its processes were left running`);
    }
    killPid(m.sshPid);
    killPid(m.rclonePid);
    out(`  ✓ unmounted ${m.label}`);
  }
  writeBridges(all.filter((m) => !victims.includes(m)));
}

/** Print the live lazy mounts (after reconcile). */
export function runMountStatus(): void {
  const live = reconcileBridges();
  if (!live.length) return void out("devbox: no live lazy mounts");
  for (const m of live) out(`  ${m.profile}/${m.label}  ${m.localPath} -> ${m.remotePath}  (pid ssh ${m.sshPid})`);
}
