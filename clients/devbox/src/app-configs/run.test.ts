import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clientPayload, countSyncConflicts, inspectClient, linkClient, matches, runConfigStatus, runConfigUnlink, seedEmpty, seedFromClient, unlinkClient } from "./run";
import type { ResolvedEntry } from "./registry";
import type { Config } from "../config";

const tmp = () => mkdtempSync(join(tmpdir(), "app-configs-"));

// linkClient/seedFromClient resolve their store path against the real syncDiskRoot()
// (homedir-anchored — there is no injection point for it), so these tests use a
// throwaway, uniquely-named "profile" under ~/devbox and always clean it up.
const testProfile = () => `app-configs-test-${Math.random().toString(36).slice(2)}`;
const cleanupProfile = (profile: string) => rmSync(join(homedir(), "devbox", profile), { recursive: true, force: true });
const backupOf = (dir: string, base: string) => readdirSync(dir).filter((n) => n.startsWith(`${base}.pre-devbox-`));

/** Capture everything written to stdout while `fn` runs (restores the real write after). */
async function captureOut(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = process.stdout.write;
  process.stdout.write = ((s: string) => { lines.push(s); return true; }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = spy;
  }
  return lines;
}

const baseCfg = (profile: string): Config => ({
  prefix: "devbox", default: profile, locale: "C", launch: "", profiles: [{ user: profile, projects: [], appConfigs: [] }],
});

const dirEntry = (client: string): ResolvedEntry => ({
  label: "filezilla", client, box: "~/.config/filezilla", mode: "dir", excludes: ["queue.sqlite3", "*.lock"],
});

const genericDirEntry = (client: string): ResolvedEntry => ({
  label: "dbeaver", client, box: "~/.dbeaver", mode: "dir", excludes: [],
});

const sshEntry = (client: string): ResolvedEntry => ({
  label: "ssh_config", client, box: "~/.ssh/config", mode: "ssh-include", excludes: [],
});

describe("clientPayload", () => {
  test("dir mode points at the store folder itself", () => {
    const e = dirEntry("~/.config/filezilla");
    expect(clientPayload("work", e)).toMatch(/devbox\/work\/\.app-configs\/filezilla$/);
  });

  test("ssh-include mode points at the payload file inside the store folder", () => {
    const e = sshEntry("~/.ssh/config");
    expect(clientPayload("work", e)).toMatch(/devbox\/work\/\.app-configs\/ssh_config\/config$/);
  });
});

describe("inspectClient — dir mode", () => {
  test("absent when the client path does not exist", () => {
    const root = tmp();
    const e = genericDirEntry(join(root, "nope"));
    expect(inspectClient("work", e)).toEqual({ kind: "absent", summary: "" });
  });

  test("empty when the client dir exists but has nothing in it", () => {
    const root = tmp();
    const p = join(root, "cfg");
    mkdirSync(p);
    const e = genericDirEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "empty", summary: "" });
  });

  test("content, with a generic file-count summary for a non-filezilla label", () => {
    const root = tmp();
    const p = join(root, "cfg");
    mkdirSync(p);
    writeFileSync(join(p, "a.conf"), "x");
    writeFileSync(join(p, "b.conf"), "x");
    const e = genericDirEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "content", summary: "2 files" });
  });

  test("content, with a site-count summary for filezilla's sitemanager.xml", () => {
    const root = tmp();
    const p = join(root, "cfg");
    mkdirSync(p);
    writeFileSync(join(p, "sitemanager.xml"), "<Server>a</Server><Server>b</Server>");
    const e = dirEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "content", summary: "2 sites" });
  });

  test("linked when the symlink target matches the computed store payload path exactly", () => {
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    symlinkSync(clientPayload("work", e), p);
    expect(inspectClient("work", e)).toEqual({ kind: "linked", summary: "" });
  });

  test("foreign-link when the symlink points somewhere else, and reports the target", () => {
    const root = tmp();
    const p = join(root, "cfg");
    const elsewhere = join(root, "elsewhere");
    symlinkSync(elsewhere, p);
    const e = genericDirEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "foreign-link", summary: elsewhere });
  });
});

