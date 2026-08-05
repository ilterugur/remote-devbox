import { expect, test } from "bun:test";
import { mergeZedSettings, renderKeys, zedConnections } from "./editors";
import type { Config } from "./config";

const cfg: Config = {
  prefix: "devbox",
  default: "dev-a",
  locale: "en_US.UTF-8",
  launch: "",
  profiles: [
    { user: "dev-a", projects: [{ name: "main-app" }, { name: "side" }] },
    { user: "dev-b", projects: [] },
  ],
};

test("one Zed connection per profile, projects under their box paths", () => {
  expect(zedConnections(cfg)).toEqual([
    {
      host: "devbox-dev-a",
      nickname: "remote-devbox · dev-a",
      projects: [{ paths: ["~/projects/main-app"] }, { paths: ["~/projects/side"] }],
    },
    { host: "devbox-dev-b", nickname: "remote-devbox · dev-b", projects: [] },
  ]);
});

test("a hand-added connection to another host survives the merge", () => {
  const merged = mergeZedSettings(
    { theme: "One Dark", ssh_connections: [{ host: "prod-jump", projects: [] }] },
    cfg,
  );
  expect(merged.theme).toBe("One Dark");
  expect((merged.ssh_connections as { host: string }[]).map((c) => c.host)).toEqual([
    "prod-jump",
    "devbox-dev-a",
    "devbox-dev-b",
  ]);
});

test("our own stale entries are replaced, not duplicated", () => {
  const once = mergeZedSettings({}, cfg);
  const twice = mergeZedSettings(once, cfg);
  expect(twice.ssh_connections).toEqual(once.ssh_connections);
});

test("a settings file with no ssh_connections at all is fine", () => {
  expect((mergeZedSettings({ theme: "x" }, cfg).ssh_connections as unknown[]).length).toBe(2);
});

test("modifiers print in the order macOS renders them, not the order they are typed", () => {
  expect(renderKeys("@~w")).toBe("⌥⌘W");
});
