import { expect, test } from "bun:test";
import { defaultDesktopAccess, defaultSshAccess, resolveSpec } from "./resolve";
import type { DeveloperSpec, DevboxSpec } from "./types";

const ID = { name: "N", email: "e@example.com" };
const INSTANCE = { engine: "hindsight", llm_provider: "openrouter" } as const;

const spec = (dev: Partial<DeveloperSpec>): DevboxSpec => ({
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: ["ssh-ed25519 AAAA k@c"] },
  network: { tailscale: { enabled: true }, ssh: { access: ["public", "tailnet"] } },
  container: { default_engine: "podman-rootless", install_engines: ["podman-rootless", "docker-rootless"] },
  developers: [{ user: "dev-a", login_ssh_keys: [], ...dev }],
});

const p0 = (s: DevboxSpec) => resolveSpec(s).resolved!.developers[0]!.projects[0]!;

test("a sole git identity is selected automatically", () => {
  expect(p0(spec({ git_identities: { work: ID }, projects: [{ name: "p", repo: "r" }] })).git_identity).toBe("work");
});

test("the developer default wins over 'sole identity' when several exist", () => {
  const s = spec({
    git_identities: { work: ID, personal: ID },
    default_git_identity: "personal",
    projects: [{ name: "p", repo: "r" }],
  });
  expect(p0(s).git_identity).toBe("personal");
});

test("a project override wins over the developer default", () => {
  const s = spec({
    git_identities: { work: ID, personal: ID },
    default_git_identity: "work",
    projects: [{ name: "p", repo: "r", git_identity: "personal" }],
  });
  expect(p0(s).git_identity).toBe("personal");
});

test("no identities at all means unmanaged git, not an error", () => {
  const r = resolveSpec(spec({ projects: [{ name: "p", repo: "r" }] }));
  expect(r.issues).toEqual([]);
  expect(r.resolved!.developers[0]!.projects[0]!.git_identity).toBeNull();
});

test("several identities with no default and no override is an error", () => {
  const r = resolveSpec(spec({ git_identities: { work: ID, personal: ID }, projects: [{ name: "p", repo: "r" }] }));
  expect(r.resolved).toBeNull();
  expect(r.issues.map((i) => i.path)).toContain("developers[0].projects[0].git_identity");
});

test("agent profile follows the same chain", () => {
  const s = spec({
    agent_profiles: { a: { provider: "claude" }, b: { provider: "codex" } },
    default_agent_profile: "b",
    projects: [{ name: "p", repo: "r" }],
  });
  expect(p0(s).agent_profile).toBe("b");
});

test("no agent profiles means agents are off for the project", () => {
  expect(p0(spec({ projects: [{ name: "p", repo: "r" }] })).agent_profile).toBeNull();
});

test("container engine falls back through developer to global default", () => {
  expect(p0(spec({ projects: [{ name: "p", repo: "r" }] })).container_engine).toBe("podman-rootless");
  expect(
    p0(spec({ container_engine: "docker-rootless", projects: [{ name: "p", repo: "r" }] })).container_engine,
  ).toBe("docker-rootless");
  expect(
    p0(spec({ container_engine: "docker-rootless", projects: [{ name: "p", repo: "r", container_engine: "none" }] }))
      .container_engine,
  ).toBe("none");
});

test("all projects share the developer's default memory space", () => {
  const s = spec({
    memory: {
      enabled: true,
      default_space: "shared",
      instances: { primary: INSTANCE },
      spaces: { shared: { instance: "primary", bank: "dev-a-shared" }, personal: { instance: "primary", bank: "dev-a-personal" } },
    },
    projects: [{ name: "p", repo: "r" }, { name: "q", repo: "r", memory_space: "personal" }],
  });
  const projects = resolveSpec(s).resolved!.developers[0]!.projects;
  expect(projects[0]!.memory_space).toBe("shared");
  expect(projects[1]!.memory_space).toBe("personal");
});

test("a sole memory space is selected without a default", () => {
  const s = spec({
    memory: { enabled: true, instances: { primary: INSTANCE }, spaces: { only: { instance: "primary", bank: "b" } } },
    projects: [{ name: "p", repo: "r" }],
  });
  expect(p0(s).memory_space).toBe("only");
});

test("several spaces with no default is an error", () => {
  const s = spec({
    memory: {
      enabled: true,
      instances: { primary: INSTANCE },
      spaces: { a: { instance: "primary", bank: "x" }, b: { instance: "primary", bank: "y" } },
    },
    projects: [{ name: "p", repo: "r" }],
  });
  expect(resolveSpec(s).issues.map((i) => i.path)).toContain("developers[0].projects[0].memory_space");
});

test("memory_space 'none' switches memory off for that project only", () => {
  const s = spec({
    memory: {
      enabled: true,
      default_space: "shared",
      instances: { primary: INSTANCE },
      spaces: { shared: { instance: "primary", bank: "b" } },
    },
    projects: [{ name: "p", repo: "r", memory_space: "none" }, { name: "q", repo: "r" }],
  });
  const projects = resolveSpec(s).resolved!.developers[0]!.projects;
  expect(projects[0]!.memory_space).toBeNull();
  expect(projects[1]!.memory_space).toBe("shared");
});

test("an agent profile's memory_space wins over the developer default", () => {
  const s = spec({
    agent_profiles: { work: { provider: "claude", memory_space: "personal" } },
    memory: {
      enabled: true,
      default_space: "shared",
      instances: { primary: INSTANCE },
      spaces: { shared: { instance: "primary", bank: "b" }, personal: { instance: "primary", bank: "c" } },
    },
    projects: [{ name: "p", repo: "r" }],
  });
  expect(p0(s).memory_space).toBe("personal");
});

test("a project memory_space still beats the agent profile's", () => {
  const s = spec({
    agent_profiles: { work: { provider: "claude", memory_space: "personal" } },
    memory: {
      enabled: true,
      default_space: "shared",
      instances: { primary: INSTANCE },
      spaces: { shared: { instance: "primary", bank: "b" }, personal: { instance: "primary", bank: "c" } },
    },
    projects: [{ name: "p", repo: "r", memory_space: "shared" }],
  });
  expect(p0(s).memory_space).toBe("shared");
});

test("memory.enabled false forces every project to null", () => {
  const s = spec({
    memory: {
      enabled: false,
      default_space: "shared",
      instances: {},
      spaces: { shared: { instance: "primary", bank: "b" } },
    },
    projects: [{ name: "p", repo: "r" }],
  });
  expect(p0(s).memory_space).toBeNull();
});

test("branch, install, update and ports get concrete defaults", () => {
  expect(p0(spec({ projects: [{ name: "p", repo: "r" }] }))).toMatchObject({
    branch: "main",
    install: true,
    update: false,
    ports: [],
  });
});

test("a developer with no projects resolves to an empty list", () => {
  const r = resolveSpec(spec({}));
  expect(r.issues).toEqual([]);
  expect(r.resolved!.developers[0]!.projects).toEqual([]);
});

test("access defaults name every private path that exists, and none that don't", () => {
  expect(defaultDesktopAccess(true)).toEqual(["tunnel", "tailnet"]);
  expect(defaultDesktopAccess(false)).toEqual(["tunnel"]);
  // SSH keeps a public path either way: a Tailscale outage must not lock you out.
  expect(defaultSshAccess(true)).toEqual(["public", "tailnet"]);
  expect(defaultSshAccess(false)).toEqual(["public"]);
});