describe("inspectClient — ssh-include mode", () => {
  test("absent when the file does not exist", () => {
    const root = tmp();
    const e = sshEntry(join(root, "config"));
    expect(inspectClient("work", e)).toEqual({ kind: "absent", summary: "" });
  });

  test("empty when the file exists but has no Host lines", () => {
    const root = tmp();
    const p = join(root, "config");
    writeFileSync(p, "# nothing here\n");
    const e = sshEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "empty", summary: "" });
  });

  test("content with a host-count summary", () => {
    const root = tmp();
    const p = join(root, "config");
    writeFileSync(p, "Host foo\n  HostName 1.2.3.4\nhost bar\n  HostName 5.6.7.8\n");
    const e = sshEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "content", summary: "2 hosts" });
  });

  test("linked when the managed-block marker is present", () => {
    const root = tmp();
    const p = join(root, "config");
    writeFileSync(p, "# >>> devbox app-configs\nInclude /somewhere/config\n# <<< devbox app-configs\nHost foo\n");
    const e = sshEntry(p);
    expect(inspectClient("work", e)).toEqual({ kind: "linked", summary: "" });
  });
});

describe("matches", () => {
  test("a literal pattern matches only that exact basename", () => {
    expect(matches("/a/b/queue.sqlite3", "queue.sqlite3")).toBe(true);
    expect(matches("/a/b/other.sqlite3", "queue.sqlite3")).toBe(false);
  });

  test("a glob pattern matches by extension, on the basename only", () => {
    expect(matches("/a/b/file.lock", "*.lock")).toBe(true);
    expect(matches("/a/b/file.lock/nested", "*.lock")).toBe(false); // basename is "nested", not the dir itself
    expect(matches("/a/b/file.txt", "*.lock")).toBe(false);
  });
});

describe("seedFromClient", () => {
  test("copies content into the store honoring excludes, and renames the original aside — never deletes", () => {
    const profile = testProfile();
    const root = tmp();
    const src = join(root, "cfg");
    mkdirSync(src);
    writeFileSync(join(src, "sitemanager.xml"), "<Server>a</Server>");
    writeFileSync(join(src, "queue.sqlite3"), "queue-data");
    const e = dirEntry(src);
    try {
      seedFromClient(profile, e);
      const dst = clientPayload(profile, e);
      expect(existsSync(join(dst, "sitemanager.xml"))).toBe(true);
      expect(existsSync(join(dst, "queue.sqlite3"))).toBe(false); // excluded from the shared store

      expect(existsSync(src)).toBe(false); // moved out of the original location...
      const backups = backupOf(root, "cfg");
      expect(backups.length).toBe(1);
      // ...but nothing was deleted: the excluded file still exists in the backup.
      expect(readFileSync(join(root, backups[0]!, "queue.sqlite3"), "utf8")).toBe("queue-data");
    } finally {
      cleanupProfile(profile);
    }
  });
});

describe("linkClient — dir mode", () => {
  test("symlinks into the store and renames pre-existing real content aside (never deletes)", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    mkdirSync(p);
    writeFileSync(join(p, "a.txt"), "real content");
    const e = genericDirEntry(p);
    try {
      linkClient(profile, e);
      const target = clientPayload(profile, e);
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(readlinkSync(p)).toBe(target);
      expect(existsSync(target)).toBe(true); // "dir" mode pre-creates the target directory

      const backups = backupOf(root, "cfg");
      expect(backups.length).toBe(1);
      expect(readFileSync(join(root, backups[0]!, "a.txt"), "utf8")).toBe("real content"); // preserved, not deleted
    } finally {
      cleanupProfile(profile);
    }
  });

  test("leaves an already-correct symlink untouched — no rename, no re-creation", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    const target = clientPayload(profile, e);
    mkdirSync(target, { recursive: true });
    symlinkSync(target, p);
    try {
      linkClient(profile, e);
      expect(readlinkSync(p)).toBe(target);
      expect(backupOf(root, "cfg").length).toBe(0); // nothing renamed aside
    } finally {
      cleanupProfile(profile);
    }
  });

  test("renames a foreign symlink aside rather than deleting it", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const elsewhere = join(root, "elsewhere");
    symlinkSync(elsewhere, p);
    const e = genericDirEntry(p);
    try {
      linkClient(profile, e);
      const target = clientPayload(profile, e);
      expect(readlinkSync(p)).toBe(target); // now correctly linked

      const backups = backupOf(root, "cfg");
      expect(backups.length).toBe(1);
      // the foreign link itself was preserved (renamed), not deleted
      expect(lstatSync(join(root, backups[0]!)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(root, backups[0]!))).toBe(elsewhere);
    } finally {
      cleanupProfile(profile);
    }
  });
});

