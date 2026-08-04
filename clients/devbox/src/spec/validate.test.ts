import { expect, test } from "bun:test";
import { validateStructure } from "./validate";

const KEY = "ssh-ed25519 AAAAC3Nz key@client";

const minimal = () => ({
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: [KEY] },
  network: { tailscale: { enabled: true }, ssh: { access: ["public", "tailnet"] } },
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

test("a tailnet-only sshd requires a tailnet", () => {
  expect(
    paths({ ...minimal(), network: { tailscale: { enabled: false }, ssh: { access: ["tailnet"] } } }),
  ).toContain("error:network.ssh.access");
});

test("the removed ssh exposure enum is reported, not ignored", () => {
  expect(
    paths({ ...minimal(), network: { tailscale: { enabled: true }, ssh: { exposure: "public_only" } } }),
  ).toContain("error:network.ssh.exposure");
});

test("a public-only sshd without tailscale is fine", () => {
  expect(
    paths({ ...minimal(), network: { tailscale: { enabled: false }, ssh: { access: ["public"] } } }),
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

test("an agent profile may not be named after a command on PATH", () => {
  const raw = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], agent_profiles: { codex: { provider: "codex" } } }],
  };
  expect(paths(raw)).toContain("error:developers[0].agent_profiles.codex");
});

test("a profile name with a slash is rejected (it becomes a filename)", () => {
  const raw = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], agent_profiles: { "a/b": { provider: "claude" } } }],
  };
  expect(paths(raw)).toContain("error:developers[0].agent_profiles.a/b");
});

test("desktop access defaults are absent-but-valid; an empty list is not", () => {
  const desktop = (extra: Record<string, unknown>) => ({
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, ...extra } }],
  });
  expect(paths(desktop({}))).toEqual([]);
  expect(paths(desktop({ access: [] }))).toContain("error:developers[0].desktop.access");
});

// The fields reach setxkbmap unquoted, so anything with a space in it would become two
// arguments on the box and fail there rather than here.
test("the keyboard is checked against XKB's naming, not merely for being a string", () => {
  const keyboard = (k: unknown) => ({
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, keyboard: k } }],
  });
  expect(paths(keyboard({ layout: "tr" }))).toEqual([]);
  expect(paths(keyboard({ layout: "tr", variant: "f", model: "pc105" }))).toEqual([]);
  expect(paths(keyboard({ layout: "Turkish Q" }))).toContain("error:developers[0].desktop.keyboard.layout");
  expect(paths(keyboard({ variant: "f" }))).toContain("error:developers[0].desktop.keyboard.layout");
  expect(paths(keyboard({ layout: "tr", variant: "F Klavye" }))).toContain(
    "error:developers[0].desktop.keyboard.variant",
  );
  expect(paths(keyboard("tr"))).toContain("error:developers[0].desktop.keyboard");
});

test("desktop access rejects unknown values and duplicates", () => {
  const desktop = (access: unknown) => ({
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, access } }],
  });
  expect(paths(desktop(["vpn"]))).toContain("error:developers[0].desktop.access");
  expect(paths(desktop(["tunnel", "tunnel"]))).toContain("error:developers[0].desktop.access");
  expect(paths(desktop(["tunnel", "tailnet"]))).toEqual([]);
});

test("unsafe-public cannot be combined — the wildcard bind would collide", () => {
  const raw = {
    ...minimal(),
    developers: [
      { user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, access: ["unsafe-public", "tunnel"] } },
    ],
  };
  expect(paths(raw)).toContain("error:developers[0].desktop.access");
  expect(
    paths({
      ...minimal(),
      developers: [{ user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, access: ["unsafe-public"] } }],
    }),
  ).toEqual([]);
});

test("the removed tailscale_only is reported, not ignored", () => {
  const raw = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, tailscale_only: true } }],
  };
  expect(paths(raw)).toContain("error:developers[0].desktop.tailscale_only");
});

test("hardware-backed and certificate SSH keys are accepted", () => {
  for (const key of [
    "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5 dev-a@yubikey",
    "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNh dev-a@yubikey",
    "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5 dev-a@ca",
  ]) {
    expect(paths({ ...minimal(), developers: [{ user: "dev-a", login_ssh_keys: [key] }] })).toEqual([]);
  }
});

test("host.swappiness must be a kernel-valid integer", () => {
  const host = (swappiness: unknown) => ({ ...minimal(), host: { swappiness } });
  expect(paths(host(10))).toEqual([]);
  expect(paths(host(0))).toEqual([]);
  expect(paths(host(201))).toContain("error:host.swappiness");
  expect(paths(host(-1))).toContain("error:host.swappiness");
  expect(paths(host("10"))).toContain("error:host.swappiness");
});
