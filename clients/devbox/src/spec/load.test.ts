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
network: {tailscale: {enabled: true}, ssh: {exposure: public_and_tailscale}}
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
    agent_profile: "claude",
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
