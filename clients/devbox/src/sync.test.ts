import { describe, expect, test } from "bun:test";
import { decideSyncRecovery, recoverSync, syncHealthFromStatus } from "./sync";
import type { SyncStatus } from "./sync/engine";

const status = (state: string, conflicts: number | null): SyncStatus => ({
  name: "devbox-work",
  state,
  conflicts,
});

describe("syncHealthFromStatus", () => {
  test("maps active, disconnected, paused, and conflicted sessions", () => {
    expect(syncHealthFromStatus("work", status("Watching for changes", 0)).status).toBe("healthy");
    expect(syncHealthFromStatus("work", status("Disconnected", 0)).reason).toBe("sync_disconnected");
    expect(syncHealthFromStatus("work", status("paused", 0)).reason).toBe("sync_paused");
    expect(syncHealthFromStatus("work", status("Disconnected", 2))).toMatchObject({
      status: "blocked",
      reason: "sync_conflicts",
    });
  });

  test("unknown conflict evidence fails closed and names the session", () => {
    const result = syncHealthFromStatus("work", status("Disconnected", null));
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("sync_conflicts_unknown");
    expect(result.observed.join(" ")).toContain("devbox-work");
  });
});

describe("recoverSync", () => {
  test("runs only the bounded action selected with exactly zero conflicts", async () => {
    const actions: string[] = [];
    expect(await recoverSync(status("Disconnected", 0), {
      up: async (name) => { actions.push(`up:${name}`); },
      resume: async (name) => { actions.push(`resume:${name}`); },
    })).toEqual({ status: "recovered", reason: "sync_started" });
    expect(await recoverSync(status("paused", 0), {
      up: async (name) => { actions.push(`up:${name}`); },
      resume: async (name) => { actions.push(`resume:${name}`); },
    })).toEqual({ status: "recovered", reason: "sync_resumed" });
    expect(actions).toEqual(["up:devbox-work", "resume:devbox-work"]);
  });

  test("never mutates conflicts, unknown conflict counts, or an active session", async () => {
    for (const evidence of [
      status("Disconnected", 1),
      status("Disconnected", null),
      status("Watching for changes", 0),
    ]) {
      let called = false;
      const result = await recoverSync(evidence, {
        up: async () => { called = true; },
        resume: async () => { called = true; },
      });
      expect(called).toBe(false);
      expect(result.status).not.toBe("recovered");
    }
  });

  test("the pure decision table exposes the conflict boundary", () => {
    expect(decideSyncRecovery(status("Disconnected", 3))).toEqual({ action: "refuse", reason: "sync_conflicts" });
    expect(decideSyncRecovery(status("Disconnected", null))).toEqual({ action: "refuse", reason: "sync_conflicts_unknown" });
  });
});
