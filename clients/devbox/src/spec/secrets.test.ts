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
