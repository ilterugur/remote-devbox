import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfgDir } from "./config";
import { defaultProcessIdentity, type ProcessIdentityLookup } from "./bridge";

type LockOwner = { pid: number; identity: string; token: string };

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.identity === "string" && owner.identity.length > 0
    && typeof owner.token === "string" && owner.token.length > 0;
}

export function mountLockPath(profile: string): string {
  void profile;
  // bridges.json is shared by every profile, so lifecycle/state mutation is global.
  return join(cfgDir(), "mount-locks", "bridges.lock");
}

export function acquireMountLock(
  path: string,
  lookup: ProcessIdentityLookup = defaultProcessIdentity,
): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const identity = lookup(process.pid);
  if (!identity) throw new Error("current mount lifecycle ownership is unknown");
  const owner: LockOwner = { pid: process.pid, identity, token: randomUUID() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(owner) + "\n"); } finally { closeSync(fd); }
      return () => {
        try {
          const current = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
          if (current.token === owner.token) unlinkSync(path);
        } catch { /* already released or replaced */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LockOwner;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isLockOwner(parsed)) throw new Error("invalid lock shape");
        existing = parsed;
      }
      catch { throw new Error("mount lifecycle lock ownership is unknown"); }
      const observed = lookup(existing.pid);
      if (observed === undefined) throw new Error("mount lifecycle lock ownership is unknown");
      if (observed === existing.identity) throw new Error("mount lifecycle already running");
      if (observed !== null) throw new Error("mount lifecycle lock ownership changed");
      try { unlinkSync(path); } catch { /* another contender won; retry create */ }
    }
  }
  throw new Error("could not acquire mount lifecycle lock");
}

export function withMountLock<T>(profile: string, action: () => T): T {
  const release = acquireMountLock(mountLockPath(profile));
  try { return action(); } finally { release(); }
}
