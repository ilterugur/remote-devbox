import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSecrets, loadSecrets, validateSecretRefs, writeGeneratedSecrets } from "./secrets";
import type { ResolvedSpec } from "./types";

const write = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-secrets-"));
  const path = join(dir, "devbox.secrets.yml");
  writeFileSync(path, body);
  return path;
};

test("a missing secrets file is not an error", () => {
  expect(loadSecrets("/nonexistent/devbox.secrets.yml")).toEqual({ secrets: {}, issues: [] });
});

test("scalars load, nested values are rejected", () => {
  const r = loadSecrets(write("OPENROUTER_API_KEY: sk-or-x\nPORT: 9077\nNESTED: {a: 1}\n"));
  expect(r.secrets).toEqual({ OPENROUTER_API_KEY: "sk-or-x", PORT: "9077" });
  expect(r.issues.map((i) => i.path)).toEqual(["NESTED"]);
});

test("an empty file is an empty secret set", () => {
  expect(loadSecrets(write("")).secrets).toEqual({});
});

const spec = (apiKeyEnv?: string): ResolvedSpec => ({
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: ["ssh-ed25519 AAAA k@c"] },
  network: { tailscale: { enabled: true }, ssh: { access: ["public", "tailnet"] } },
  container: { default_engine: "none", install_engines: ["none"] },
  developers: [
    {
      user: "dev-a",
      login_ssh_keys: [],
      memory: {
        enabled: true,
        instances: { primary: { engine: "hindsight", llm_provider: "openrouter", api_key_env: apiKeyEnv } },
        spaces: {},
      },
      projects: [],
    },
  ],
});

test("a referenced secret that is missing is a warning, not an error", () => {
  const issues = validateSecretRefs(spec("OPENROUTER_API_KEY"), {});
  expect(issues).toHaveLength(1);
  expect(issues[0]!.severity).toBe("warning");
  expect(issues[0]!.path).toBe("developers[0].memory.instances.primary.api_key_env");
});

test("a satisfied reference produces nothing", () => {
  expect(validateSecretRefs(spec("OPENROUTER_API_KEY"), { OPENROUTER_API_KEY: "sk" })).toEqual([]);
  expect(validateSecretRefs(spec(undefined), {})).toEqual([]);
});

test("every enabled desktop requires its normalized managed password hash", () => {
  const resolved = spec(undefined);
  resolved.developers = [
    {
      ...resolved.developers[0]!,
      user: "dev-a",
      desktop: { enabled: true, environment: "xfce", transport: "xrdp", access: ["tunnel"] },
    },
    {
      ...resolved.developers[0]!,
      user: "dev-b-test",
      desktop: { enabled: true, environment: "xfce", transport: "xrdp", access: ["tailnet"] },
    },
  ];

  const issues = validateSecretRefs(resolved, {});

  expect(issues.map((issue) => [issue.severity, issue.path])).toEqual([
    ["error", "developers[0].desktop"],
    ["error", "developers[1].desktop"],
  ]);
  expect(issues.map((issue) => issue.message)).toEqual([
    "'RDP_PASSWORD_HASH_DEV_A' is required when desktop.enabled is true",
    "'RDP_PASSWORD_HASH_DEV_B_TEST' is required when desktop.enabled is true",
  ]);
});

test("desktop secret validation never exposes secret values", () => {
  const resolved = spec(undefined);
  resolved.developers[0]!.desktop = {
    enabled: true,
    environment: "xfce",
    transport: "xrdp",
    access: ["tunnel"],
  };

  const marker = "SECRET_HASH_MUST_NOT_APPEAR";
  const issues = validateSecretRefs(resolved, { UNRELATED_SECRET: marker });

  expect(JSON.stringify(issues)).not.toContain(marker);
});

test("disabled desktops do not require a password hash", () => {
  const resolved = spec(undefined);
  resolved.developers[0]!.desktop = { enabled: false, environment: "xfce", transport: "xrdp" };

  expect(validateSecretRefs(resolved, {})).toEqual([]);
});

test("a present desktop password hash satisfies the requirement", () => {
  const resolved = spec(undefined);
  resolved.developers[0]!.desktop = {
    enabled: true,
    environment: "xfce",
    transport: "xrdp",
    access: ["tunnel"],
  };

  expect(validateSecretRefs(resolved, { RDP_PASSWORD_HASH_DEV_A: "$6$hash" })).toEqual([]);
});

test("describeSecrets exposes names only, sorted", () => {
  expect(describeSecrets({ B: "2", A: "1" })).toEqual(["A", "B"]);
});

test("the generated secrets file is written 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "devbox-root-"));
  const path = writeGeneratedSecrets({ TAILSCALE_AUTHKEY: "tskey-x" }, root);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(parsed.devbox_secrets).toEqual({ TAILSCALE_AUTHKEY: "tskey-x" });
});
