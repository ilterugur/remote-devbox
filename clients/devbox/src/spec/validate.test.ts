import { expect, test } from "bun:test";
import { hasErrors } from "./issues";
import { normalize } from "./normalize";
import { validateReferences } from "./references";
import { resolveSpec } from "./resolve";
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

const runRawPipeline = (raw: unknown) => {
  const structural = validateStructure(raw);
  if (!structural.spec) return { normalized: null, issues: structural.issues };
  const referenceIssues = validateReferences(structural.spec);
  const issues = [...structural.issues, ...referenceIssues];
  if (hasErrors(issues)) return { normalized: null, issues };
  const resolution = resolveSpec(structural.spec);
  return {
    normalized: resolution.resolved ? normalize(resolution.resolved) : null,
    issues: [...issues, ...resolution.issues],
  };
};

/** minimal() with one project, merged with the given project overrides. */
const withProject = (extra: Record<string, unknown>) => ({
  ...minimal(),
  developers: [{ user: "dev-a", login_ssh_keys: [KEY], projects: [{ name: "p", repo: "git@github.com:e/p.git", ...extra }] }],
});

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

test("cli_targets rejects a platform bun cannot compile for", () => {
  expect(paths({ ...minimal(), clients: { cli_targets: ["darwin-arm64", "windows-x64"] } })).toContain(
    "error:clients.cli_targets",
  );
});

test("cli_targets may be empty — publish no binaries at all", () => {
  expect(paths({ ...minimal(), clients: { cli_targets: [] } })).toEqual([]);
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

test("client_port must be a port number", () => {
  const raw = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, client_port: 80 } }],
  };
  expect(paths(raw)).toContain("error:developers[0].desktop.client_port");
});

test("two developers cannot claim the same client_port", () => {
  const raw = {
    ...minimal(),
    developers: [
      { user: "dev-a", login_ssh_keys: [KEY], desktop: { enabled: true, client_port: 3390 } },
      { user: "dev-b", login_ssh_keys: [KEY], desktop: { enabled: true, client_port: 3390 } },
    ],
  };
  const messages = validateStructure(raw).issues.map((i) => `${i.path}: ${i.message}`);
  expect(messages.join("\n")).toContain("dev-a");
  expect(messages.join("\n")).toContain("dev-b");
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

test("file_bridge accepts a known engine", () => {
  const r = validateStructure({
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], file_bridge: { sync_disk: true, engine: "syncthing" } }],
  });
  expect(r.issues).toEqual([]);
  expect(r.spec?.developers[0]!.file_bridge?.engine).toBe("syncthing");
});

test("file_bridge rejects an unknown engine", () => {
  expect(
    paths({
      ...minimal(),
      developers: [{ user: "dev-a", login_ssh_keys: [KEY], file_bridge: { engine: "rsync" } }],
    }),
  ).toContain("error:developers[0].file_bridge.engine");
});

const withMounts = (lazy_mounts: unknown) =>
  paths({
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], file_bridge: { lazy_mounts } }],
  });

test("lazy mounts are accepted without a sync disk — they are independent features", () => {
  expect(withMounts([{ label: "desktop", path: "~/Desktop" }])).toEqual([]);
});

// The label becomes ~/mnt/<label> on the box.
test("a mount label that is not a directory name is rejected", () => {
  expect(withMounts([{ label: "my desktop", path: "~/Desktop" }])).toContain(
    "error:developers[0].file_bridge.lazy_mounts[0].label",
  );
  expect(withMounts([{ label: "a/b", path: "~/Desktop" }])).toContain(
    "error:developers[0].file_bridge.lazy_mounts[0].label",
  );
});

// Both would land on one box directory and the second would take the first one's place.
test("two mounts may not share a label", () => {
  expect(withMounts([{ label: "d", path: "~/Desktop" }, { label: "d", path: "~/Documents" }])).toContain(
    "error:developers[0].file_bridge.lazy_mounts[1].label",
  );
});

// Nested paths mean the box sees the same files twice, and unmounting one breaks the other.
test("a mount nested inside another is rejected", () => {
  expect(withMounts([{ label: "home", path: "~/" }, { label: "desk", path: "~/Desktop" }])).toContain(
    "error:developers[0].file_bridge.lazy_mounts[1].path",
  );
});

test("a mount with no path is rejected", () => {
  expect(withMounts([{ label: "d" }])).toContain("error:developers[0].file_bridge.lazy_mounts[0].path");
});

