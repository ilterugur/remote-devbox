import { describe, expect, test } from "bun:test";
import { appConfigIgnores, planSync } from "./sync";
import { resolveEntry } from "./app-configs/registry";
import { DEFAULT_IGNORES } from "./sync/engine";
import type { Config } from "./config";

const entry = (key: string) => (resolveEntry(key) as { entry: any }).entry;

const base: Config = {
  prefix: "devbox", default: "work", locale: "en_US.UTF-8", launch: "claude",
  profiles: [{ user: "work", projects: [], syncDisk: true, syncEngine: "mutagen" }],
};

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
