/**
 * mount.ts — `devbox mount`: expose configured client paths to the box as ephemeral,
 * read-only, full-depth mounts. A client-side `rclone serve sftp` (jailed to the path,
 * --read-only, key-auth) is reached by the box over an `ssh -R` reverse tunnel and
 * mounted with `sshfs -f`. Pure builders are exported for unit tests; runMountUp/Down
 * orchestrate. Honors DEVBOX_DRYRUN=1 (print, don't execute).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { die, hostFor, lazyMountsFor, shQuote, type Config } from "./config";
import {
  freePort,
  normalizePath,
  pathsOverlap,
  assessBridgeProcesses,
  defaultProcessIdentity,
  readBridges,
  reconcileBridges,
  stopOwnedBridgeProcesses,
  syncDiskRoot,
  writeBridges,
  type LiveMount,
} from "./bridge";
import type { LocalHealthResult } from "./health";
import { withMountLock } from "./mount-lock";

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

const mountFsName = (nonce: string): string => `devbox-${nonce}`;

export function buildSshfsRemoteCmd(boxPort: number, mountpoint: string, keyFile: string, nonce: string): string {
  const mp = shQuote(mountpoint);
  const opts = [...SSHFS_OPTS, `fsname=${mountFsName(nonce)}`, `IdentityFile=${shQuote(keyFile)}`].join(",");
  return [
    `mkdir -p ${mp}`,
    `if mountpoint -q ${mp}; then echo 'devbox: mountpoint already mounted; refusing replacement' >&2; exit 73; fi`,
    `exec sshfs -f -p ${boxPort} mount@127.0.0.1:/ ${mp} -o ${opts}`,
  ].join("; ");
}

export function buildMountRecoveryRemoteCmd(boxPort: number, mountpoint: string, keyFile: string, nonce: string): string {
  return `{ ${buildOwnedUnmountRemoteCmd(mountpoint, nonce)}; } && ${buildSshfsRemoteCmd(boxPort, mountpoint, keyFile, nonce)}`;
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

export type MountStartDecision =
  | { action: "start"; reason: "mount_absent" }
  | { action: "skip"; reason: "already_healthy" }
  | { action: "refuse"; reason: string };

export function decideMountStart(
  health: { status: string; reason?: string } | undefined,
): MountStartDecision {
  if (health?.status === "failed" && health.reason === "mount_absent") {
    return { action: "start", reason: "mount_absent" };
  }
  if (health?.status === "healthy") return { action: "skip", reason: "already_healthy" };
  return { action: "refuse", reason: health?.reason ?? "mount_evidence_unknown" };
}

export type LocalPortProbe = (port: number) => number | null;

export function waitForLocalPort(
  port: number,
  probe: LocalPortProbe = (candidate) => spawnSync(
    "nc", ["-z", "127.0.0.1", String(candidate)], { stdio: "ignore" },
  ).status,
  pause: () => void = () => { spawnSync("/bin/sleep", ["0.1"]); },
  attempts: number = 30,
): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (probe(port) === 0) return true;
    if (attempt + 1 < attempts) pause();
  }
  return false;
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

export function buildRemoteMountProbe(mountpoint: string, nonce?: string): string {
  const mp = shQuote(mountpoint);
  return `mp=${mp}; if ! findmnt -rn --nocanonicalize -M "$mp" >/dev/null 2>&1; then printf 'mounted=0\\nreachable=0\\nhandles=0\\n'; exit 0; fi; `
    + `reachable=0; timeout 3 stat "$mp" >/dev/null 2>&1 && reachable=1; `
    + `handles=unknown; if command -v fuser >/dev/null 2>&1; then `
    + `fuser_out=$(timeout 3 fuser -m "$mp" 2>/dev/null); fuser_status=$?; `
    + `if [ "$fuser_status" -eq 0 ]; then handles=$(printf '%s' "$fuser_out" | wc -w | tr -d ' '); `
    + `fi; fi; `
    + (nonce
      ? `identity=0; fstype=$(findmnt -rn --nocanonicalize -M "$mp" -o FSTYPE); options=$(findmnt -rn --nocanonicalize -M "$mp" -o OPTIONS); source=$(findmnt -rn --nocanonicalize -M "$mp" -o SOURCE); `
        + `if [ "$fstype" = fuse.sshfs ] && [ "$source" = ${shQuote(mountFsName(nonce))} ]; then case ",$options," in *,ro,*) identity=1;; esac; fi; `
      : `identity=unknown; `)
    + `printf 'mounted=1\\nreachable=%s\\nhandles=%s\\nidentity=%s\\n' "$reachable" "$handles" "$identity"`;
}

export function parseMountIdentity(output: string): boolean | null {
  const line = output.trim().split("\n").find((candidate) => candidate.startsWith("identity="));
  const value = line?.slice("identity=".length);
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

export function buildOwnedUnmountRemoteCmd(mountpoint: string, nonce: string): string {
  const mp = shQuote(mountpoint);
  const expected = shQuote(mountFsName(nonce));
  return `mp=${mp}; fstype=$(findmnt -rn --nocanonicalize -M "$mp" -o FSTYPE); options=$(findmnt -rn --nocanonicalize -M "$mp" -o OPTIONS); source=$(findmnt -rn --nocanonicalize -M "$mp" -o SOURCE); `
    + `owned=0; if [ "$fstype" = fuse.sshfs ] && [ "$source" = ${expected} ]; then case ",$options," in *,ro,*) owned=1;; esac; fi; `
    + `[ "$owned" -eq 1 ] || { echo 'devbox: mount identity mismatch; refusing unmount' >&2; exit 74; }; fusermount -u "$mp"`;
}

function bridgeOwnership(bridge: LiveMount, runner: MountProbeRunner): boolean | null {
  const assessment = assessBridgeProcesses(bridge, (pid) => {
    try {
      const result = runner("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="]);
      if (result.status === 1) return null;
      if (result.status !== 0) return undefined;
      return result.stdout.trim() || null;
    } catch { return undefined; }
  });
  return assessment.state === "live" ? true : assessment.state === "unknown" ? null : false;
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
    let remoteOutput = "";
    try {
      const result = runner("ssh", [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", plan.host,
        buildRemoteMountProbe(plan.remotePath, bridge?.mountNonce),
      ]);
      if (result.status !== 0) throw new Error("remote probe failed");
      remoteOutput = result.stdout;
      remote = parseMountProbe(result.stdout);
    } catch {
      return mountHealthFromEvidence(profile, plan.label, {
        mounted: false, reachable: null, openHandles: null, ownedBridge: null,
      });
    }
    const processOwned = bridge ? bridgeOwnership(bridge, runner) : null;
    const mountIdentity = bridge?.mountNonce ? parseMountIdentity(remoteOutput) : null;
    const ownedBridge = bridge
      ? remote.mounted
        ? processOwned === null || mountIdentity === null ? null : processOwned && mountIdentity
        : processOwned
      : remote.mounted ? false : true;
    return mountHealthFromEvidence(profile, plan.label, { ...remote, ownedBridge });
  });
}

export function buildSshRArgs(host: string, boxPort: number, localPort: number, remoteCmd: string): string[] {
  return ["-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-R", `127.0.0.1:${boxPort}:127.0.0.1:${localPort}`, host, remoteCmd];
}

export function processIdentityMatches(identity: string, executable: string, required: string[]): boolean {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:\\S*/)?${escaped}(?:\\s|$)`).test(identity)
    && required.every((fragment) => identity.includes(fragment));
}

export function waitForRemoteMount(
  host: string,
  remotePath: string,
  nonce: string,
  runner: MountProbeRunner = defaultMountProbeRunner,
  pause: () => void = () => { spawnSync("/bin/sleep", ["0.2"]); },
  attempts: number = 25,
): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = runner("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host,
        buildRemoteMountProbe(remotePath, nonce)]);
      if (result.status === 0) {
        const evidence = parseMountProbe(result.stdout);
        if (evidence.mounted && evidence.reachable === true && parseMountIdentity(result.stdout) === true) return true;
      }
    } catch { /* retry boundedly */ }
    if (attempt + 1 < attempts) pause();
  }
  return false;
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
export function runMountUp(cfg: Config, profile: string, label?: string): void {
  if (isDry()) return runMountUpUnlocked(cfg, profile, label);
  return withMountLock(profile, () => runMountUpUnlocked(cfg, profile, label));
}

function runMountUpUnlocked(cfg: Config, profile: string, label?: string): void {
  const configured = planMounts(cfg, profile);
  const plans = label ? configured.filter((plan) => plan.label === label) : configured;
  if (label && !plans.length) die(`no lazy mount named "${label}" is configured for "${profile}"`);
  if (!plans.length) return void out(`devbox: no lazy_mounts configured for profile "${profile}"`);
  const live = reconcileBridges();
  const host = hostFor(cfg, profile);
  const health = isDry() ? [] : collectMountHealth(cfg, profile, defaultMountProbeRunner, live);

  for (const p of plans) {
    if (live.some((m) => m.profile === profile && m.label === p.label)) {
      out(`  ✓ ${p.label} already mounted`);
      continue;
    }
    if (!isDry()) {
      const component = health.find((item) => item.id === `client.mount.${profile}.${p.label}`);
      const decision = decideMountStart(component);
      if (decision.action !== "start") {
        out(`  ! ${p.label} not started: ${decision.reason}`);
        continue;
      }
    }
    const rp = freePort();
    const bp = rp; // reuse the same number for the box-side forward
    const keydir = mkdtempSync(join(tmpdir(), "devbox-mnt-"));
    const keyFile = join(keydir, "id");
    const remoteKey = `/home/${profile}/.cache/devbox-bridge/${p.label}.key`;
    const mountNonce = randomUUID();

    if (isDry()) {
      out(`  ── would mount ${p.localPath} -> ${host}:${p.remotePath} (rclone :${rp}, ssh -R ${bp})`);
      out(`     rclone ${buildRcloneServeArgs(p.localPath, rp, `${keyFile}.pub`).join(" ")}`);
      out(`     ssh ${buildSshRArgs(host, bp, rp, buildSshfsRemoteCmd(bp, p.remotePath, remoteKey, mountNonce)).join(" ")}`);
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

    const reservation: LiveMount = {
      profile, label: p.label, tunnelPort: bp,
      rclonePid: -1, sshPid: -1,
      remotePath: p.remotePath, localPath: p.localPath,
      mountNonce, createdAt: new Date().toISOString(),
    };
    try { writeBridges([...reconcileBridges(), reservation]); }
    catch {
      rmSync(keydir, { recursive: true, force: true });
      spawnSync("ssh", ["-o", "BatchMode=yes", host, `rm -f ${shQuote(remoteKey)}`]);
      die(`could not reserve mount state for ${p.label}; no bridge process was started`);
    }

    // 3) start rclone serve (detached, survives this CLI invocation)
    const rclone = spawn("rclone", buildRcloneServeArgs(p.localPath, rp, `${keyFile}.pub`), {
      detached: true, stdio: "ignore",
    });
    rclone.unref();
    const rcloneIdentity = waitForProcessIdentity(rclone.pid ?? -1);
    const rcloneShape = rcloneIdentity && processIdentityMatches(rcloneIdentity, "rclone", [
      "serve sftp", p.localPath, `127.0.0.1:${rp}`, "--read-only", "--user mount", `${keyFile}.pub`,
    ]);
    if (!rcloneIdentity || !rcloneShape) {
      if (rclone.exitCode === null) rclone.kill();
      spawnSync("/bin/sleep", ["0.1"]);
      if (defaultProcessIdentity(rclone.pid ?? -1) === null) removeBridgeEntry(reservation);
      rmSync(keydir, { recursive: true, force: true });
      spawnSync("ssh", ["-o", "BatchMode=yes", host, `rm -f ${shQuote(remoteKey)}`]);
      die(`could not prove rclone process ownership for ${p.label}`);
    }
    if (!waitForLocalPort(rp)) {
      if (stopExactProcess(rclone.pid ?? -1, rcloneIdentity)) removeBridgeEntry(reservation);
      rmSync(keydir, { recursive: true, force: true });
      spawnSync("ssh", ["-o", "BatchMode=yes", host, `rm -f ${shQuote(remoteKey)}`]);
      die(`rclone listener did not become ready for ${p.label}`);
    }

    // 4) open the reverse tunnel + foreground sshfs (detached; this ssh IS the mount)
    const remoteCmd = buildSshfsRemoteCmd(bp, p.remotePath, remoteKey, mountNonce);
    const ssh = spawn("ssh", buildSshRArgs(host, bp, rp, remoteCmd), { detached: true, stdio: "ignore" });
    ssh.unref();

    const sshIdentity = waitForProcessIdentity(ssh.pid ?? -1);
    const sshShape = sshIdentity && processIdentityMatches(sshIdentity, "ssh", [
      "BatchMode=yes", "ExitOnForwardFailure=yes",
      `127.0.0.1:${bp}:127.0.0.1:${rp}`, host, "exec sshfs -f", p.remotePath, remoteKey,
      `fsname=${mountFsName(mountNonce)}`,
    ]);
    if (!sshIdentity || !sshShape) {
      if (ssh.exitCode === null) ssh.kill();
      spawnSync("/bin/sleep", ["0.1"]);
      const sshGone = defaultProcessIdentity(ssh.pid ?? -1) === null;
      const rcloneGone = stopExactProcess(rclone.pid ?? -1, rcloneIdentity);
      if (sshGone && rcloneGone) removeBridgeEntry(reservation);
      rmSync(keydir, { recursive: true, force: true });
      spawnSync("ssh", ["-o", "BatchMode=yes", host, `rm -f ${shQuote(remoteKey)}`]);
      die(`could not prove mount process ownership for ${p.label}`);
    }

    const entry: LiveMount = {
      profile, label: p.label, tunnelPort: bp,
      rclonePid: rclone.pid ?? -1, sshPid: ssh.pid ?? -1,
      remotePath: p.remotePath, localPath: p.localPath,
      rcloneIdentity, sshIdentity, mountNonce,
      createdAt: reservation.createdAt,
    };
    let persisted = true;
    try {
      // Persist the exact birth identities before the slow remote readiness poll.
      // A crash can then block duplicate startup and safely reconcile only this pair.
      replaceBridgeEntry(reservation, entry);
      const remoteReady = waitForRemoteMount(host, p.remotePath, mountNonce);
      if (!remoteReady || assessBridgeProcesses(entry).state !== "live") {
        throw new Error("mount bridge failed its startup postcondition");
      }
    } catch {
      spawnSync("ssh", ["-o", "BatchMode=yes", host,
        `${buildOwnedUnmountRemoteCmd(p.remotePath, mountNonce)}; status=$?; rm -f ${shQuote(remoteKey)}; exit "$status"`]);
      const stopped = stopOwnedBridgeProcesses(entry);
      const terminated = stopped.safe && waitForBridgeExit(entry);
      if (terminated && persisted) removeBridgeEntry(entry);
      if (!terminated && !persisted) {
        // Best-effort quarantine: if the original write failed for a transient
        // reason, retain ownership evidence so an interval retry cannot duplicate it.
        try { writeBridges([...readBridges(), entry]); persisted = true; } catch { /* fail closed below */ }
      }
      rmSync(keydir, { recursive: true, force: true });
      die(terminated
        ? `mount bridge did not become healthy during startup for ${p.label}`
        : `mount bridge cleanup could not be proven for ${p.label}; ${persisted ? "state was retained" : "manual process audit is required"}`);
    }
    rmSync(keydir, { recursive: true, force: true });
    out(`  ✓ ${p.label}: ${p.localPath} -> ${host}:${p.remotePath} (read-only)`);
  }
}

function waitForProcessIdentity(pid: number, attempts: number = 20): string | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const identity = defaultProcessIdentity(pid);
    if (typeof identity === "string") return identity;
    if (identity === null) return null;
    if (attempt + 1 < attempts) spawnSync("/bin/sleep", ["0.05"]);
  }
  return null;
}

function waitForBridgeExit(bridge: LiveMount, attempts: number = 30): boolean {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rclone = defaultProcessIdentity(bridge.rclonePid);
    const ssh = defaultProcessIdentity(bridge.sshPid);
    const rcloneGone = rclone === null || rclone !== bridge.rcloneIdentity;
    const sshGone = ssh === null || ssh !== bridge.sshIdentity;
    if (rclone !== undefined && ssh !== undefined && rcloneGone && sshGone) return true;
    if (attempt + 1 < attempts) spawnSync("/bin/sleep", ["0.05"]);
  }
  return false;
}

function stopExactProcess(pid: number, identity: string, attempts: number = 30): boolean {
  if (defaultProcessIdentity(pid) !== identity) return false;
  try { process.kill(pid); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  for (let attempt = 0; attempt < attempts; attempt++) {
    const observed = defaultProcessIdentity(pid);
    if (observed === null || (observed !== undefined && observed !== identity)) return true;
    if (attempt + 1 < attempts) spawnSync("/bin/sleep", ["0.05"]);
  }
  return false;
}

function removeBridgeEntry(entry: LiveMount): void {
  writeBridges(readBridges().filter((candidate) =>
    !(candidate.profile === entry.profile && candidate.label === entry.label
      && candidate.createdAt === entry.createdAt)));
}

function replaceBridgeEntry(previous: LiveMount, replacement: LiveMount): void {
  const bridges = readBridges();
  const index = bridges.findIndex((candidate) =>
    candidate.profile === previous.profile && candidate.label === previous.label
    && candidate.createdAt === previous.createdAt);
  if (index < 0) throw new Error("mount reservation disappeared before process commit");
  bridges[index] = replacement;
  writeBridges(bridges);
}

export function recoverMountLive(
  cfg: Config,
  profile: string,
  label: string,
  expectedReason: string,
): { status: "acted" | "blocked" | "failed"; reason: string } {
  if (isDry()) return recoverMountLiveUnlocked(cfg, profile, label, expectedReason);
  return withMountLock(profile, () => recoverMountLiveUnlocked(cfg, profile, label, expectedReason));
}

function recoverMountLiveUnlocked(
  cfg: Config,
  profile: string,
  label: string,
  expectedReason: string,
): { status: "acted" | "blocked" | "failed"; reason: string } {
  const current = collectMountHealth(cfg, profile).find((component) => component.id === `client.mount.${profile}.${label}`);
  if (!current || current.reason !== expectedReason || current.status !== "failed") {
    return { status: "blocked", reason: "mount_evidence_changed" };
  }
  if (expectedReason === "mount_absent") {
    try {
      runMountUpUnlocked(cfg, profile, label);
      return { status: "acted", reason: "mount_started" };
    } catch {
      return { status: "failed", reason: "mount_action_failed" };
    }
  }
  if (expectedReason !== "mount_disconnected_clean") {
    return { status: "blocked", reason: "mount_reason_not_recoverable" };
  }

  const plan = planMounts(cfg, profile).find((candidate) => candidate.label === label);
  const bridges = readBridges();
  const bridge = bridges.find((candidate) => candidate.profile === profile && candidate.label === label);
  if (!plan || !bridge || !bridge.mountNonce || bridgeOwnership(bridge, defaultMountProbeRunner) !== true) {
    return { status: "blocked", reason: "mount_ownership_changed" };
  }
  const unmount = defaultMountProbeRunner("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", plan.host,
    buildOwnedUnmountRemoteCmd(plan.remotePath, bridge.mountNonce),
  ]);
  if (unmount.status !== 0) return { status: "blocked", reason: "mount_busy_or_unknown" };

  if (assessBridgeProcesses(bridge).state !== "live") {
    return { status: "blocked", reason: "mount_ownership_changed" };
  }
  if (!stopOwnedBridgeProcesses(bridge).safe) {
    return { status: "blocked", reason: "mount_ownership_changed" };
  }
  writeBridges(bridges.filter((candidate) => candidate !== bridge));
  try {
    runMountUpUnlocked(cfg, profile, label);
    return { status: "acted", reason: "mount_restarted" };
  } catch {
    return { status: "failed", reason: "mount_action_failed" };
  }
}

/** Tear down lazy mounts. `label` undefined => all of the profile's mounts. */
export function runMountDown(cfg: Config, profile: string, label?: string): void {
  if (isDry()) return runMountDownUnlocked(cfg, profile, label);
  return withMountLock(profile, () => runMountDownUnlocked(cfg, profile, label));
}

function runMountDownUnlocked(cfg: Config, profile: string, label?: string): void {
  const host = hostFor(cfg, profile);
  const all = reconcileBridges();
  const victims = all.filter((m) => m.profile === profile && (!label || m.label === label));
  if (!victims.length) return void out(`devbox: no live mounts to remove for "${profile}"${label ? ` (${label})` : ""}`);
  for (const m of victims) {
    if (isDry()) { out(`  ── would unmount ${host}:${m.remotePath} (kill ${m.sshPid}, ${m.rclonePid})`); continue; }
    if (assessBridgeProcesses(m).state !== "live") {
      die(`could not prove process ownership for ${m.label}; mount was left unchanged`);
    }
    if (!m.mountNonce) {
      die(`could not prove mount identity for ${m.label}; mount was left unchanged`);
    }
    const unmount = spawnSync("ssh", ["-o", "BatchMode=yes", host,
      `${buildOwnedUnmountRemoteCmd(m.remotePath, m.mountNonce)} && rm -f /home/${profile}/.cache/devbox-bridge/${m.label}.key`]);
    if (unmount.status !== 0) {
      die(`could not safely unmount ${m.label}; it may be busy, so its processes were left running`);
    }
    if (assessBridgeProcesses(m).state !== "live") {
      die(`could not prove process ownership for ${m.label}; no processes were signalled`);
    }
    if (!stopOwnedBridgeProcesses(m).safe) {
      die(`process ownership changed while removing ${m.label}; state was retained`);
    }
    out(`  ✓ unmounted ${m.label}`);
  }
  writeBridges(all.filter((m) => !victims.includes(m)));
}

/** Print the live lazy mounts (after reconcile). */
export function runMountStatus(): void {
  return withMountLock("status", () => runMountStatusLocked());
}

function runMountStatusLocked(): void {
  const live = reconcileBridges();
  if (!live.length) return void out("devbox: no live lazy mounts");
  for (const m of live) out(`  ${m.profile}/${m.label}  ${m.localPath} -> ${m.remotePath}  (pid ssh ${m.sshPid})`);
}
