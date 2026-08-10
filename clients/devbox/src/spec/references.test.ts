import { expect, test } from "bun:test";
import { validateReferences } from "./references";
import type { DevboxSpec } from "./types";

const spec = (developers: DevboxSpec["developers"], over: Partial<DevboxSpec> = {}): DevboxSpec => ({
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: ["ssh-ed25519 AAAA k@c"] },
  network: { tailscale: { enabled: true }, ssh: { access: ["public", "tailnet"] } },
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

test("browser.failover.chrome_user must name a real developer", () => {
  const withFailover = (chrome_user: string) =>
    spec([{ user: "dev-a", login_ssh_keys: [] }], { browser: { failover: { enabled: true, chrome_user } } });
  expect(msgs(withFailover("dev-a"))).toEqual([]);
  expect(msgs(withFailover("nobody"))).toContain("error:browser.failover.chrome_user");
});

/** `count` developers, all of whom asked for a browser. */
const browserTeam = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ user: `dev-${i}`, login_ssh_keys: [], browser: true }));

test("one MCP server per browser-enabled developer does not collide at the default base", () => {
  expect(msgs(spec(browserTeam(5)))).toEqual([]);
});

test("an MCP range that reaches a port the browser stack owns is an error", () => {
  // 9420, 9421, 9422 — the third developer's server would land on the fallback Chrome.
  const out = validateReferences(spec(browserTeam(3), { browser: { mcp_port: 9420 } }));
  expect(out.map((i) => `${i.severity}:${i.path}`)).toContain("error:browser.mcp_port");
  expect(out[0]!.message).toContain("dev-2");
  expect(out[0]!.message).toContain("browser.failover.fallback_chrome_port");
});

test("the MCP range is checked against the failover ports as configured, not as defaulted", () => {
  const moved = { browser: { mcp_port: 9522, failover: { enabled: false, cdp_port: 9523 } } };
  expect(msgs(spec(browserTeam(2), moved))).toContain("error:browser.mcp_port");
  expect(msgs(spec(browserTeam(1), moved))).toEqual([]);
});

test("developers who did not ask for a browser claim no MCP port", () => {
  const mixed = [
    { user: "dev-a", login_ssh_keys: [], browser: true },
    { user: "dev-b", login_ssh_keys: [] },
    { user: "dev-c", login_ssh_keys: [], browser: true },
  ];
  // Two servers, on 9420 and 9421. A third would take 9422 — the fallback Chrome — so
  // this base is only safe because dev-b claims nothing.
  expect(msgs(spec(mixed, { browser: { mcp_port: 9420 } }))).toEqual([]);
  expect(msgs(spec(browserTeam(3), { browser: { mcp_port: 9420 } }))).toContain("error:browser.mcp_port");
});

test("a range running past the last valid port is an error", () => {
  expect(msgs(spec(browserTeam(4), { browser: { mcp_port: 65534 } }))).toContain("error:browser.mcp_port");
});

test("browser.enabled: false claims no ports at all", () => {
  expect(msgs(spec(browserTeam(3), { browser: { enabled: false, mcp_port: 9420 } }))).toEqual([]);
});