describe("countSyncConflicts", () => {
  test("0 when the store path does not exist", () => {
    const root = tmp();
    expect(countSyncConflicts(join(root, "nope"))).toBe(0);
  });

  test("0 when the store has no conflict files", () => {
    const root = tmp();
    const p = join(root, "store");
    mkdirSync(p);
    writeFileSync(join(p, "config"), "x");
    expect(countSyncConflicts(p)).toBe(0);
  });

  test("counts Syncthing-style *.sync-conflict-* siblings", () => {
    const root = tmp();
    const p = join(root, "store");
    mkdirSync(p);
    writeFileSync(join(p, "config"), "x");
    writeFileSync(join(p, "config.sync-conflict-20260101-120000-ABCDEFG"), "x");
    writeFileSync(join(p, "config.sync-conflict-20260102-120000-HIJKLMN"), "x");
    expect(countSyncConflicts(p)).toBe(2);
  });
});

describe("seedEmpty", () => {
  test("dir mode: creates the store directory itself", () => {
    const profile = testProfile();
    const e = genericDirEntry("/unused"); // client path is never touched by seedEmpty
    try {
      seedEmpty(profile, e);
      const target = clientPayload(profile, e);
      expect(existsSync(target)).toBe(true);
      expect(lstatSync(target).isDirectory()).toBe(true);
    } finally {
      cleanupProfile(profile);
    }
  });

  test("ssh-include mode: creates an empty payload FILE inside the store, not just the directory — " +
    "a literal (non-glob) Include line pointing at a missing file is a hard error for OpenSSH", () => {
    const profile = testProfile();
    const e = sshEntry("/unused");
    try {
      seedEmpty(profile, e);
      const target = clientPayload(profile, e);
      expect(existsSync(target)).toBe(true);
      expect(lstatSync(target).isFile()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("");
    } finally {
      cleanupProfile(profile);
    }
  });
});

describe("runConfigStatus", () => {
  test("reports the 'no app_configs declared' line and touches nothing else when none are configured", async () => {
    const cfg: Config = { prefix: "devbox", default: "work", locale: "C", launch: "", profiles: [{ user: "work", projects: [] }] };
    const lines = await captureOut(() => runConfigStatus(cfg, "work"));
    expect(lines).toEqual([`devbox: no app_configs declared for profile "work"\n`]);
  });

  test("dir mode: flags a missing target as store=MISSING with the data-loss warning", async () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    const target = clientPayload(profile, e); // never created — the store dir does not exist
    symlinkSync(target, p); // client-side symlink is correctly "linked" even though the target is dangling
    const cfg = baseCfg(profile);
    cfg.profiles[0]!.appConfigs = [e];
    try {
      const lines = (await captureOut(() => runConfigStatus(cfg, profile))).join("");
      expect(lines).toContain(`client=linked`);
      expect(lines).toContain(`store=MISSING`);
      expect(lines).toContain(`the link has no target — the app will write a fresh empty config`);
    } finally {
      cleanupProfile(profile);
    }
  });

  test("ssh-include mode: store=ok requires the payload FILE, not just the store directory — " +
    "this is the case Finding 1 caught: a store dir that exists but is empty must still read MISSING", async () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "config");
    const e = sshEntry(p);
    const target = clientPayload(profile, e); // .../.app-configs/ssh_config/config
    writeFileSync(p, `# >>> devbox app-configs\nInclude ${target}\n# <<< devbox app-configs\n`); // client-side: linked
    mkdirSync(join(homedir(), "devbox", profile, ".app-configs", "ssh_config"), { recursive: true }); // store DIR exists...
    // ...but the payload file inside it does not — the exact shape Finding 1 missed.
    expect(existsSync(target)).toBe(false);
    const cfg = baseCfg(profile);
    cfg.profiles[0]!.appConfigs = [e];
    try {
      const lines = (await captureOut(() => runConfigStatus(cfg, profile))).join("");
      expect(lines).toContain(`client=linked`);
      expect(lines).toContain(`store=MISSING`); // would have wrongly read "ok" before the fix
      expect(lines).toContain(`the link has no target — the app will write a fresh empty config`);
    } finally {
      cleanupProfile(profile);
    }
  });

  test("store=ok and no warning once the payload file actually exists", async () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "config");
    const e = sshEntry(p);
    const target = clientPayload(profile, e);
    writeFileSync(p, `# >>> devbox app-configs\nInclude ${target}\n# <<< devbox app-configs\n`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "Host foo\n");
    const cfg = baseCfg(profile);
    cfg.profiles[0]!.appConfigs = [e];
    try {
      const lines = (await captureOut(() => runConfigStatus(cfg, profile))).join("");
      expect(lines).toContain(`client=linked`);
      expect(lines).toContain(`store=ok`);
      expect(lines).not.toContain(`the link has no target`);
    } finally {
      cleanupProfile(profile);
    }
  });
});