const withApp = (app: unknown, bridge: unknown = { sync_disk: true }) => ({
  ...minimal(),
  developers: [{ user: "dev-a", login_ssh_keys: [KEY], file_bridge: bridge, app_configs: app }],
});

test("app_configs accepts registry keys and object entries", () => {
  const r = validateStructure(withApp({
    enabled: true,
    paths: ["filezilla", { label: "dbeaver", client: "~/a", box: "~/b", mode: "dir" }],
  }));
  expect(r.issues).toEqual([]);
});

test("app_configs rejects an unknown registry key", () => {
  expect(paths(withApp({ enabled: true, paths: ["cyberduck"] }))).toContain(
    "error:developers[0].app_configs.paths[0]",
  );
});

test("app_configs requires the sync disk", () => {
  expect(
    paths(withApp({ enabled: true, paths: ["filezilla"] }, { sync_disk: false })),
  ).toContain("error:developers[0].app_configs.enabled");
});

test("app_configs rejects an entry overlapping the sync disk root", () => {
  expect(
    paths(withApp({
      enabled: true,
      paths: [{ label: "bad", client: "~/devbox/dev-a/x", box: "~/b", mode: "dir" }],
    })),
  ).toContain("error:developers[0].app_configs.paths[0].client");
});

test("app_configs rejects an entry whose box path overlaps the box sync disk", () => {
  // The store lives inside /home/<user>/sync, so a box path pointing in there would link
  // into its own store. The client-side guard never caught this: the two sides have
  // different disks.
  expect(paths({
    ...minimal(),
    developers: [{
      user: "dev-a", login_ssh_keys: [KEY], file_bridge: { sync_disk: true },
      app_configs: { enabled: true, paths: [{ label: "bad", client: "~/a", box: "/home/dev-a/sync/x", mode: "dir" }] },
    }],
  })).toContain("error:developers[0].app_configs.paths[0].box");
});

test("a box path outside the sync disk is accepted", () => {
  const r = validateStructure({
    ...minimal(),
    developers: [{
      user: "dev-a", login_ssh_keys: [KEY], file_bridge: { sync_disk: true },
      app_configs: { enabled: true, paths: [{ label: "ok", client: "~/a", box: "/home/dev-a/.config/app", mode: "dir" }] },
    }],
  });
  expect(r.issues).toEqual([]);
});

test("remote_control.spawn must be a known spawn mode", () => {
  const spec = { ...minimal(), remote_control: { spawn: "tmux" } };
  expect(paths(spec)).toContain("error:remote_control.spawn");
});

test("remote_control.capacity must be a positive integer", () => {
  expect(paths({ ...minimal(), remote_control: { capacity: 0 } })).toContain("error:remote_control.capacity");
  expect(paths({ ...minimal(), remote_control: { capacity: 2.5 } })).toContain("error:remote_control.capacity");
});

test("remote_control.resources reuses the systemd size rules", () => {
  const spec = { ...minimal(), remote_control: { resources: { memory_high: "lots" } } };
  expect(paths(spec)).toContain("error:remote_control.resources.memory_high");
});

test("developers[].codex_host_resources reuses the service resource rules", () => {
  const spec = {
    ...minimal(),
    developers: [
      {
        user: "dev-a",
        login_ssh_keys: [KEY],
        codex_host_resources: { memory_high: "lots", oom_policy: "restart" },
      },
    ],
  };
  expect(paths(spec)).toContain("error:developers[0].codex_host_resources.memory_high");
  expect(paths(spec)).toContain("error:developers[0].codex_host_resources.oom_policy");
});

test("memory sizes accept systemd units, B aliases and bounded percentages", () => {
  for (const value of ["32G", "32GB", "20%", "1%", "100%", ""]) {
    expect(
      paths({
        ...minimal(),
        developers: [{ user: "dev-a", login_ssh_keys: [KEY], resources: { memory_high: value } }],
      }),
    ).toEqual([]);
  }
});

test("memory sizes reject malformed units, unsupported units, and percentages", () => {
  for (const value of ["0%", "101%", "20.5%", "32GiB", "GB", "-1G", "32P", "32PB", "32E", "32EB"]) {
    expect(
      paths({
        ...minimal(),
        developers: [{ user: "dev-a", login_ssh_keys: [KEY], resources: { memory_high: value } }],
      }),
    ).toContain("error:developers[0].resources.memory_high");
  }
});

