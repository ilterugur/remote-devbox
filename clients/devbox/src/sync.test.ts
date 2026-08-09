import { describe, expect, test } from "bun:test";
import {
  appConfigIgnores,
  decideSyncRecovery,
  planSync,
  recoverSync,
  recoverSyncLive,
  collectSyncHealth,
  syncHealthFromStatus,
} from "./sync";
import { resolveEntry } from "./app-configs/registry";
import { DEFAULT_IGNORES, type SyncStatus } from "./sync/engine";
import type { Config } from "./config";
import type { SyncEngine } from "./sync/engine";

const entry = (key: string) => (resolveEntry(key) as { entry: any }).entry;

const base: Config = {
  prefix: "devbox", default: "work", locale: "en_US.UTF-8", launch: "claude",
  profiles: [{ user: "work", projects: [], syncDisk: true, syncEngine: "mutagen" }],
};

const status = (state: string, conflicts: number | null): SyncStatus => ({
  name: "devbox-work",
  state,
  conflicts,
});

describe("planSync", () => {
  test("derives disk root, remote root, host, engine", () => {
    const p = planSync(base, "work");
    expect(p.localRoot.endsWith("/devbox/work")).toBe(true);
    expect(p.remoteRoot).toBe("/home/work/sync");
    expect(p.host).toBe("devbox-work");
    expect(p.engine).toBe("mutagen");
  });
  test("rejects when sync disk disabled", () => {
    const off: Config = { ...base, profiles: [{ user: "work", projects: [] }] };
    expect(() => planSync(off, "work")).toThrow(/sync disk is not enabled/);
  });
  test("rejects a lazy mount that overlaps the disk", () => {
    const bad: Config = { ...base, profiles: [{ user: "work", projects: [], syncDisk: true,
      lazyMounts: [{ label: "x", path: "~/devbox/work/inner" }] }] };
    expect(() => planSync(bad, "work")).toThrow(/overlaps the sync disk/);
  });
});

describe("appConfigIgnores", () => {
  const withApps: Config = {
    ...base,
    profiles: [{ user: "work", projects: [], syncDisk: true, syncEngine: "mutagen",
      appConfigs: [entry("filezilla"), entry("ssh_config")] }],
  };

  test("anchors each entry's excludes to its store path", () => {
    // Registry excludes only guard the seed; the session has to ignore them too, or the
    // app writes them straight into the store on its next run and they propagate.
    expect(appConfigIgnores(withApps, "work")).toEqual([
      "/.app-configs/filezilla/queue.sqlite3",
      "/.app-configs/filezilla/lockfile",
      "/.app-configs/filezilla/*.lock",
    ]);
  });

  test("an entry with no excludes contributes nothing", () => {
    expect(appConfigIgnores(withApps, "work").some((p) => p.includes("ssh_config"))).toBe(false);
  });

  test("no app configs means no extra patterns", () => {
    expect(appConfigIgnores(base, "work")).toEqual([]);
  });

  test("planSync folds them in alongside the defaults", () => {
    const p = planSync(withApps, "work");
    for (const d of DEFAULT_IGNORES) expect(p.ignores).toContain(d);
    expect(p.ignores).toContain("/.app-configs/filezilla/queue.sqlite3");
    expect(planSync(base, "work").ignores).toEqual([...DEFAULT_IGNORES]);
  });
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

  test("collects only the profile's exact engine session and fails closed when absent", async () => {
    const engine = (rows: SyncStatus[]): SyncEngine => ({
      id: "mutagen",
      up: async () => {}, down: async () => {}, pause: async () => {}, resume: async () => {},
      status: async () => rows,
    });
    expect((await collectSyncHealth(base, "work", engine([
      { name: "devbox-other", state: "Watching", conflicts: 0 },
      status("Watching", 0),
    ])))?.status).toBe("healthy");
    expect(await collectSyncHealth(base, "work", engine([]))).toMatchObject({
      status: "unknown",
      reason: "sync_session_missing",
    });
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

  test("live recovery re-probes the exact named session before resuming it", async () => {
    const calls: string[] = [];
    const engine: SyncEngine = {
      id: "mutagen",
      up: async () => { calls.push("up"); },
      down: async () => {},
      pause: async () => {},
      resume: async (profile) => { calls.push(`resume:${profile}`); },
      status: async () => [status("Disconnected", 0)],
    };
    expect(await recoverSyncLive(base, "work", "sync_disconnected", engine)).toEqual({
      status: "acted", reason: "sync_started",
    });
    expect(calls).toEqual(["resume:work"]);
    expect(await recoverSyncLive(base, "work", "sync_paused", engine)).toEqual({
      status: "blocked", reason: "sync_evidence_changed",
    });
  });
});
