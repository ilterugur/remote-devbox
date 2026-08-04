import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientPayload, inspectClient } from "./run";
import type { ResolvedEntry } from "./registry";

const tmp = () => mkdtempSync(join(tmpdir(), "app-configs-"));

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
