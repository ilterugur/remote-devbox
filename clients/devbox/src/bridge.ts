/**
 * bridge.ts — shared state + pure helpers for the devbox file bridge (lazy mounts
 * now; sync reuses the path helpers). Live lazy mounts are tracked in
 * ~/.config/claude-devbox/bridges.json; sync sessions are owned by the engine and
 * are NOT duplicated here.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cfgDir } from "./config";

export const bridgesPath = (): string => join(cfgDir(), "bridges.json");

/** Expand a leading ~, resolve to an absolute, normalized path, strip trailing slash. */
export function normalizePath(p: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  const abs = resolve(expanded);
  return abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs;
}

/** True if a and b are equal or one contains the other (at a path boundary). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (x === y) return true;
  const within = (parent: string, child: string) => child.startsWith(parent === "/" ? "/" : parent + "/");
  return within(x, y) || within(y, x);
}

export type LiveMount = {
  profile: string;
  label: string;
  tunnelPort: number;
  rclonePid: number;
  sshPid: number;
  remotePath: string;
  localPath: string;
  /** Exact `ps` birth-time + argv fingerprint. Missing only on legacy state. */
  rcloneIdentity?: string;
  sshIdentity?: string;
  mountNonce?: string;
  createdAt: string;
};

export function readBridges(path: string = bridgesPath()): LiveMount[] {
  if (!existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(v) || !v.every((entry) => isLiveMount(entry))) {
      throw new Error("bridge state has an invalid shape");
    }
    return v as LiveMount[];
  } catch (error) {
    throw new Error(`invalid bridge state at ${path}: ${(error as Error).message}`);
  }
}

function isLiveMount(value: unknown): value is LiveMount {
  if (!value || typeof value !== "object") return false;
  const mount = value as Record<string, unknown>;
  return ["profile", "label", "remotePath", "localPath", "createdAt"]
    .every((key) => typeof mount[key] === "string")
    && ["tunnelPort", "rclonePid", "sshPid"].every((key) =>
      typeof mount[key] === "number" && Number.isSafeInteger(mount[key]))
    && (mount.rcloneIdentity === undefined || typeof mount.rcloneIdentity === "string")
    && (mount.sshIdentity === undefined || typeof mount.sshIdentity === "string")
    && (mount.mountNonce === undefined || typeof mount.mountNonce === "string");
}

export function writeBridges(list: LiveMount[], path: string = bridgesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

export type ProcessIdentityLookup = (pid: number) => string | null | undefined;
export type ProcessSignal = (pid: number) => void;

export const defaultProcessIdentity: ProcessIdentityLookup = (pid) => {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" });
  if (result.status === 1) return null;
  if (result.status !== 0) return undefined;
  const identity = result.stdout.trim();
  return identity || null;
};

export type BridgeProcessAssessment = {
  state: "live" | "stale" | "unknown";
  ownedPids: number[];
};

export function assessBridgeProcesses(
  bridge: LiveMount,
  lookup: ProcessIdentityLookup = defaultProcessIdentity,
): BridgeProcessAssessment {
  if (!bridge.rcloneIdentity || !bridge.sshIdentity) return { state: "unknown", ownedPids: [] };
  const rclone = lookup(bridge.rclonePid);
  const ssh = lookup(bridge.sshPid);
  if (rclone === undefined || ssh === undefined) return { state: "unknown", ownedPids: [] };
  const ownedPids = [
    ...(rclone === bridge.rcloneIdentity ? [bridge.rclonePid] : []),
    ...(ssh === bridge.sshIdentity ? [bridge.sshPid] : []),
  ];
  return { state: ownedPids.length === 2 ? "live" : "stale", ownedPids };
}

export function stopOwnedBridgeProcesses(
  bridge: LiveMount,
  lookup: ProcessIdentityLookup = defaultProcessIdentity,
  signal: ProcessSignal = (pid) => process.kill(pid),
): { safe: boolean; signalledPids: number[] } {
  let safe = true;
  const signalledPids: number[] = [];
  for (const [pid, expected] of [
    [bridge.rclonePid, bridge.rcloneIdentity],
    [bridge.sshPid, bridge.sshIdentity],
  ] as const) {
    if (!expected) { safe = false; continue; }
    const observed = lookup(pid);
    if (observed === null) continue;
    if (observed === undefined || observed !== expected) { safe = false; continue; }
    try { signal(pid); signalledPids.push(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") safe = false;
    }
  }
  return { safe, signalledPids };
}

/** Keep only exact live pairs; clean a surviving verified sibling before dropping stale state. */
export function reconcileBridges(
  path: string = bridgesPath(),
  lookup: ProcessIdentityLookup = defaultProcessIdentity,
  signal: ProcessSignal = (pid) => process.kill(pid),
): LiveMount[] {
  const kept = readBridges(path).filter((bridge) => {
    const assessment = assessBridgeProcesses(bridge, lookup);
    if (assessment.state === "live" || assessment.state === "unknown") return true;
    const stopped = stopOwnedBridgeProcesses(bridge, lookup, signal);
    // A signalled sibling remains tracked until a later pass proves it exited.
    // Unknown ownership or signal failure also retains state fail-closed.
    return !stopped.safe || stopped.signalledPids.length > 0;
  });
  writeBridges(kept, path);
  return kept;
}

/** The client-side sync "disk" root for a profile (~/devbox/<profile>). */
export const syncDiskRoot = (profile: string): string => join(homedir(), "devbox", profile);

/** Grab a free localhost TCP port by binding to :0 and reading the assigned port. */
export function freePort(): number {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  srv.close();
  if (!port) throw new Error("could not allocate a free TCP port");
  return port;
}
