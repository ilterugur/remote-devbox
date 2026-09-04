/**
 * types.ts — the canonical config shape, plus the resolved shape produced after
 * every default/override chain in the design has been applied.
 *
 * Optional fields in *Spec mean "not stated in devbox.yml". In Resolved* nothing is
 * optional: `null` is the explicit "off / unmanaged" value, so Ansible never has to
 * re-derive a default.
 */
export const CONFIG_VERSION = 3;

export type EngineId = "podman-rootless" | "docker-rootless" | "none";
/**
 * Which paths sshd is reachable over. A list rather than three named combinations,
 * matching desktop.access — the old enum was a two-bit set encoded as names, and it had
 * no way to say "neither" (which is simply invalid).
 */
export type SshAccess = "public" | "tailnet";
export type AgentProvider = "claude" | "codex" | "omp";

export interface PlatformSpec {
  distribution: string;
  version: string;
  architecture: string;
}

export interface OperatorSpec {
  user: string;
  ssh_authorized_keys: string[];
  /** Client-side key used for the pre-hardening login probe. */
  private_key_path?: string;
}

/** systemd-oomd pressure thresholds, applied to each developer's UID-owned user manager.
 *  The limit is a percentage because that is what oomd accepts; the duration is the
 *  window the manager must remain above it before an eligible descendant is killed.
 *  Swap-based oomd killing stays disabled because it cannot safely honor a UID-owned
 *  child's omit preference; hard MemorySwapMax boundaries still apply. */
export interface OomdSpec {
  enabled?: boolean;
  memory_pressure_limit?: string;
  memory_pressure_duration_sec?: number;
}

export interface HeavyJobGateSpec {
  enabled?: boolean;
  categories?: Partial<Record<HeavyJobCategory, boolean>>;
  /** Zero waits forever; positive values fail the queued command after this many seconds. */
  wait_timeout_sec?: number;
  /** Zero logs immediately; positive values log only after this many seconds in queue. */
  warn_after_sec?: number;
  /** Ceiling for ONE gated job, as a systemd size. The queue bounds how many run at
   * once; this bounds how large one gets, so a runaway dies alone instead of
   * throttling every session sharing its agent host. "" disables the scope. */
  memory_max?: string;
}

export type HeavyJobCategory = "build" | "typecheck" | "generate" | "test";

/** Host tuning that is not part of the developer model. */
export interface HostSpec {
  swap_size?: string;
  memory_reserve?: string;
  /** Size bound for the tmpfs behind /tmp. Everything written there is resident memory
   * that can only be swapped, never dropped, and the vendor default is half of RAM —
   * not a bound at all. Over the wall a job gets ENOSPC and fails alone. A percentage
   * (e.g. "10%") is accepted and resolved by the kernel against RAM. */
  tmp_size?: string;
  oomd?: OomdSpec;
  zram?: { enabled: boolean; percent?: number; algo?: string; priority?: number };
  locales?: string[];
  mosh?: boolean;
  eternal_terminal?: boolean;
  harden_ssh?: boolean;
  hide_pids?: boolean;
  /** GitHub CLI (`gh`) from GitHub's own apt repo. On unless turned off. */
  github_cli?: boolean;
  umask?: string;
  /** Left at the kernel default when unset. */
  swappiness?: number;
  /** Serialize memory-heavy agent commands per Linux developer. Defaults on. */
  heavy_job_gate?: HeavyJobGateSpec;
}

export interface NetworkSpec {
  tailscale: { enabled: boolean };
  /** Defaults to public plus tailnet when Tailscale is on — see defaultSshAccess. */
  ssh: { access?: SshAccess[] };
}

export interface ContainerSpec {
  default_engine: EngineId;
  install_engines: EngineId[];
}

export interface SharedServicesSpec {
  enabled: boolean;
  engine: "system-docker";
}

