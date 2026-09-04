import { expect, test } from "bun:test";
import { normalize, renderVars } from "./normalize";
import { AGENT_CONFIG_ENV, resolveSpec } from "./resolve";
import { PROVIDERS } from "./validate";
import type { AgentProvider, DevboxSpec, ResolvedSpec } from "./types";

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
            config_env: "CLAUDE_CONFIG_DIR",
            config_dir: "/home/dev-a/.agent-profiles/claude-main",
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

test("worktree-orphan reaping is on by default", () => {
  const rc = normalize(resolved).devbox_remote_control as Record<string, unknown>;
  expect(rc.reap).toEqual({ enabled: true, interval_sec: 900, grace_sec: 900 });
});

test("reap settings are taken verbatim when declared", () => {
  const spec: ResolvedSpec = {
    ...resolved,
    remote_control: { reap: { enabled: false, interval_sec: 300, grace_sec: 60 } },
  };
  const rc = normalize(spec).devbox_remote_control as Record<string, unknown>;
  expect(rc.reap).toEqual({ enabled: false, interval_sec: 300, grace_sec: 60 });
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
    config_env: "CLAUDE_CONFIG_DIR",
    config_dir: "/home/dev-a/.agent-profiles/claude-main",
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

// An RC unit execs the agent binary directly instead of going through the profile
// launcher, so the row is the only thing that can tell it which config tree to read.
// Drop these two keys and Remote Control quietly serves the developer's default tree
// while `/login` writes the profile's — a different account on the phone than on the box.
test("every provider's rc row names the config-dir variable and the profile tree", () => {
  const cases: [AgentProvider, string][] = [
    ["claude", "CLAUDE_CONFIG_DIR"],
    ["codex", "CODEX_HOME"],
    ["omp", "PI_CODING_AGENT_DIR"],
  ];
  for (const [provider, env] of cases) {
    const declared: DevboxSpec = {
      ...resolved,
      developers: [
        {
          ...resolved.developers[0]!,
          agent_profiles: { [`${provider}-main`]: { provider } },
          default_agent_profile: `${provider}-main`,
          projects: [{ name: "p", repo: "git@github.com:example/p.git" }],
        },
      ],
    };
    const units = normalize(resolveSpec(declared).resolved!).devbox_rc_units as Record<string, unknown>[];
    expect(units[0]).toMatchObject({
      agent: provider,
      config_env: env,
      config_dir: `/home/dev-a/.agent-profiles/${provider}-main`,
    });
  }
});

// The map is keyed by the provider union, so TypeScript catches a new agent added to the
// union. Nothing catches one added only to validate's runtime list — this does.
test("the provider→config-env map covers every provider validation accepts", () => {
  expect(Object.keys(AGENT_CONFIG_ENV).sort()).toEqual([...PROVIDERS].sort());
  for (const provider of PROVIDERS) expect(AGENT_CONFIG_ENV[provider as AgentProvider]).toBeTruthy();
});

/** `resolved`, with agent profiles: one codex login, one claude login. */
const codexResolved = (): ResolvedSpec => ({
  ...resolved,
  // Deliberately state only the ceilings. The code-mode host must still receive the
  // same safe service defaults as project RC units; reading this raw mapping would
  // silently drop OOMPolicy=continue and make oomd protection incomplete.
  remote_control: { resources: { memory_high: "8G", memory_max: "12G" } },
  developers: [
    {
      ...resolved.developers[0]!,
      agent_profiles: {
        "codex-main": { provider: "codex" },
        "claude-main": { provider: "claude" },
      },
    },
  ],
});

test("codex code-mode hosts inherit resolved RC defaults, not only explicitly stated limits", () => {
  const units = normalize(codexResolved()).devbox_codex_units as Record<string, unknown>[];
  expect(units).toEqual([
    {
      user: "dev-a",
      profile: "codex-main",
      codex_home: "/home/dev-a/.agent-profiles/codex-main",
      heavy_job_gate_enabled: true,
      heavy_job_gate_categories: ["build", "typecheck", "generate", "test"],
      heavy_job_gate_wait_timeout_sec: 1800,
      heavy_job_gate_warn_after_sec: 5,
      heavy_job_gate_memory_max: "8G",
      resources: {
        memory_high: "8G",
        memory_max: "12G",
        cpu_weight: 80,
        io_weight: 80,
        nice: 5,
        oom_score_adjust: 300,
        oom_policy: "continue",
      },
    },
  ]);
});

test("codex host resources override only the code-mode host ceilings", () => {
  const spec = codexResolved();
  spec.remote_control = { resources: { memory_high: "8G", memory_max: "12G", memory_swap_max: "1G" } };
  spec.developers[0]!.codex_host_resources = { memory_high: "12GB", memory_max: "16GB" };

  const codexUnits = normalize(spec).devbox_codex_units as Record<string, unknown>[];
  expect(codexUnits[0]?.resources).toEqual({
    memory_high: "12G",
    memory_max: "16G",
    memory_swap_max: "1G",
    cpu_weight: 80,
    io_weight: 80,
    nice: 5,
    oom_score_adjust: 300,
    oom_policy: "continue",
  });

  const projectSpec = rcResolved();
  projectSpec.remote_control = spec.remote_control;
  projectSpec.developers[0]!.projects[0]!.remote_control!.resources = {
    memory_high: "8G",
    memory_max: "12G",
    memory_swap_max: "1G",
  };
  const rcUnits = normalize(projectSpec).devbox_rc_units as Record<string, unknown>[];
  expect(rcUnits[0]?.resources).toMatchObject({
    memory_high: "8G",
    memory_max: "12G",
    memory_swap_max: "1G",
  });
});

test("two codex profiles still produce one code-mode host per Linux user", () => {
  const spec = codexResolved();
  spec.developers[0]!.agent_profiles!["codex-work"] = { provider: "codex" };
  const units = normalize(spec).devbox_codex_units as Record<string, unknown>[];
  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({ user: "dev-a", profile: "codex-main" });
});

test("a developer with no codex profile contributes no codex unit", () => {
  expect(normalize(resolved).devbox_codex_units).toEqual([]);
});

test("codex remote control is opt-in and off by default", () => {
  expect(normalize(codexResolved()).devbox_codex_remote_control_units).toEqual([]);
});

// Its own CODEX_HOME, not the code-mode host's: a second Codex login with its own
// control socket. The gate settings have to come along — the daemon's inherited PATH is
// the only route the heavy-job gate has into a build Codex runs.
test("an opted-in developer gets a codex remote control unit with its own home and the gate", () => {
  const spec = codexResolved();
  const units = normalize({
    ...spec,
    developers: [{ ...spec.developers[0]!, codex_remote_control: true }],
  }).devbox_codex_remote_control_units as Record<string, unknown>[];

  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({
    user: "dev-a",
    profile: "codex-remote-control",
    codex_home: "/home/dev-a/.agent-profiles/codex-remote-control",
    heavy_job_gate_enabled: true,
    heavy_job_gate_categories: ["build", "typecheck", "generate", "test"],
  });
});

// Both daemons belong to one developer and compete for the same machine, so a runaway
// build under either has to meet the same wall.
test("codex remote control shares the code-mode host's resolved resource envelope", () => {
  const spec = codexResolved();
  const out = normalize({
    ...spec,
    developers: [{ ...spec.developers[0]!, codex_remote_control: true }],
  });
  const host = (out.devbox_codex_units as Record<string, unknown>[])[0]!;
  const rc = (out.devbox_codex_remote_control_units as Record<string, unknown>[])[0]!;
  expect(rc.resources).toEqual(host.resources);
});

test("the paseo daemon is opt-in and off by default", () => {
  expect(normalize(resolved).devbox_paseo_units).toEqual([]);
});

// The gate settings are the point of managing this unit: a hand-started supervisor
// resolves bun/node/tsc straight from mise and inherits no budget, so every heavy job
// its agents spawn runs unqueued and unbounded.
test("an opted-in developer gets a paseo unit carrying the gate and its stated ceiling", () => {
  const units = normalize({
    ...resolved,
    developers: [{
      ...resolved.developers[0]!,
      paseo_daemon: true,
      paseo_resources: { memory_high: "40G", memory_max: "44G", memory_swap_max: "4G" },
    }],
  }).devbox_paseo_units as Record<string, unknown>[];

  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({
    user: "dev-a",
    heavy_job_gate_enabled: true,
    heavy_job_gate_categories: ["build", "typecheck", "generate", "test"],
  });
  expect(units[0]!.resources).toEqual({
    memory_high: "40G",
    memory_max: "44G",
    memory_swap_max: "4G",
  });
});

// Unlike every other service ceiling here, this one must not inherit the box-wide RC
// resources. That default is 12G, which is right for one project's session and fatal
// for a unit holding a developer's entire measured 28 GB fleet.
test("the paseo ceiling is never inherited from remote_control.resources", () => {
  const units = normalize({
    ...resolved,
    remote_control: { resources: { memory_high: "8G", memory_max: "12G", memory_swap_max: "1G" } },
    developers: [{
      ...resolved.developers[0]!,
      paseo_daemon: true,
      paseo_resources: { memory_max: "44G" },
    }],
  }).devbox_paseo_units as Record<string, unknown>[];

  expect(units[0]!.resources).toEqual({ memory_max: "44G" });
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

test("OMP model presets remain declarative data during normalization", () => {
  const spec: ResolvedSpec = {
    ...resolved,
    developers: [
      {
        ...resolved.developers[0]!,
        agent_profiles: {
          "omp-work": {
            provider: "omp",
            omp_model_presets: {
              default_preset: "openai",
              aliases: { codex: "openai" },
              presets: {
                openai: {
                  default: "openai-codex/gpt-5.6-sol:xhigh",
                  smol: "openai-codex/gpt-5.6-luna:medium",
                  slow: "openai-codex/gpt-5.6-sol:xhigh",
                  vision: "openai-codex/gpt-5.6-sol:xhigh",
                  plan: "openai-codex/gpt-5.6-sol:xhigh",
                  designer: "openai-codex/gpt-5.6-sol:xhigh",
                  commit: "openai-codex/gpt-5.6-luna:medium",
                  tiny: "openai-codex/gpt-5.6-luna:medium",
                  task: "openai-codex/gpt-5.6-sol:xhigh",
                  advisor: "openai-codex/gpt-5.6-sol:xhigh",
                },
              },
              retry: {
                model_fallback: true,
                usage_aware_fallback: true,
                usage_reserve_pct: 1,
                usage_reserve_policy: "auto",
                fallback_revert_policy: "cooldown-expiry",
                fallback_chains: {
                  "openai-codex/gpt-5.6-sol": [
                    "anthropic/claude-opus-5:xhigh",
                    "opencode-zen/mimo-v2.5-free",
                  ],
                },
              },
            },
          },
        },
      },
    ],
  } as ResolvedSpec;

  const profile = (normalize(spec).devbox_developers as Record<string, any>[])[0]?.agent_profiles["omp-work"];
  expect(profile.provider).toBe("omp");
  expect(profile.omp_model_presets).toEqual(spec.developers[0]?.agent_profiles?.["omp-work"]?.omp_model_presets);
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

test("heavy job gate defaults on and supports global and developer overrides", () => {
  const defaulted = normalize(resolved);
  expect((defaulted.devbox_host as any).heavy_job_gate).toEqual({
    enabled: true,
    categories: { build: true, typecheck: true, generate: true, test: true },
    wait_timeout_sec: 1800,
    warn_after_sec: 5,
    memory_max: "8G",
  });
  expect((defaulted.devbox_developers as any[])[0].heavy_job_gate).toEqual(
    (defaulted.devbox_host as any).heavy_job_gate,
  );

  const globallyOff = normalize({ ...resolved, host: { heavy_job_gate: { enabled: false } } } as ResolvedSpec);
  expect((globallyOff.devbox_developers as any[])[0].heavy_job_gate).toEqual({
    enabled: false,
    categories: { build: true, typecheck: true, generate: true, test: true },
    wait_timeout_sec: 1800,
    warn_after_sec: 5,
    memory_max: "8G",
  });

  const overridden = normalize({
    ...resolved,
    host: { heavy_job_gate: { enabled: false } },
    developers: [{ ...resolved.developers[0]!, heavy_job_gate: { enabled: true } }],
  } as ResolvedSpec);
  expect((overridden.devbox_developers as any[])[0].heavy_job_gate).toEqual({
    enabled: true,
    categories: { build: true, typecheck: true, generate: true, test: true },
    wait_timeout_sec: 1800,
    warn_after_sec: 5,
    memory_max: "8G",
  });
});

test("all heavy job categories can be disabled without falling back to defaults", () => {
  const out = normalize({
    ...codexResolved(),
    host: {
      heavy_job_gate: {
        categories: { build: false, typecheck: false, generate: false, test: false },
      },
    },
  } as ResolvedSpec);
  expect((out.devbox_codex_units as any[])[0].heavy_job_gate_categories).toEqual([]);
});

test("developer heavy job settings merge over host settings field by field", () => {
  const out = normalize({
    ...resolved,
    host: {
      heavy_job_gate: {
        enabled: true,
        categories: { test: false },
        wait_timeout_sec: 900,
        warn_after_sec: 10,
        memory_max: "6G",
      },
    },
    developers: [{
      ...resolved.developers[0]!,
      heavy_job_gate: { categories: { test: true, generate: false }, warn_after_sec: 2 },
    }],
  } as ResolvedSpec);
  const gate = (out.devbox_developers as any[])[0].heavy_job_gate;
  expect(gate).toEqual({
    enabled: true,
    categories: { build: true, typecheck: true, generate: false, test: true },
    wait_timeout_sec: 900,
    warn_after_sec: 2,
    // Stated once on the host and never restated by the developer: it has to survive
    // the field-by-field merge rather than snapping back to the built-in default.
    memory_max: "6G",
  });
  expect((out.devbox_codex_units as any[])).toEqual([]);
});

// The vendor tmpfs default is half of RAM, so a box that never declares this must
// still come out bounded rather than inheriting the thing that caused the incident.
test("host.tmp_size is always emitted, bounded by default", () => {
  expect((normalize(resolved).devbox_host as any).tmp_size).toBe("4G");
  const declared = normalize({ ...resolved, host: { tmp_size: "12G" } } as ResolvedSpec);
  expect((declared.devbox_host as any).tmp_size).toBe("12G");
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
  expect(b.reap).toEqual({ enabled: true, interval_sec: 300, grace_sec: 900 });
});

test("browser reap settings are taken verbatim when declared", () => {
  const spec: ResolvedSpec = {
    ...resolved,
    browser: { reap: { enabled: false, interval_sec: 600, grace_sec: 1800 } },
  };
  const b = normalize(spec).devbox_browser as Record<string, unknown>;
  expect(b.reap).toEqual({ enabled: false, interval_sec: 600, grace_sec: 1800 });
});

test("browser.mcp_port is always emitted, defaulted to 9522", () => {
  expect(normalize(resolved).devbox_browser).toMatchObject({ mcp_port: 9522 });
});

test("browser.mcp_port can be overridden", () => {
  const out = normalize({ ...resolved, browser: { mcp_port: 9600 } });
  expect(out.devbox_browser).toMatchObject({ mcp_port: 9600 });
});

/** Two browser-enabled developers around one that opted out, to pin the order. */
const browserResolved = (over: Partial<ResolvedSpec> = {}): ResolvedSpec => ({
  ...resolved,
  developers: [
    { ...resolved.developers[0]!, user: "dev-a", browser: true },
    { ...resolved.developers[0]!, user: "dev-b" },
    { ...resolved.developers[0]!, user: "dev-c", browser: true },
  ],
  ...over,
});

test("no browser-enabled developer means no MCP servers", () => {
  expect(normalize(resolved).devbox_browser).toMatchObject({ servers: [] });
});

test("each browser-enabled developer gets a server on their own port, in declaration order", () => {
  expect(normalize(browserResolved()).devbox_browser).toMatchObject({
    servers: [
      { user: "dev-a", port: 9522 },
      { user: "dev-c", port: 9523 },
    ],
  });
});

test("the MCP servers are assigned from the stated base port", () => {
  expect(normalize(browserResolved({ browser: { mcp_port: 9600 } })).devbox_browser).toMatchObject({
    mcp_port: 9600,
    servers: [
      { user: "dev-a", port: 9600 },
      { user: "dev-c", port: 9601 },
    ],
  });
});

// The unit's User= comes from the server row, never from chrome_user: on a box where
// failover is off that key is null, and on one where it is on it names a single account.
test("chrome_user does not decide who the MCP servers run as", () => {
  const withFailover = normalize(
    browserResolved({ browser: { failover: { enabled: true, chrome_user: "dev-c" } } }),
  ).devbox_browser as Record<string, any>;
  expect(withFailover.servers.map((s: { user: string }) => s.user)).toEqual(["dev-a", "dev-c"]);
  expect(normalize(browserResolved()).devbox_browser).toMatchObject({
    failover: expect.objectContaining({ chrome_user: null }),
    servers: [
      { user: "dev-a", port: 9522 },
      { user: "dev-c", port: 9523 },
    ],
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