test("developer memory_high accepts a positive weight object", () => {
  const weighted = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], resources: { memory_high: { weight: 5 } } }],
  };
  expect(paths(weighted)).toEqual([]);
});

test("raw developer resources cannot inject the internal memory_high_weight field", () => {
  const injected = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], resources: { memory_high_weight: 5 } }],
  };
  const result = runRawPipeline(injected);

  expect(result.normalized).toBeNull();
  expect(result.issues.map((issue) => `${issue.severity}:${issue.path}`)).toContain(
    "error:developers[0].resources.memory_high_weight",
  );
});

test("raw developer resources reject an internal field even beside a valid weight", () => {
  const injected = {
    ...minimal(),
    developers: [
      {
        user: "dev-a",
        login_ssh_keys: [KEY],
        resources: { memory_high: { weight: 1 }, memory_high_weight: 5 },
      },
    ],
  };
  const result = runRawPipeline(injected);

  expect(result.normalized).toBeNull();
  expect(result.issues.map((issue) => `${issue.severity}:${issue.path}`)).toContain(
    "error:developers[0].resources.memory_high_weight",
  );
});

test("raw resource mappings reject unknown keys instead of forwarding them", () => {
  const unknown = {
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], resources: { burst_memory: "2G" } }],
  };
  const result = runRawPipeline(unknown);

  expect(result.normalized).toBeNull();
  expect(result.issues.map((issue) => `${issue.severity}:${issue.path}`)).toContain(
    "error:developers[0].resources.burst_memory",
  );
});

test("remote control resource allowlisting retains every service-only knob", () => {
  const rc = {
    ...minimal(),
    remote_control: {
      resources: { nice: 5, oom_score_adjust: 300, cpu_quota: "150%" },
    },
  };

  expect(runRawPipeline(rc).issues).toEqual([]);
});

test("weights are rejected outside developer memory_high", () => {
  const bad = { ...minimal(), remote_control: { resources: { memory_high: { weight: 5 } } } };
  expect(paths(bad)).toContain("error:remote_control.resources.memory_high");
});

test("direct and weighted developer memory_high modes cannot mix", () => {
  const mixed = {
    ...minimal(),
    developers: [
      { user: "dev-a", login_ssh_keys: [KEY], resources: { memory_high: { weight: 1 } } },
      { user: "dev-b", login_ssh_keys: [KEY], resources: { memory_high: "50%" } },
    ],
  };
  expect(paths(mixed)).toContain("error:developers.resources.memory_high");
});

test("memory_reserve is an absolute size and defaults independently of weight mode", () => {
  expect(paths({ ...minimal(), host: { memory_reserve: "4GB" } })).toEqual([]);
  expect(paths({ ...minimal(), host: { memory_reserve: "20%" } })).toContain("error:host.memory_reserve");
  expect(paths({ ...minimal(), host: { memory_reserve: "" } })).toContain("error:host.memory_reserve");
});

test("host.oomd pressure limit must be a percentage", () => {
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "60%" } } })).toEqual([]);
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "60" } } })).toContain(
    "error:host.oomd.memory_pressure_limit",
  );
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "60G" } } })).toContain(
    "error:host.oomd.memory_pressure_limit",
  );
});

test("host.oomd pressure limit is bounded to 1..99", () => {
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "0%" } } })).toContain(
    "error:host.oomd.memory_pressure_limit",
  );
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "100%" } } })).toContain(
    "error:host.oomd.memory_pressure_limit",
  );
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "999%" } } })).toContain(
    "error:host.oomd.memory_pressure_limit",
  );
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "1%" } } })).toEqual([]);
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "60%" } } })).toEqual([]);
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_limit: "99%" } } })).toEqual([]);
});

test("host.oomd pressure duration must be a positive integer", () => {
  expect(paths({ ...minimal(), host: { oomd: { memory_pressure_duration_sec: 0 } } })).toContain(
    "error:host.oomd.memory_pressure_duration_sec",
  );
});

test("remote_control.resources accepts nice and oom_score_adjust ranges", () => {
  const bad = { ...minimal(), remote_control: { resources: { nice: 25, oom_score_adjust: 2000 } } };
  expect(paths(bad)).toContain("error:remote_control.resources.nice");
  expect(paths(bad)).toContain("error:remote_control.resources.oom_score_adjust");
  const ok = { ...minimal(), remote_control: { resources: { nice: 5, oom_score_adjust: 300 } } };
  expect(paths(ok)).toEqual([]);
});

