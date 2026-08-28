import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMountLock } from "./mount-lock";

describe("mount lifecycle lock", () => {
  test("refuses a concurrent owner and releases only its own token", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mount-lock-")), "work.lock");
    const identities = new Map([[process.pid, "this-birth|devbox mount up"]]);
    const first = acquireMountLock(path, (pid) => identities.get(pid) ?? null);
    expect(() => acquireMountLock(path, (pid) => identities.get(pid) ?? null))
      .toThrow(/mount lifecycle already running/);
    first();
    expect(() => acquireMountLock(path, (pid) => identities.get(pid) ?? null)).not.toThrow();
  });

  test("recovers a lock only when the recorded owner is proven gone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mount-lock-")), "work.lock");
    writeFileSync(path, JSON.stringify({ pid: 12345, identity: "old-birth|devbox mount up", token: "old" }));
    expect(() => acquireMountLock(path, (pid) => pid === process.pid ? "current" : undefined))
      .toThrow(/ownership is unknown/);
    const stale = acquireMountLock(path, (pid) => pid === process.pid ? "current" : null);
    stale();
  });

  test("refuses parseable lock state with an invalid owner shape", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mount-lock-")), "work.lock");
    writeFileSync(path, JSON.stringify({ pid: "12345", identity: "old", token: "old" }));
    expect(() => acquireMountLock(path, () => "current")).toThrow(/ownership is unknown/);
  });
});
