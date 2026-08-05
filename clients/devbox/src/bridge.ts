/**
 * bridge.ts — shared state + pure helpers for the devbox file bridge (lazy mounts
 * now; sync reuses the path helpers). Live lazy mounts are tracked in
 * ~/.config/claude-devbox/bridges.json; sync sessions are owned by the engine and
 * are NOT duplicated here.
 */
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  createdAt: string;
};

export function readBridges(path: string = bridgesPath()): LiveMount[] {
  if (!existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(v) ? (v as LiveMount[]) : [];
  } catch {
    return [];
  }
}

export function writeBridges(list: LiveMount[], path: string = bridgesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

/** Drop entries whose rclone OR ssh process has died, persist, and return survivors. */
export function reconcileBridges(path: string = bridgesPath()): LiveMount[] {
  const kept = readBridges(path).filter((m) => pidAlive(m.rclonePid) && pidAlive(m.sshPid));
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
