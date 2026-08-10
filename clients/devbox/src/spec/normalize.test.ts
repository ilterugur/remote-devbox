import { expect, test } from "bun:test";
import { normalize, renderVars } from "./normalize";
import { resolveSpec } from "./resolve";
import type { DevboxSpec, ResolvedSpec } from "./types";

const resolved: ResolvedSpec = {
  config_version: 3,
  platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
  operator: { user: "devbox-admin", ssh_authorized_keys: ["ssh-ed25519 AAAA k@c"] },
  network: { tailscale: { enabled: true }, ssh: { access: ["public", "tailnet"] } },
  container: { default_engine: "podman-rootless", install_engines: ["podman-rootless"] },
  developers: [
    {
      user: "dev-a",
      login_ssh_keys: ["ssh-ed25519 AAAA k@c"],
      git_identities: { work: { name: "N", email: "e@example.com" } },
      projects: [
        {
          name: "p",
          repo: "git@github.com:example/p.git",
          branch: "main",
          git_identity: "work",
          agent_profile: null,
          container_engine: "podman-rootless",
          memory_space: null,
          ports: [],
          install: true,
          update: false,
          remote_control: null,
        },
      ],
    },
  ],
};

const dev0 = () => (normalize(resolved).devbox_developers as Record<string, unknown>[])[0]!;

/** `resolved`, with its single project carrying a resolved RC unit. */
const rcResolved = (): ResolvedSpec => ({
  ...resolved,
  developers: [
    {
      ...resolved.developers[0]!,
      projects: [
        {
          ...resolved.developers[0]!.projects[0]!,
          remote_control: {
            agent: "claude",
            agent_profile: "claude-main",
            name: "dev-a · p",
            spawn: "worktree",
            capacity: 4,
            resources: { cpu_weight: 80, io_weight: 80, nice: 5, oom_score_adjust: 300 },
            build_env: {},
          },
        },
      ],
    },
  ],
});

test("remote control defaults are concrete even when nothing is declared", () => {
  const rc = normalize(resolved).devbox_remote_control as Record<string, unknown>;
  expect(rc.enabled).toBe(true);
  expect(rc.autorestart).toEqual({ enabled: true, restart_sec: 10, burst: 10, interval: 600 });
  expect(rc.resume).toEqual({
    on_boot: true,
    lookback_h: 12,
    max_concurrent: 2,
    settle_sec: 20,
    min_free_mb: 1200,
    max_attempts: 3,
    timeout_sec: 1800,
    skip_workflow_warning: true,
  });
});

test("skip_workflow_warning follows on_boot unless it is set explicitly", () => {
  const resume = (s: ResolvedSpec) =>
    (normalize(s).devbox_remote_control as { resume: Record<string, unknown> }).resume;
  expect(resume({ ...resolved, remote_control: { resume: { on_boot: false } } }).skip_workflow_warning).toBe(false);
  const pinned: ResolvedSpec = { ...resolved, remote_control: { resume: { on_boot: false, skip_workflow_warning: true } } };
  expect(resume(pinned).skip_workflow_warning).toBe(true);
});

test("rc units are a flat list across developers and projects", () => {
  const units = normalize(rcResolved()).devbox_rc_units as Record<string, unknown>[];
  expect(units).toHaveLength(1);
  expect(units[0]).toEqual({
    user: "dev-a",
    project: "p",
    agent: "claude",
    agent_profile: "claude-main",
    name: "dev-a · p",
    spawn: "worktree",
    capacity: 4,
    project_dir: "/home/dev-a/projects/p",
    resources: { cpu_weight: 80, io_weight: 80, nice: 5, oom_score_adjust: 300 },
    build_env: {},
  });
});

test("a project with no unit contributes nothing to the list", () => {
  expect(normalize(resolved).devbox_rc_units).toEqual([]);
});