/** bun's compile targets, minus the "bun-" prefix. */
export type CliTarget = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export const CLI_TARGETS: CliTarget[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

export const DEFAULT_CLI_TARGETS: CliTarget[] = ["darwin-arm64", "darwin-x64", "linux-x64"];

/**
 * What the box hands a laptop. The CLI is published as a compiled binary per platform so
 * a developer needs neither this repo nor a Bun install — see roles/box_cli.
 */
export interface ClientsSpec {
  /** Defaults to the three platforms a developer laptop is usually one of. */
  cli_targets?: CliTarget[];
}

export interface GitIdentity {
  name: string;
  email: string;
  github_user?: string;
}

export const OMP_MODEL_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
] as const;

export type OmpModelRole = (typeof OMP_MODEL_ROLE_IDS)[number];
export type OmpModelRoleMap = Record<OmpModelRole, string>;

export type OmpUsageReservePolicy = "confirm" | "auto" | "fail-closed";
export type OmpFallbackRevertPolicy = "cooldown-expiry" | "never";

export interface OmpRetryPolicySpec {
  model_fallback: boolean;
  usage_aware_fallback: boolean;
  usage_reserve_pct: number;
  usage_reserve_policy: OmpUsageReservePolicy;
  fallback_revert_policy: OmpFallbackRevertPolicy;
  fallback_chains: Record<string, string[]>;
}

export interface OmpModelPresetsSpec {
  default_preset: string;
  aliases?: Record<string, string>;
  presets: Record<string, OmpModelRoleMap>;
  retry?: OmpRetryPolicySpec;
}

export interface AgentProfile {
  provider: AgentProvider;
  memory_space?: string;
  /** Runtime-only OMP role maps. Models and preset names remain inventory data. */
  omp_model_presets?: OmpModelPresetsSpec;
}

export interface MemoryInstance {
  engine: "hindsight";
  llm_provider: string;
  llm_model?: string;
  llm_base_url?: string;
  api_key_env?: string;
}

export interface MemorySpace {
  instance: string;
  bank: string;
}

export interface MemorySpec {
  enabled: boolean;
  default_space?: string;
  /** Absent is equivalent to an empty map — `memory: {enabled: false}` is valid input. */
  instances?: Record<string, MemoryInstance>;
  spaces?: Record<string, MemorySpace>;
}

/**
 * How the desktop is reachable. Not mutually exclusive: xrdp accepts several
 * address:port pairs, so [tunnel, tailnet] really does listen on both and the client
 * picks by which address it dials.
 *
 * "unsafe-public" carries its warning in the name on purpose — RDP authenticates with a
 * PAM password, so putting it on the internet is a different class of risk from every
 * other door on the box, all of which are key-only.
 */
export type DesktopAccess = "tunnel" | "tailnet" | "unsafe-public";

/**
 * A keyboard as XKB names it — the vocabulary the box speaks, not the client's. `tr`
 * with no variant is the Turkish Q keyboard; `tr` variant `f` is the F one.
 */
export interface KeyboardSpec {
  layout: string;
  variant?: string;
}

/** A keyboard as detected or stated, before the RDP id is worked out. */
export interface XkbKeyboard {
  layout: string;
  variant: string | null;
}

/**
 * What the desktop role receives: the layout plus the id it announces itself as over
 * RDP, which is the key xrdp's own mapping table is indexed by. Null when we don't know
 * the id — the box is then left on xrdp's shipped table rather than taught a guess.
 */
export interface ResolvedKeyboard extends XkbKeyboard {
  rdp_layout_id: string | null;
}

/**
 * What the machine running the CLI can tell us about itself. Injected rather than read,
 * so spec/ stays a pure function of the config plus these.
 */
export interface ClientFacts {
  keyboard: XkbKeyboard | null;
}