describe("unlinkClient — dir mode", () => {
  test("replaces the symlink with a real directory copied from the store, leaving the store untouched", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    const target = clientPayload(profile, e);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "a.conf"), "real content");
    symlinkSync(target, p);
    try {
      const r = unlinkClient(profile, e);
      expect(r).toEqual({ restored: true });
      expect(lstatSync(p).isSymbolicLink()).toBe(false);
      expect(lstatSync(p).isDirectory()).toBe(true);
      expect(readFileSync(join(p, "a.conf"), "utf8")).toBe("real content");
      // the store itself is left alone — nothing was moved out of it
      expect(readFileSync(join(target, "a.conf"), "utf8")).toBe("real content");
    } finally {
      cleanupProfile(profile);
    }
  });

  test("missing store payload: leaves the symlink in place instead of deleting it and finding nothing to restore", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    const target = clientPayload(profile, e); // never created
    symlinkSync(target, p);
    try {
      const r = unlinkClient(profile, e);
      expect(r.restored).toBe(false);
      expect(r.reason).toContain("store payload is missing");
      expect(lstatSync(p).isSymbolicLink()).toBe(true); // untouched — nothing was destroyed
      expect(readlinkSync(p)).toBe(target);
    } finally {
      cleanupProfile(profile);
    }
  });
});

describe("unlinkClient — ssh-include mode", () => {
  test("folds the store payload's host entries back in and drops the managed block, byte-for-byte preserving the rest", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "config");
    const e = sshEntry(p);
    const target = clientPayload(profile, e);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "Host restored\n  HostName 9.9.9.9\n");
    writeFileSync(p, `# >>> devbox app-configs\nInclude ${target}\n# <<< devbox app-configs\nHost kept\n  HostName 1.2.3.4\n`);
    try {
      const r = unlinkClient(profile, e);
      expect(r).toEqual({ restored: true });
      const body = readFileSync(p, "utf8");
      expect(body).not.toContain("devbox app-configs");
      expect(body).toContain("Host restored");
      expect(body).toContain("HostName 9.9.9.9");
      expect(body).toContain("Host kept"); // content outside the managed block is preserved exactly
      expect(body).toContain("HostName 1.2.3.4");
    } finally {
      cleanupProfile(profile);
    }
  });

  test("missing store payload: still removes the Include block (nothing left to break) but reports the loss", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "config");
    const e = sshEntry(p);
    const target = clientPayload(profile, e); // never created
    writeFileSync(p, `# >>> devbox app-configs\nInclude ${target}\n# <<< devbox app-configs\nHost kept\n  HostName 1.2.3.4\n`);
    try {
      const r = unlinkClient(profile, e);
      expect(r.restored).toBe(false);
      expect(r.reason).toContain("store payload is missing");
      const body = readFileSync(p, "utf8");
      expect(body).not.toContain("devbox app-configs");
      expect(body).toContain("Host kept"); // pre-existing content outside the block still preserved
    } finally {
      cleanupProfile(profile);
    }
  });

  test("re-running after the block is already absent is a no-op that preserves the file", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "config");
    const e = sshEntry(p);
    writeFileSync(p, "Host kept\n  HostName 1.2.3.4\n");
    try {
      const r = unlinkClient(profile, e);
      expect(r.restored).toBe(false); // no payload either, but nothing to strip — same guard applies
      expect(readFileSync(p, "utf8")).toBe("Host kept\n  HostName 1.2.3.4\n");
    } finally {
      cleanupProfile(profile);
    }
  });
});

