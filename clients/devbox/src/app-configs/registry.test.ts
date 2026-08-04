import { expect, test } from "bun:test";
import { REGISTRY, STORE_ROOT, payloadRelPath, resolveEntry, storeRelPath } from "./registry";
import { DEFAULT_IGNORES } from "../sync/engine";

test("a registry key resolves to the full entry", () => {
  const r = resolveEntry("filezilla");
  expect("entry" in r && r.entry).toEqual({
    label: "filezilla",
    client: "~/.config/filezilla",
    box: "~/.config/filezilla",
    mode: "dir",
    excludes: ["queue.sqlite3", "*.lock"],
  });
});

test("an unknown key lists the registry", () => {
  const r = resolveEntry("cyberduck");
  expect("error" in r && r.error).toContain(Object.keys(REGISTRY).join(", "));
});

test("an object entry is used verbatim", () => {
  const r = resolveEntry({ label: "dbeaver", client: "~/a", box: "~/b", mode: "dir" });
  expect("entry" in r && r.entry.excludes).toEqual([]);
});

test("an object entry missing a field is rejected", () => {
  const r = resolveEntry({ label: "dbeaver", client: "~/a" });
  expect("error" in r && r.error).toContain("box");
});

test("an object entry overrides a registry key of the same label", () => {
  const r = resolveEntry({ label: "filezilla", client: "~/custom", box: "~/.config/filezilla", mode: "dir" });
  expect("entry" in r && r.entry.client).toBe("~/custom");
});

test("store and payload paths", () => {
  const fz = (resolveEntry("filezilla") as any).entry;
  const ssh = (resolveEntry("ssh_config") as any).entry;
  expect(storeRelPath(fz)).toBe(".app-configs/filezilla");
  expect(payloadRelPath(ssh)).toBe(".app-configs/ssh_config/config");
});

test("the store is not swallowed by the sync engine's ignore list", () => {
  // A pattern matching .app-configs would silently stop every app config from syncing.
  const segments = STORE_ROOT.split("/");
  for (const pattern of DEFAULT_IGNORES) {
    const re = new RegExp("^" + pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$");
    expect(segments.some((s) => re.test(s))).toBe(false);
  }
});