export interface DesktopSpec {
  enabled: boolean;
  environment: "xfce";
  transport: "xrdp";
  /** Defaults to tunnel plus tailnet when Tailscale is on — see defaultDesktopAccess. */
  access?: DesktopAccess[];
  idle_logout_minutes?: number;
  /**
   * The port on YOUR machine that the always-on desktop tunnel listens on, and therefore
   * the address a saved RDP entry dials. Defaults to 3389 and upward in devbox.yml order;
   * state it when you want the address pinned no matter who else gets a desktop.
   */
  client_port?: number;
  /**
   * Defaults to whatever keyboard the client is typing on (see keyboard.ts). xrdp maps
   * only some announced layout ids and falls back to `us` in silence for the rest, so an
   * undetected and unstated layout is the one case where the desktop is quietly wrong.
   */
  keyboard?: KeyboardSpec;
}

export type SyncEngineId = "mutagen" | "syncthing";

/**
 * One client path the box can see on demand. `label` names the mountpoint the box
 * creates (`~/mnt/<label>`), so it has to be usable as a directory name.
 */
export interface LazyMountSpec {
  label: string;
  path: string;
}

/**
 * The client<->box file bridge: a two-way sync disk, and read-only mounts of client
 * paths that exist only while `devbox mount` is running.
 */
export interface FileBridgeSpec {
  sync_disk?: boolean;
  engine?: SyncEngineId;
  lazy_mounts?: LazyMountSpec[];
  /** Bring the mounts up automatically when connecting, rather than on request. */
  lazy_mount_on_connect?: boolean;
}

export interface AppConfigsSpec {
  enabled?: boolean;
  /** Registry key (string) or a full definition (object). */
  paths?: (string | Record<string, unknown>)[];
}

export interface MemoryWeightSpec {
  weight: number;
}

export type MemoryLimitSpec = string | MemoryWeightSpec;

export const SLICE_RESOURCE_KEYS = [
  "memory_high",
  "memory_max",
  "memory_swap_max",
  "cpu_weight",
  "io_weight",
  "tasks_max",
] as const;
export const SERVICE_RESOURCE_KEYS = [
  ...SLICE_RESOURCE_KEYS,
  "nice",
  "oom_score_adjust",
  "cpu_quota",
  "oom_policy",
] as const;

export interface ResourceSpec {
  memory_high?: MemoryLimitSpec;
  memory_max?: string;
  memory_swap_max?: string;
  cpu_weight?: number;
  io_weight?: number;
  tasks_max?: number;
}

export type RcSpawn = "worktree" | "same-dir" | "session";

/** systemd's `OOMPolicy`. `continue` keeps the unit alive when the kernel kills one
 *  process in its cgroup, so a runaway build dies without taking the session set. */
export type OomPolicy = "continue" | "stop" | "kill";

/**
 * Resource knobs for one Remote Control unit. Extends the slice knobs with the four
 * systemd properties that only mean something on a service: build niceness, the
 * kernel OOM bias (`oom_score_adjust`), an absolute CPU cap, and the OOM kill policy
 * (`oom_policy`).
 */
export interface RcResourceSpec extends ResourceSpec {
  nice?: number;
  oom_score_adjust?: number;
  cpu_quota?: string;
  oom_policy?: OomPolicy;
}

export interface RcAutorestartSpec {
  enabled?: boolean;
  restart_sec?: number;
  burst?: number;
  interval?: number;
}

export interface RcResumeSpec {
  on_boot?: boolean;
  lookback_h?: number;
  max_concurrent?: number;
  settle_sec?: number;
  min_free_mb?: number;
  max_attempts?: number;
  timeout_sec?: number;
  /** Defaults to `on_boot`: a resumed session that stops for a usage prompt is not resumed. */
  skip_workflow_warning?: boolean;
}

/**
 * Reaping of processes stranded by removed `spawn: worktree` worktrees. A session's
 * dev servers and bundlers outlive the worktree they were started in, and they
 * accumulate until the unit crosses MemoryHigh and every session in it throttles.
 */
export interface RcReapSpec {
  enabled?: boolean;
  interval_sec?: number;
  /** How long a process must be observed as an orphan before it is killed. */
  grace_sec?: number;
}

/** Box-wide Remote Control defaults. Every project inherits these unless it says otherwise. */
export interface RemoteControlSpec {
  enabled?: boolean;
  spawn?: RcSpawn;
  capacity?: number;
  resources?: RcResourceSpec;
  build_env?: Record<string, string>;
  autorestart?: RcAutorestartSpec;
  resume?: RcResumeSpec;
  reap?: RcReapSpec;
}