describe("runConfigUnlink", () => {
  test("reports the 'no app_configs declared' line and touches nothing else when none are configured", async () => {
    const cfg: Config = { prefix: "devbox", default: "work", locale: "C", launch: "", profiles: [{ user: "work", projects: [] }] };
    const lines = await captureOut(() => runConfigUnlink(cfg, "work"));
    expect(lines).toEqual([`devbox: no app_configs declared for profile "work"\n`]);
  });

  test("rejects an unknown --label instead of silently doing nothing", async () => {
    const profile = testProfile();
    const e = dirEntry("~/.config/filezilla");
    const cfg = baseCfg(profile);
    cfg.profiles[0]!.appConfigs = [e];
    await expect(runConfigUnlink(cfg, profile, "not-a-real-label")).rejects.toThrow(/unknown app config "not-a-real-label"/);
  });

  test("dry run previews the plan and touches no files", async () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    const target = clientPayload(profile, e);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "a.conf"), "x");
    symlinkSync(target, p);
    const cfg = baseCfg(profile);
    cfg.profiles[0]!.appConfigs = [e];
    process.env.DEVBOX_DRYRUN = "1";
    try {
      const lines = (await captureOut(() => runConfigUnlink(cfg, profile))).join("");
      expect(lines).toContain("dbeaver: restore");
      expect(lstatSync(p).isSymbolicLink()).toBe(true); // still a link — dry run changed nothing
    } finally {
      delete process.env.DEVBOX_DRYRUN;
      cleanupProfile(profile);
    }
  });

  test("a failed restore (missing store payload) never prints a success line for that entry", async () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "cfg");
    const e = genericDirEntry(p);
    const target = clientPayload(profile, e); // never created — the store payload is missing
    symlinkSync(target, p); // client-side: correctly "linked", so plan.action is "restore"
    const cfg = baseCfg(profile);
    cfg.profiles[0]!.appConfigs = [e];
    const lines: string[] = [];
    const spy = process.stdout.write;
    process.stdout.write = ((s: string) => { lines.push(s); return true; }) as typeof process.stdout.write;
    try {
      await runConfigUnlink(cfg, profile);
    } catch {
      // Expected: boxSh dies because the fake ssh alias (devbox-<profile>) is unreachable
      // in this test env — the client-side restore attempt and its output already
      // happened before that call, which is exactly what this test is checking.
    } finally {
      process.stdout.write = spy;
      cleanupProfile(profile);
    }
    const output = lines.join("");
    expect(output).toContain("! dbeaver: store payload is missing");
    expect(output).not.toContain("✓ dbeaver"); // the failure must not be followed by a success marker
    expect(lstatSync(p).isSymbolicLink()).toBe(true); // nothing was destroyed either
  });
});

describe("linkClient — ssh-include mode", () => {
  test("prepends the managed Include block without disturbing the rest of the file, and is idempotent", () => {
    const profile = testProfile();
    const root = tmp();
    const p = join(root, "config");
    writeFileSync(p, "Host existing\n  HostName 1.2.3.4\n");
    const e = sshEntry(p);
    try {
      linkClient(profile, e);
      const target = clientPayload(profile, e);
      const body = readFileSync(p, "utf8");
      expect(body).toContain("# >>> devbox app-configs");
      expect(body).toContain(`Include ${target}`);
      expect(body).toContain("# <<< devbox app-configs");
      expect(body).toContain("Host existing");
      expect(body).toContain("HostName 1.2.3.4");

      linkClient(profile, e); // idempotent: running again must not duplicate the block
      const body2 = readFileSync(p, "utf8");
      expect((body2.match(/>>> devbox app-configs/g) ?? []).length).toBe(1);
    } finally {
      cleanupProfile(profile);
    }
  });
});
