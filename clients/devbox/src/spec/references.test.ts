import { expect, test } from "bun:test";
import { validateReferences } from "./references";
import type { DevboxSpec } from "./types";

const spec = (developers: DevboxSpec["developers"], over: Partial<DevboxSpec> = {}): DevboxSpec => ({
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: ["ssh-ed25519 AAAA k@c"] },
  network: { tailscale: { enabled: true }, ssh: { exposure: "public_and_tailscale" } },
  container: { default_engine: "podman-rootless", install_engines: ["podman-rootless"] },
  developers,
  ...over,
});

const msgs = (s: DevboxSpec) => validateReferences(s).map((i) => `${i.severity}:${i.path}`);
const ID = { name: "N", email: "e@example.com" };

test("an unknown default_git_identity is an error", () => {
  expect(
    msgs(
      spec([
        { user: "dev-a", login_ssh_keys: [], git_identities: { work: ID }, default_git_identity: "missing" },
      ]),
    ),
  ).toContain("error:developers[0].default_git_identity");
});

test("a project referencing an unknown agent profile is an error", () => {
  expect(
    msgs(
      spec([
        {
          user: "dev-a",
          login_ssh_keys: [],
          agent_profiles: { a: { provider: "claude" } },
          projects: [{ name: "p", repo: "git@github.com:example/p.git", agent_profile: "b" }],
        },
      ]),
    ),
  ).toContain("error:developers[0].projects[0].agent_profile");
});

test("memory_space 'none' is always a valid reference", () => {
  expect(
    msgs(spec([{ user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r", memory_space: "none" }] }])),
  ).toEqual([]);
});

test("a space pointing at an unknown instance is an error", () => {
  expect(
    msgs(
      spec([
        {
          user: "dev-a",
          login_ssh_keys: [],
          memory: { enabled: true, instances: {}, spaces: { s: { instance: "primary", bank: "b" } } },
        },
      ]),
    ),
  ).toContain("error:developers[0].memory.spaces.s.instance");
});

test("declaring spaces while memory is disabled is a warning", () => {
  expect(
    msgs(
      spec([
        {
          user: "dev-a",
          login_ssh_keys: [],
          memory: {
            enabled: false,
            instances: { primary: { engine: "hindsight", llm_provider: "openrouter" } },
            spaces: { s: { instance: "primary", bank: "b" } },
          },
        },
      ]),
    ),
  ).toContain("warning:developers[0].memory");
});

test("an uninstalled container engine is an error", () => {
  expect(
    msgs(
      spec([
        { user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r", container_engine: "docker-rootless" }] },
      ]),
    ),
  ).toContain("error:developers[0].projects[0].container_engine");
});

test("engine 'none' never needs to be installed", () => {
  expect(
    msgs(spec([{ user: "dev-a", login_ssh_keys: [], container_engine: "none", projects: [] }])),
  ).toEqual([]);
});

test("duplicate developer users are an error on the later one", () => {
  expect(msgs(spec([{ user: "dev-a", login_ssh_keys: [] }, { user: "dev-a", login_ssh_keys: [] }]))).toEqual([
    "error:developers[1].user",
  ]);
});

test("duplicate project names within one developer are an error", () => {
  expect(
    msgs(
      spec([
        { user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r" }, { name: "p", repo: "r" }] },
      ]),
    ),
  ).toContain("error:developers[0].projects[1].name");
});

test("the same project name under two developers is fine", () => {
  expect(
    msgs(
      spec([
        { user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r" }] },
        { user: "dev-b", login_ssh_keys: [], projects: [{ name: "p", repo: "r" }] },
      ]),
    ),
  ).toEqual([]);
});

test("a developer that is also the operator is a warning", () => {
  expect(msgs(spec([{ user: "devbox-admin", login_ssh_keys: [] }]))).toContain("warning:developers[0].user");
});

test("the same port in two developers' projects is an error on both", () => {
  const out = msgs(
    spec([
      { user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r", ports: [3000] }] },
      { user: "dev-b", login_ssh_keys: [], projects: [{ name: "q", repo: "r", ports: [3000] }] },
    ]),
  );
  expect(out).toContain("error:developers[0].projects[0].ports");
  expect(out).toContain("error:developers[1].projects[0].ports");
});

test("distinct ports do not collide", () => {
  expect(
    msgs(
      spec([
        { user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r", ports: [3000, 5173] }] },
        { user: "dev-b", login_ssh_keys: [], projects: [{ name: "q", repo: "r", ports: [3001] }] },
      ]),
    ),
  ).toEqual([]);
});

test("a reserved port is an error", () => {
  expect(
    msgs(spec([{ user: "dev-a", login_ssh_keys: [], projects: [{ name: "p", repo: "r", ports: [3389] }] }])),
  ).toContain("error:developers[0].projects[0].ports");
});