/** One project's override. `resources` and `build_env` merge over the box defaults. */
export interface ProjectRemoteControlSpec {
  enabled?: boolean;
  /** Title shown in the phone app. Defaults to "<user> · <project>". */
  name?: string;
  spawn?: RcSpawn;
  capacity?: number;
  resources?: RcResourceSpec;
  build_env?: Record<string, string>;
}

/** Chrome and the browser MCP servers. Chrome is installed once for the whole box. */
export interface BrowserSpec {
  enabled?: boolean;
  /** Base of the playwright MCP port range: one server per browser-enabled developer,
   *  from here upward in declaration order. One server serves every session that
   *  developer runs; the alternative is one spawned process per session. */
  mcp_port?: number;
  failover?: BrowserFailoverSpec;
  reap?: BrowserReapSpec;
}

/**
 * A shared CDP endpoint the MCP servers attach to instead of each launching their own
 * headless Chrome: a reverse tunnel to the client's browser when it is online, a
 * box-local Chrome when it is not.
 */
export interface BrowserFailoverSpec {
  enabled?: boolean;
  /**
   * The developer whose account runs the box-local fallback Chrome, and nothing else.
   * Each MCP server runs as its own developer whatever this says.
   */
  chrome_user?: string;
  cdp_port?: number;
  fallback_chrome_port?: number;
  client_tunnel_port?: number;
  /** When client mode is selected, bind every configured project port on the client. */
  autobind?: boolean;
}

/**
 * Reaping of Chrome instances stranded when the agent session that launched them dies.
 * They are reparented to `systemd --user`, keep their throwaway automation profile, and
 * hold on to a browser's worth of RSS each until the box is swapping.
 */
export interface BrowserReapSpec {
  enabled?: boolean;
  interval_sec?: number;
  /** How long a Chrome must be observed orphaned, across sweeps, before it is killed. */
  grace_sec?: number;
}

/** A curated config tree on the client, copied into this developer's agent config. */
export interface AgentConfigSpec {
  /** Client-side path, absolute or relative to the repo root. */
  source: string;
  /** settings.json is machine-coupled, so it is left out unless asked for. */
  include_settings?: boolean;
}

export interface ProjectSpec {
  name: string;
  repo: string;
  branch?: string;
  git_identity?: string;
  agent_profile?: string;
  memory_space?: string;
  container_engine?: EngineId;
  ports?: number[];
  install?: boolean;
  update?: boolean;
  /** `false` turns Remote Control off for this project. */
  remote_control?: ProjectRemoteControlSpec | false;
}