test("absent optionals become concrete values, never undefined", () => {
  const dev = dev0();
  expect(dev.adopt_existing).toBe(false);
  expect(dev.resources).toEqual({});
  expect(dev.agent_profiles).toEqual({});
  expect(dev.default_agent_profile).toBeNull();
  expect(dev.container_engine).toBeNull();
  expect(dev.memory).toEqual({ enabled: false, default_space: null, instances: {}, spaces: {} });
  expect(dev.desktop).toEqual({
    enabled: false,
    environment: "xfce",
    transport: "xrdp",
    access: ["tunnel", "tailnet"],
    idle_logout_minutes: null,
    client_port: null,
    keyboard: null,
  });
});

test("a git identity is emitted with an explicit github_user", () => {
  expect(dev0().git_identities).toEqual({ work: { name: "N", email: "e@example.com", github_user: null } });
});

test("cli_targets defaults to the three usual laptop platforms", () => {
  expect(normalize(resolved).devbox_clients).toEqual({
    cli_targets: ["darwin-arm64", "darwin-x64", "linux-x64"],
  });
});

test("an empty cli_targets survives normalization as empty, not as the default", () => {
  expect(normalize({ ...resolved, clients: { cli_targets: [] } }).devbox_clients).toEqual({
    cli_targets: [],
  });
});

test("shared_services defaults to disabled", () => {
  expect(normalize(resolved).devbox_shared_services).toEqual({ enabled: false, engine: "system-docker" });
});

test("memory listener allocation has one generated base port shared with health facts", () => {
  expect(normalize(resolved).devbox_memory_base_port).toBe(9077);
});

test("declared resources survive normalization", () => {
  const withLimits: ResolvedSpec = {
    ...resolved,
    developers: [{ ...resolved.developers[0]!, resources: { memory_high: "10G", cpu_weight: 100 } }],
  };
  const dev = (normalize(withLimits).devbox_developers as Record<string, unknown>[])[0]!;
  expect(dev.resources).toEqual({ memory_high: "10G", cpu_weight: 100 });
});

test("host memory reserve is emitted in canonical systemd form", () => {
  const out = normalize({ ...resolved, host: { memory_reserve: "4GB" } });
  expect(out.devbox_host).toMatchObject({ memory_reserve: "4G" });
});

test("host.oomd is always emitted, fully defaulted", () => {
  const out = normalize({ ...resolved, host: {} });
  expect(out.devbox_host).toMatchObject({
    oomd: { enabled: true, memory_pressure_limit: "60%", memory_pressure_duration_sec: 20 },
  });
});

test("host.oomd values override the defaults", () => {
  const out = normalize({ ...resolved, host: { oomd: { memory_pressure_limit: "75%" } } });
  expect(out.devbox_host).toMatchObject({ oomd: { memory_pressure_limit: "75%", enabled: true } });
});

test("weighted memory_high becomes an Ansible weight and box-wide total", () => {
  const weighted: ResolvedSpec = {
    ...resolved,
    developers: [{ ...resolved.developers[0]!, resources: { memory_high: { weight: 5 } } }],
  };

  const out = normalize(weighted);
  expect((out.devbox_developers as Record<string, unknown>[])[0]!.resources).toEqual({ memory_high_weight: 5 });
  expect(out.devbox_memory_high_weight_total).toBe(5);
});

test("direct memory_high values keep percentages and canonicalize byte aliases", () => {
  const percent: ResolvedSpec = {
    ...resolved,
    developers: [{ ...resolved.developers[0]!, resources: { memory_high: "50%" } }],
  };
  const gigabytes: ResolvedSpec = {
    ...resolved,
    developers: [{ ...resolved.developers[0]!, resources: { memory_high: "32GB" } }],
  };

  expect((normalize(percent).devbox_developers as Record<string, unknown>[])[0]!.resources).toEqual({ memory_high: "50%" });
  expect((normalize(gigabytes).devbox_developers as Record<string, unknown>[])[0]!.resources).toEqual({ memory_high: "32G" });
});

