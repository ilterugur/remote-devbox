import { expect, test } from "bun:test";
import { validateStructure } from "./validate";

const KEY = "ssh-ed25519 AAAAC3Nz key@client";

const minimal = () => ({
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: [KEY] },
  network: { tailscale: { enabled: true }, ssh: { exposure: "public_and_tailscale" } },
  container: { default_engine: "podman-rootless", install_engines: ["podman-rootless"] },
  developers: [{ user: "dev-a", login_ssh_keys: [KEY] }],
});

const paths = (raw: unknown) =>
  validateStructure(raw).issues.map((i) => `${i.severity}:${i.path}`);

test("a minimal valid config produces a spec and no issues", () => {
  const r = validateStructure(minimal());
  expect(r.issues).toEqual([]);
  expect(r.spec?.developers[0].user).toBe("dev-a");
});

test("a legacy config_version points at migrate-config", () => {
  const r = validateStructure({ ...minimal(), config_version: 2 });
  expect(r.spec).toBeNull();
  expect(r.issues).toHaveLength(1);
  expect(r.issues[0].message).toContain("devbox migrate-config");
});

test("a non-mapping document is rejected outright", () => {
  expect(validateStructure("nope").spec).toBeNull();
  expect(validateStructure(null).issues[0].path).toBe("");
});

test("an unsupported platform is an error, or a warning with the escape hatch", () => {
  const bad = { ...minimal(), platform: { distribution: "debian", version: "12", architecture: "amd64" } };
  expect(paths(bad)).toContain("error:platform");
  expect(paths({ ...bad, allow_unsupported_platform: true })).toContain("warning:platform");
});

test("tailscale_only exposure requires tailscale", () => {
  expect(
    paths({ ...minimal(), network: { tailscale: { enabled: false }, ssh: { exposure: "tailscale_only" } } }),
  ).toContain("error:network.ssh.exposure");
});

test("public_only exposure without tailscale is fine", () => {
  expect(
    paths({ ...minimal(), network: { tailscale: { enabled: false }, ssh: { exposure: "public_only" } } }),
  ).toEqual([]);
});

test("default_engine must be installed", () => {
  expect(
    paths({ ...minimal(), container: { default_engine: "docker-rootless", install_engines: ["podman-rootless"] } }),
  ).toContain("error:container.default_engine");
});

test("default_engine 'none' needs no install entry", () => {
  expect(
    paths({ ...minimal(), container: { default_engine: "none", install_engines: ["podman-rootless"] } }),
  ).toEqual([]);
});

test("shared_services only accepts system-docker", () => {
  expect(paths({ ...minimal(), shared_services: { enabled: true, engine: "podman" } })).toContain(
    "error:shared_services.engine",
  );
});

test("a developer with no login key is warned, not blocked", () => {
  const r = validateStructure({ ...minimal(), developers: [{ user: "dev-a", login_ssh_keys: [] }] });
  expect(r.issues.map((i) => `${i.severity}:${i.path}`)).toEqual(["warning:developers[0].login_ssh_keys"]);
  expect(r.spec).not.toBeNull();
});

test("an invalid developer username is reported with its index", () => {
  expect(paths({ ...minimal(), developers: [{ user: "Dev A", login_ssh_keys: [] }] })).toContain(
    "error:developers[0].user",
  );
});

test("nested developer sections are validated", () => {
  const raw = {
    ...minimal(),
    developers: [
      {
        user: "dev-a",
        login_ssh_keys: [KEY],
        git_identities: { work: { name: "N" } },
        agent_profiles: { a: { provider: "gemini" } },
        memory: { enabled: true, instances: { primary: { engine: "chroma", llm_provider: "x" } }, spaces: { s: { instance: "primary" } } },
        desktop: { enabled: true, environment: "gnome", transport: "xrdp" },
        resources: { memory_high: "lots", cpu_weight: 0 },
        projects: [{ name: "bad name", repo: "", ports: [70000], container_engine: "lxc" }],
      },
    ],
  };
  expect(paths(raw)).toEqual(
    expect.arrayContaining([
      "error:developers[0].git_identities.work.email",
      "error:developers[0].agent_profiles.a.provider",
      "error:developers[0].memory.instances.primary.engine",
      "error:developers[0].memory.spaces.s.bank",
      "error:developers[0].desktop.environment",
      "error:developers[0].resources.memory_high",
      "error:developers[0].resources.cpu_weight",
      "error:developers[0].projects[0].name",
      "error:developers[0].projects[0].repo",
      "error:developers[0].projects[0].ports",
      "error:developers[0].projects[0].container_engine",
    ]),
  );
});

test("every problem is collected, not just the first", () => {
  expect(
    paths({
      ...minimal(),
      operator: { user: "OPERATOR", ssh_authorized_keys: [] },
      developers: [{ user: "1bad", login_ssh_keys: ["not-a-key"] }],
    }),
  ).toEqual(
    expect.arrayContaining([
      "error:operator.user",
      "error:operator.ssh_authorized_keys",
      "error:developers[0].user",
      "error:developers[0].login_ssh_keys[0]",
    ]),
  );
});