export interface DeveloperSpec {
  user: string;
  adopt_existing?: boolean;
  login_ssh_keys: string[];
  resources?: ResourceSpec;
  /** Resource overrides for this developer's Codex Desktop code-mode host. The host
   * aggregates every Codex project, so it may need more headroom than one RC unit. */
  codex_host_resources?: RcResourceSpec;
  /** Run the always-on Codex Remote Control daemon for this developer. It is a second
   * Codex login, not the code-mode host: its own CODEX_HOME under
   * `.agent-profiles/codex-remote-control`, its own control socket. Declared here so
   * the unit carries the heavy-job gate and the host resource limits that a daemon
   * started by hand does not. */
  codex_remote_control?: boolean;
  /** Run the Paseo daemon as a managed user service for this developer.
   *
   * Paseo's own `paseo daemon start` is a foreground supervisor, so whoever launches it
   * owns its cgroup. Started from an interactive SSH session it lands in THAT session's
   * scope — and when the session leader dies the supervisor reparents to init while its
   * cgroup stays behind, under a slice belonging to the wrong user with no ceiling at
   * all. Measured 2026-08-31 on this box: 136 processes of one developer sat in another
   * user's login scope at `MemoryMax=infinity`, so neither the per-developer wall nor
   * the heavy-job gate reached the agent fleet, and four separate `bun tsc` runaways
   * (16-33 GB RSS each) drove the host into global OOM instead of dying alone.
   *
   * Declared here so the unit carries what a hand-started supervisor cannot: the
   * developer's own slice, the heavy-job gate on PATH, and a hard MemoryMax. */
  paseo_daemon?: boolean;
  /** Resource ceiling for the Paseo daemon unit. Required when `paseo_daemon` is set:
   * this unit aggregates every agent session the developer runs, so the box-wide
   * `remote_control.resources` default (12G) is not a safe fallback — measured baseline
   * on this box is 28 GB across 14 sessions, and starting under a 12G wall would kill
   * the fleet on the first apply. State the ceiling from measurement instead. */
  paseo_resources?: RcResourceSpec;
  /** Overrides host.heavy_job_gate for this Linux developer. */
  heavy_job_gate?: HeavyJobGateSpec;
  container_engine?: EngineId;
  git_identities?: Record<string, GitIdentity>;
  default_git_identity?: string;
  /** Exact provider binary versions installed once per developer. OMP is deliberately
   * pinned here (rather than per profile) because all profiles share one binary. */
  agent_versions?: Partial<Record<AgentProvider, string>>;
  agent_profiles?: Record<string, AgentProfile>;
  default_agent_profile?: string;
  memory?: MemorySpec;
  desktop?: DesktopSpec;
  file_bridge?: FileBridgeSpec;
  app_configs?: AppConfigsSpec;
  /** Wire the browser MCP servers into this developer's agent config. */
  browser?: boolean;
  agent_config?: AgentConfigSpec;
  projects?: ProjectSpec[];
}

export interface DevboxSpec {
  config_version: number;
  allow_unsupported_platform?: boolean;
  platform: PlatformSpec;
  host?: HostSpec;
  /** Shared toolchain versions installed once via mise, e.g. {node: "lts"}. */
  runtimes?: Record<string, string>;
  operator: OperatorSpec;
  network: NetworkSpec;
  container: ContainerSpec;
  remote_control?: RemoteControlSpec;
  browser?: BrowserSpec;
  shared_services?: SharedServicesSpec;
  clients?: ClientsSpec;
  developers: DeveloperSpec[];
}

/** One Remote Control unit, with every default already applied. */
export interface ResolvedRcUnit {
  /** The agent binary the unit runs — the resolved agent profile's provider. */
  agent: string;
  /** The profile whose launcher environment the session has to reproduce. */
  agent_profile: string;
  /**
   * The provider's config-dir variable and the profile tree it must point at. The unit
   * carries both because an RC session execs the agent binary directly instead of going
   * through the profile launcher: without them it reads the developer's default tree and
   * runs a different login than the one `remote-devbox-login` wrote.
   */
  config_env: string;
  config_dir: string;
  name: string;
  spawn: RcSpawn;
  capacity: number;
  resources: RcResourceSpec;
  build_env: Record<string, string>;
}

export interface ResolvedProject {
  name: string;
  repo: string;
  branch: string;
  /** null = this project's git stays unmanaged (no identity declared). */
  git_identity: string | null;
  /** null = no agent profile applies to this project. */
  agent_profile: string | null;
  /** "none" = no container engine for this project. */
  container_engine: EngineId;
  /** null = memory is off for this project. */
  memory_space: string | null;
  ports: number[];
  install: boolean;
  update: boolean;
  /** null = no Remote Control unit for this project. */
  remote_control: ResolvedRcUnit | null;
}

export interface ResolvedDeveloper extends Omit<DeveloperSpec, "projects"> {
  projects: ResolvedProject[];
}

export interface ResolvedSpec extends Omit<DevboxSpec, "developers"> {
  developers: ResolvedDeveloper[];
}

/** The exact platform this release supports. Anything else needs the escape hatch. */
export const SUPPORTED_PLATFORM: PlatformSpec = {
  distribution: "ubuntu",
  version: "26.04",
  architecture: "amd64",
};