test("all direct developer memory limits use canonical systemd units", () => {
  const withAliases: ResolvedSpec = {
    ...resolved,
    developers: [
      {
        ...resolved.developers[0]!,
        resources: { memory_high: "32GB", memory_max: "2048MB", memory_swap_max: "8TB" },
      },
    ],
  };

  expect((normalize(withAliases).devbox_developers as Record<string, unknown>[])[0]!.resources).toEqual({
    memory_high: "32G",
    memory_max: "2048M",
    memory_swap_max: "8T",
  });
});

test("remote control canonicalizes inherited and project-overridden memory limits", () => {
  const declared: DevboxSpec = {
    ...resolved,
    remote_control: {
      resources: { memory_high: "32GB", memory_max: "2048MB", memory_swap_max: "8TB" },
    },
    developers: [
      {
        ...resolved.developers[0]!,
        agent_profiles: { main: { provider: "claude" } },
        default_agent_profile: "main",
        projects: [
          {
            name: "p",
            repo: "git@github.com:example/p.git",
            remote_control: { resources: { memory_max: "50%", memory_swap_max: "1024KB" } },
          },
        ],
      },
    ],
  };
  const resolvedWithRc = resolveSpec(declared).resolved!;

  expect((normalize(resolvedWithRc).devbox_rc_units as Record<string, unknown>[])[0]!.resources).toMatchObject({
    memory_high: "32G",
    memory_max: "50%",
    memory_swap_max: "1024K",
  });
});

test("file_bridge defaults to off with the mutagen engine", () => {
  const dev = dev0();
  expect(dev.file_bridge).toEqual({
    sync_disk: false,
    engine: "mutagen",
    lazy_mounts: [],
    lazy_mount_on_connect: false,
  });
});

test("a declared file_bridge survives normalization", () => {
  const withBridge: ResolvedSpec = {
    ...resolved,
    developers: [{ ...resolved.developers[0]!, file_bridge: { sync_disk: true, engine: "syncthing" } }],
  };
  const dev = (normalize(withBridge).devbox_developers as Record<string, unknown>[])[0]!;
  expect(dev.file_bridge).toEqual({
    sync_disk: true,
    engine: "syncthing",
    lazy_mounts: [],
    lazy_mount_on_connect: false,
  });
});

test("app_configs is emitted fully resolved", () => {
  const withApp: ResolvedSpec = {
    ...resolved,
    developers: [
      {
        ...resolved.developers[0]!,
        file_bridge: { sync_disk: true },
        app_configs: { enabled: true, paths: ["ssh_config"] },
      },
    ],
  };
  const dev = (normalize(withApp).devbox_developers as Record<string, unknown>[])[0]! as {
    app_configs: { enabled: boolean; paths: unknown[] };
  };
  expect(dev.app_configs.enabled).toBe(true);
  expect(dev.app_configs.paths[0]).toEqual({
    label: "ssh_config",
    client: "~/.ssh/config",
    box: "~/.ssh/config",
    mode: "ssh-include",
    excludes: [],
    payload: "config",
  });
});

test("an absent app_configs still emits the empty shape", () => {
  expect(dev0().app_configs).toEqual({ enabled: false, paths: [] });
});

test("renderVars emits a do-not-edit header and parses back", () => {
  const text = renderVars(resolved);
  expect(text.startsWith("---\n# GENERATED by `devbox plan`")).toBe(true);
  const parsed = Bun.YAML.parse(text) as Record<string, unknown>;
  expect(parsed.devbox_config_version).toBe(3);
  expect((parsed.devbox_developers as Record<string, unknown>[])[0]!.user).toBe("dev-a");
});

test("normalization is deterministic", () => {
  expect(renderVars(resolved)).toBe(renderVars(structuredClone(resolved)));
});

