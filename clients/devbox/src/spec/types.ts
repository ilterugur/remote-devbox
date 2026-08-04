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
export type SshExposure = "public_and_tailscale" | "tailscale_only" | "public_only";
export type AgentProvider = "claude" | "codex";

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

/** Host tuning that is not part of the developer model. */
export interface HostSpec {
  swap_size?: string;
  zram?: { enabled: boolean; percent?: number; algo?: string; priority?: number };
  locales?: string[];
  mosh?: boolean;
  eternal_terminal?: boolean;
  harden_ssh?: boolean;
  hide_pids?: boolean;
  umask?: string;
}

export interface NetworkSpec {
  tailscale: { enabled: boolean };
  ssh: { exposure: SshExposure };
}

export interface ContainerSpec {
  default_engine: EngineId;
  install_engines: EngineId[];
}

export interface SharedServicesSpec {
  enabled: boolean;
  engine: "system-docker";
}

export interface GitIdentity {
  name: string;
  email: string;
  github_user?: string;
}

export interface AgentProfile {
  provider: AgentProvider;
  memory_space?: string;
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

export interface DesktopSpec {
  enabled: boolean;
  environment: "xfce";
  transport: "xrdp";
  /** Defaults to ["tunnel"]: reachable only through an SSH tunnel. */
  access?: DesktopAccess[];
  idle_logout_minutes?: number;
}

export interface ResourceSpec {
  memory_high?: string;
  memory_max?: string;
  memory_swap_max?: string;
  cpu_weight?: number;
  io_weight?: number;
  tasks_max?: number;
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
}

export interface DeveloperSpec {
  user: string;
  adopt_existing?: boolean;
  login_ssh_keys: string[];
  resources?: ResourceSpec;
  container_engine?: EngineId;
  git_identities?: Record<string, GitIdentity>;
  default_git_identity?: string;
  agent_profiles?: Record<string, AgentProfile>;
  default_agent_profile?: string;
  memory?: MemorySpec;
  desktop?: DesktopSpec;
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
  shared_services?: SharedServicesSpec;
  developers: DeveloperSpec[];
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