test("remote_control.resources rejects an unknown oom_policy", () => {
  const bad = { ...minimal(), remote_control: { resources: { oom_policy: "restart" } } };
  expect(paths(bad)).toContain("error:remote_control.resources.oom_policy");
});

test("remote_control.resources accepts the three systemd oom policies", () => {
  for (const policy of ["continue", "stop", "kill"]) {
    const spec = { ...minimal(), remote_control: { resources: { oom_policy: policy } } };
    expect(paths(spec)).not.toContain("error:remote_control.resources.oom_policy");
  }
});

test("remote_control.build_env must be a flat string map", () => {
  const spec = { ...minimal(), remote_control: { build_env: { NODE_OPTIONS: 4096 } } };
  expect(paths(spec)).toContain("error:remote_control.build_env.NODE_OPTIONS");
});

test("remote_control.resume knobs must be positive integers", () => {
  const spec = { ...minimal(), remote_control: { resume: { max_concurrent: 0 } } };
  expect(paths(spec)).toContain("error:remote_control.resume.max_concurrent");
});

test("a project's remote_control accepts false or a mapping, nothing else", () => {
  expect(paths(withProject({ remote_control: false }))).toEqual([]);
  expect(paths(withProject({ remote_control: { name: "P", spawn: "same-dir", capacity: 32 } }))).toEqual([]);
  expect(paths(withProject({ remote_control: "yes" }))).toContain("error:developers[0].projects[0].remote_control");
});

test("a project's remote_control.name must be a non-empty string", () => {
  const spec = withProject({ remote_control: { name: "" } });
  expect(paths(spec)).toContain("error:developers[0].projects[0].remote_control.name");
});

test("browser.failover names the account whose Chrome backs the endpoint", () => {
  const on = { ...minimal(), browser: { failover: { enabled: true } } };
  expect(paths(on)).toContain("error:browser.failover.chrome_user");
  const named = { ...minimal(), browser: { failover: { enabled: true, chrome_user: "dev-a" } } };
  expect(paths(named)).toEqual([]);
});

test("browser ports must be valid ports", () => {
  const spec = { ...minimal(), browser: { failover: { enabled: true, chrome_user: "dev-a", cdp_port: 0 } } };
  expect(paths(spec)).toContain("error:browser.failover.cdp_port");
});

test("browser.mcp_port must be a valid port", () => {
  expect(paths({ ...minimal(), browser: { mcp_port: 9522 } })).toEqual([]);
  expect(paths({ ...minimal(), browser: { mcp_port: 0 } })).toContain("error:browser.mcp_port");
  expect(paths({ ...minimal(), browser: { mcp_port: 70000 } })).toContain("error:browser.mcp_port");
  expect(paths({ ...minimal(), browser: { mcp_port: "9522" } })).toContain("error:browser.mcp_port");
});

test("browser autobind must be a boolean", () => {
  const spec = { ...minimal(), browser: { failover: { enabled: true, chrome_user: "dev-a", autobind: "yes" } } };
  expect(paths(spec)).toContain("error:browser.failover.autobind");
});

test("a developer's browser opt-in is a boolean", () => {
  expect(paths({ ...minimal(), developers: [{ user: "dev-a", login_ssh_keys: [KEY], browser: true }] })).toEqual([]);
  expect(
    paths({ ...minimal(), developers: [{ user: "dev-a", login_ssh_keys: [KEY], browser: "yes" }] }),
  ).toContain("error:developers[0].browser");
});

test("a developer's agent_config needs a source", () => {
  const withCfg = (agent_config: unknown) => ({
    ...minimal(),
    developers: [{ user: "dev-a", login_ssh_keys: [KEY], agent_config }],
  });
  expect(paths(withCfg({ source: "claude-config/shared" }))).toEqual([]);
  expect(paths(withCfg({ source: "claude-config/shared", include_settings: true }))).toEqual([]);
  expect(paths(withCfg({}))).toContain("error:developers[0].agent_config.source");
  expect(paths(withCfg({ source: "x", include_settings: "yes" }))).toContain(
    "error:developers[0].agent_config.include_settings",
  );
  expect(paths(withCfg("claude-config/shared"))).toContain("error:developers[0].agent_config");
});
