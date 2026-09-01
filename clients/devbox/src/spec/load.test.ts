import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec, writeGeneratedVars } from "./load";

export const EXAMPLE_CONFIG = join(import.meta.dir, "..", "..", "..", "..", "devbox.example.yml");

const write = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-spec-"));
  const path = join(dir, "devbox.yml");
  writeFileSync(path, body);
  return path;
};

test("a missing file is an issue, not a throw", () => {
  const r = loadSpec("/nonexistent/devbox.yml");
  expect(r.resolved).toBeNull();
  expect(r.issues[0]!.message).toContain("not found");
});

test("malformed YAML is an issue, not a throw", () => {
  const r = loadSpec(write("developers: [\n  - broken: : :\n"));
  expect(r.resolved).toBeNull();
  expect(r.issues[0]!.path).toBe("");
});

test("a reference error stops the pipeline before resolution", () => {
  const r = loadSpec(
    write(`config_version: 3
platform: {distribution: ubuntu, version: "26.04", architecture: amd64}
operator: {user: devbox-admin, ssh_authorized_keys: ["ssh-ed25519 AAAA k@c"]}
network: {tailscale: {enabled: true}, ssh: {access: [public, tailnet]}}
container: {default_engine: podman-rootless, install_engines: [podman-rootless]}
developers:
  - user: dev-a
    login_ssh_keys: ["ssh-ed25519 AAAA k@c"]
    git_identities: {work: {name: N, email: e@example.com}}
    default_git_identity: nope
`),
  );
  expect(r.resolved).toBeNull();
  expect(r.issues.map((i) => i.path)).toContain("developers[0].default_git_identity");
});

test("the committed devbox.example.yml resolves with no errors", () => {
  const r = loadSpec(EXAMPLE_CONFIG);
  expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(r.resolved!.developers.length).toBeGreaterThan(0);
});

test("the example uses the public OpenCode Zen model as the final OMP fallback", () => {
  const profile = loadSpec(EXAMPLE_CONFIG).resolved!.developers
    .flatMap((developer) => Object.values(developer.agent_profiles ?? {}))
    .find((candidate) => candidate.provider === "omp");
  const chains = Object.values(profile?.omp_model_presets?.retry?.fallback_chains ?? {});

  expect(chains.length).toBeGreaterThan(0);
  expect(chains.every((chain) => chain.at(-1) === "opencode-zen/mimo-v2.5-free")).toBe(true);
});

test("the example tiers OMP roles across balanced, provider-pure, and economical presets", () => {
  const profile = loadSpec(EXAMPLE_CONFIG).resolved!.developers
    .flatMap((developer) => Object.values(developer.agent_profiles ?? {}))
    .find((candidate) => candidate.provider === "omp");

  expect(profile?.omp_model_presets?.aliases).toEqual({
    codex: "openai",
    claude: "anthropic",
  });
  expect(profile?.omp_model_presets?.presets).toEqual({
    balanced: {
      default: "openai-codex/gpt-5.6-sol:medium",
      smol: "opencode-go/gpt-5.6-luna:medium",
      slow: "anthropic/claude-fable-5:xhigh",
      vision: "anthropic/claude-sonnet-5:high",
      plan: "anthropic/claude-opus-5:high",
      designer: "anthropic/claude-sonnet-5:high",
      commit: "opencode-go/gpt-5.6-luna:medium",
      tiny: "opencode-go/mimo-v2.5:low",
      task: "openai-codex/gpt-5.6-terra",
      advisor: "anthropic/claude-opus-5:high",
    },
    openai: {
      default: "openai-codex/gpt-5.6-sol:medium",
      smol: "opencode-go/gpt-5.6-luna:medium",
      slow: "openai-codex/gpt-5.6-sol:xhigh",
      vision: "openai-codex/gpt-5.6-terra:high",
      plan: "openai-codex/gpt-5.6-sol:high",
      designer: "openai-codex/gpt-5.6-terra:high",
      commit: "opencode-go/gpt-5.6-luna:medium",
      tiny: "opencode-go/gpt-5.6-luna:low",
      task: "openai-codex/gpt-5.6-terra",
      advisor: "openai-codex/gpt-5.6-sol:high",
    },
    anthropic: {
      default: "anthropic/claude-opus-5:high",
      smol: "anthropic/claude-haiku-4-5:medium",
      slow: "anthropic/claude-fable-5:xhigh",
      vision: "anthropic/claude-sonnet-5:high",
      plan: "anthropic/claude-opus-5:high",
      designer: "anthropic/claude-sonnet-5:high",
      commit: "anthropic/claude-haiku-4-5:medium",
      tiny: "anthropic/claude-haiku-4-5:low",
      task: "anthropic/claude-sonnet-5",
      advisor: "anthropic/claude-opus-5:high",
    },
    opencode: {
      default: "opencode-go/deepseek-v4-pro:max",
      smol: "opencode-go/gpt-5.6-luna:medium",
      slow: "opencode-go/kimi-k3:max",
      vision: "opencode-go/deepseek-v4-flash-vision-exp:max",
      plan: "opencode-go/kimi-k3:max",
      designer: "opencode-go/kimi-k3:high",
      commit: "opencode-go/gpt-5.6-luna:medium",
      tiny: "opencode-go/mimo-v2.5:low",
      task: "opencode-go/deepseek-v4-flash:max",
      advisor: "opencode-go/kimi-k3:max",
    },
    cursor: {
      default: "cursor/composer-2.5:inherit",
      smol: "cursor/grok-4.6:high",
      slow: "cursor/claude-opus-5-thinking-xhigh:inherit",
      vision: "cursor/gemini-3.1-pro:high",
      plan: "cursor/claude-opus-5-high:inherit",
      designer: "cursor/claude-sonnet-5-high:inherit",
      commit: "cursor/composer-2.5:inherit",
      tiny: "cursor/gpt-5.4-nano:low",
      task: "cursor/gpt-5.6-terra",
      advisor: "cursor/claude-opus-5-high:inherit",
    },
  });
});

test("the example's overrides resolve the way the comments claim", () => {
  const devs = loadSpec(EXAMPLE_CONFIG).resolved!.developers;
  const byName = (user: string, project: string) =>
    devs.find((d) => d.user === user)!.projects.find((p) => p.name === project)!;

  expect(byName("dev-a", "main-app")).toMatchObject({
    git_identity: "work",
    agent_profile: "claude-work",
    container_engine: "podman-rootless",
    memory_space: "shared",
  });
  expect(byName("dev-a", "side-project")).toMatchObject({
    git_identity: "personal",
    agent_profile: "claude-personal",
    memory_space: "personal",
  });
  expect(byName("dev-a", "legacy-service").container_engine).toBe("docker-rootless");
  expect(byName("dev-a", "scratch")).toMatchObject({ memory_space: null, container_engine: "none" });
  // dev-b declares exactly one identity and one profile: both are inferred.
  expect(byName("dev-b", "main-app")).toMatchObject({
    git_identity: "work",
    agent_profile: "claude-main",
    memory_space: null,
  });
});

test("writeGeneratedVars lands in ansible/.generated/all.yml and parses", () => {
  const { resolved } = loadSpec(EXAMPLE_CONFIG);
  const root = mkdtempSync(join(tmpdir(), "devbox-root-"));
  const path = writeGeneratedVars(resolved!, root);
  expect(path).toBe(join(root, "ansible", ".generated", "all.yml"));
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(parsed.devbox_config_version).toBe(3);
  expect((parsed.devbox_developers as unknown[]).length).toBe(2);
});
