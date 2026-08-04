import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { clientPayload, inspectClient, linkClient, matches, seedFromClient } from "./run";
import type { ResolvedEntry } from "./registry";

const tmp = () => mkdtempSync(join(tmpdir(), "app-configs-"));

// linkClient/seedFromClient resolve their store path against the real syncDiskRoot()
// (homedir-anchored — there is no injection point for it), so these tests use a
// throwaway, uniquely-named "profile" under ~/devbox and always clean it up.
const testProfile = () => `app-configs-test-${Math.random().toString(36).slice(2)}`;
const cleanupProfile = (profile: string) => rmSync(join(homedir(), "devbox", profile), { recursive: true, force: true });
const backupOf = (dir: string, base: string) => readdirSync(dir).filter((n) => n.startsWith(`${base}.pre-devbox-`));

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
