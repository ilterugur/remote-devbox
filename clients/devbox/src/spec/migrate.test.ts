import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacy, renderMigration } from "./migrate";
import { validateReferences } from "./references";
import { resolveSpec } from "./resolve";
import { validateStructure } from "./validate";

const KEY = "ssh-ed25519 AAAAC3Nz key@client";

const legacy = () => ({
  operator_user: "admin",
  operator_ssh_pubkey: KEY,
  tailscale_enabled: true,
  docker_enabled: true,
  hindsight_enabled: true,
  hindsight_llm_provider: "openrouter",
  hindsight_llm_model: "openai/gpt-oss-20b",
  rc_limits: { memory_high: "5G", memory_max: "6G", cpu_weight: 80 },
  profiles: [
    {
      user: "work",
      git_name: "N",
      git_email: "e@example.com",
      projects: [{ name: "app", repo: "git@github.com:example/app.git", branch: "main", ports: [3000] }],
      servers: [{ project: "app", name: "Work App", spawn: "worktree" }],
      sudo: true,
    },
  ],
});

test("a legacy profile becomes an adopted developer with one git identity", () => {
  const dev = migrateLegacy(legacy()).spec.developers[0]!;
  expect(dev.user).toBe("work");
  expect(dev.adopt_existing).toBe(true);
  expect(dev.login_ssh_keys).toEqual([KEY]);
  expect(dev.git_identities).toEqual({ default: { name: "N", email: "e@example.com" } });
  expect(dev.default_git_identity).toBe("default");
  expect(dev.agent_profiles).toEqual({ "claude-default": { provider: "claude" } });
  expect(dev.default_agent_profile).toBe("claude-default");
  expect(dev.resources).toEqual({ memory_high: "5G", memory_max: "6G", cpu_weight: 80 });
});

test("projects carry over with their branch and ports", () => {
  expect(migrateLegacy(legacy()).spec.developers[0]!.projects).toEqual([
    { name: "app", repo: "git@github.com:example/app.git", branch: "main", ports: [3000] },
  ]);
});

test("hindsight globals become one instance and one shared space per developer", () => {
  expect(migrateLegacy(legacy()).spec.developers[0]!.memory).toEqual({
    enabled: true,
    default_space: "shared",
    instances: { primary: { engine: "hindsight", llm_provider: "openrouter", llm_model: "openai/gpt-oss-20b" } },
    spaces: { shared: { instance: "primary", bank: "work-shared" } },
  });
});

test("hindsight_enabled false migrates to memory off", () => {
  const spec = migrateLegacy({ ...legacy(), hindsight_enabled: false }).spec;
  expect(spec.developers[0]!.memory).toEqual({ enabled: false, instances: {}, spaces: {} });
});

test("a codex profile gets its own agent profile", () => {
  const raw = legacy();
  const spec = migrateLegacy({ ...raw, profiles: [{ ...raw.profiles[0], agents: ["codex", "claude"] }] }).spec;
  expect(Object.keys(spec.developers[0]!.agent_profiles ?? {})).toEqual(["codex-default", "claude-default"]);
  expect(spec.developers[0]!.default_agent_profile).toBe("codex-default");
});

test("system docker becomes operator-owned shared services, not a developer engine", () => {
  const { spec } = migrateLegacy(legacy());
  expect(spec.shared_services).toEqual({ enabled: true, engine: "system-docker" });
  expect(spec.container.default_engine).toBe("podman-rootless");
});

test("profile sudo and servers are warned about, never dropped silently", () => {
  const paths = migrateLegacy(legacy()).issues.map((i) => i.path);
  expect(paths).toContain("profiles[0].sudo");
  expect(paths).toContain("profiles[0].servers");
});

test("the whole file bridge carries over — disk, engine and lazy mounts", () => {
  const raw = legacy();
  const result = migrateLegacy({
    ...raw,
    profiles: [
      {
        ...raw.profiles[0],
        sync_disk: true,
        lazy_mounts: [{ label: "d", path: "~/Desktop" }],
        lazy_mount_on_connect: true,
      },
    ],
  });
  // No warning any more: leaving these behind meant a migrated box silently lost the
  // mounts it had been serving.
  expect(result.issues.map((i) => i.path)).not.toContain("profiles[0].lazy_mounts");
  expect(result.spec.developers[0]!.file_bridge).toEqual({
    sync_disk: true,
    lazy_mounts: [{ label: "d", path: "~/Desktop" }],
    lazy_mount_on_connect: true,
  });
});

test("the migrated spec passes structural, reference and resolution validation", () => {
  const { spec } = migrateLegacy(legacy());
  const structural = validateStructure(JSON.parse(JSON.stringify(spec)));
  expect(structural.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(validateReferences(structural.spec!).filter((i) => i.severity === "error")).toEqual([]);
  expect(resolveSpec(structural.spec!).resolved).not.toBeNull();
});

test("the committed legacy example migrates cleanly", () => {
  const path = join(import.meta.dir, "..", "..", "..", "..", "ansible", "group_vars", "all.example.yml");
  const raw = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const { spec } = migrateLegacy(raw);
  const structural = validateStructure(JSON.parse(JSON.stringify(spec)));
  expect(structural.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(spec.developers.map((d) => d.user)).toEqual(["work"]);
});

test("renderMigration emits a reviewable document that parses back", () => {
  const { spec } = migrateLegacy(legacy());
  const text = renderMigration(spec);
  expect(text.startsWith("---\n# Migrated from a legacy group_vars/all.yml")).toBe(true);
  expect((Bun.YAML.parse(text) as Record<string, unknown>).config_version).toBe(3);
});