const withDesktop = (desktop: Record<string, unknown>): ResolvedSpec => ({
  ...resolved,
  developers: [{ ...resolved.developers[0]!, desktop: { enabled: true, environment: "xfce", transport: "xrdp", ...desktop } as any }],
});

const desktopOf = (out: Record<string, unknown>): any => (out.devbox_developers as any[])[0].desktop;

test("an unstated keyboard falls back to the one the client types on", () => {
  const out = normalize(withDesktop({}), { keyboard: { layout: "tr", variant: null } });
  expect(desktopOf(out).keyboard).toEqual({ layout: "tr", variant: null, rdp_layout_id: "0x0000041F" });
});

test("a stated keyboard beats the detected one", () => {
  const out = normalize(withDesktop({ keyboard: { layout: "de" } }), {
    keyboard: { layout: "tr", variant: null },
  });
  expect(desktopOf(out).keyboard).toEqual({ layout: "de", variant: null, rdp_layout_id: "0x00000407" });
});

test("a stated keyboard keeps its variant", () => {
  const out = normalize(withDesktop({ keyboard: { layout: "tr", variant: "f" } }), { keyboard: null });
  expect(desktopOf(out).keyboard).toEqual({ layout: "tr", variant: "f", rdp_layout_id: "0x0001041F" });
});

// Undetected and unstated leaves the layout to the box rather than guessing at one.
test("no keyboard anywhere stays null", () => {
  expect(desktopOf(normalize(withDesktop({}))).keyboard).toBeNull();
});

test("a desktop developer gets a client port, defaulting to 3389", () => {
  expect(desktopOf(normalize(withDesktop({}))).client_port).toBe(3389);
});

test("an explicit client_port is carried through untouched", () => {
  expect(desktopOf(normalize(withDesktop({ client_port: 3391 }))).client_port).toBe(3391);
});

test("a box without Tailscale defaults to the paths that actually exist", () => {
  const noTailnet: ResolvedSpec = {
    ...resolved,
    network: { tailscale: { enabled: false }, ssh: {} },
    developers: [{ ...resolved.developers[0]!, desktop: { enabled: true, environment: "xfce", transport: "xrdp" } }],
  };
  const out = normalize(noTailnet);
  expect((out.devbox_network as any).ssh.access).toEqual(["public"]);
  expect(((out.devbox_developers as any[])[0]).desktop.access).toEqual(["tunnel"]);
});

test("swappiness is null when unset, so the role leaves the kernel default alone", () => {
  expect((normalize(resolved).devbox_host as any).swappiness).toBeNull();
  const tuned: ResolvedSpec = { ...resolved, host: { swappiness: 10 } };
  expect((normalize(tuned).devbox_host as any).swappiness).toBe(10);
});

test("browser defaults are concrete, and failover is off until asked for", () => {
  const b = normalize(resolved).devbox_browser as Record<string, unknown>;
  expect(b.enabled).toBe(true);
  expect(b.failover).toEqual({
    enabled: false,
    chrome_user: null,
    cdp_port: 9222,
    fallback_chrome_port: 9422,
    client_tunnel_port: 9322,
    autobind: false,
  });
});

test("browser failover preserves an explicit autobind setting", () => {
  const out = normalize({
    ...resolved,
    browser: { failover: { enabled: true, chrome_user: "dev-a", autobind: true } },
  }).devbox_browser as Record<string, any>;
  expect(out.failover.autobind).toBe(true);
});

test("a developer's browser opt-in and agent_config are concrete", () => {
  const dev = dev0();
  expect(dev.browser).toBe(false);
  expect(dev.agent_config).toBeNull();

  const opted: ResolvedSpec = {
    ...resolved,
    developers: [{ ...resolved.developers[0]!, browser: true, agent_config: { source: "claude-config/shared" } }],
  };
  const d = (normalize(opted).devbox_developers as Record<string, unknown>[])[0]!;
  expect(d.browser).toBe(true);
  expect(d.agent_config).toEqual({ source: "claude-config/shared", include_settings: false });
});
