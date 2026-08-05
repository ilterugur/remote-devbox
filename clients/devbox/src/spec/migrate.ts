/**
 * migrate.ts — convert a legacy `group_vars/all.yml` into a canonical devbox.yml.
 *
 * Non-destructive by construction: this reads a plain object and returns a new one. It
 * never touches the box, never deletes anything, and never rewrites the legacy file.
 * Anything the legacy format expressed but the canonical one has no home for produces a
 * WARNING naming the key — a migration that silently drops a profile's sudo grant or its
 * always-on servers is worse than one that refuses to be quiet.
 *
 * The central mapping is the conflation being undone:
 *     legacy:    profile = Linux user = git identity = agent account
 *     canonical: developer = Linux user; identities/agents/spaces hang underneath it
 */
import { type Issue, warn } from "./issues";
import { CONFIG_VERSION, SUPPORTED_PLATFORM } from "./types";
import type {
  AgentProfile,
  AgentProvider,
  DeveloperSpec,
  DevboxSpec,
  FileBridgeSpec,
  GitIdentity,
  MemoryInstance,
  ProjectRemoteControlSpec,
  ProjectSpec,
  RcResourceSpec,
  RcSpawn,
  RemoteControlSpec,
  SyncEngineId,
} from "./types";
import { toYaml } from "./yaml";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined;

/** True when an object looks like the legacy profile-centric group_vars file. */
export const isLegacyConfig = (raw: unknown): boolean =>
  isRecord(raw) && Array.isArray(raw.profiles) && raw.developers === undefined;

export function migrateLegacy(legacy: Record<string, unknown>): { spec: DevboxSpec; issues: Issue[] } {
  const issues: Issue[] = [];
  const operatorKey = str(legacy.operator_ssh_pubkey);

  const spec: DevboxSpec = {
    config_version: CONFIG_VERSION,
    platform: { ...SUPPORTED_PLATFORM },
    operator: {
      user: str(legacy.operator_user) ?? "devbox-admin",
      ssh_authorized_keys: operatorKey ? [operatorKey] : [],
    },
    network: {
      tailscale: { enabled: legacy.tailscale_enabled !== false },
      // The legacy format had no such switch: sshd listened everywhere the firewall
      // allowed, which is exactly every path that existed.
      ssh: { access: legacy.tailscale_enabled !== false ? ["public", "tailnet"] : ["public"] },
    },
    container: {
      // `docker_enabled` meant the OPERATOR's system Docker, not a per-developer
      // engine — so it becomes shared_services, and developers start on rootless Podman.
      default_engine: "podman-rootless",
      install_engines: ["podman-rootless"],
    },
    shared_services: { enabled: legacy.docker_enabled !== false, engine: "system-docker" },
    developers: [],
  };

  const remoteControl = remoteControlFrom(legacy);
  if (remoteControl) spec.remote_control = remoteControl;

  const profiles = Array.isArray(legacy.profiles) ? legacy.profiles : [];
  if (profiles.length === 0) issues.push(warn("profiles", "no profiles found — nothing to migrate"));

  const memoryEnabled = legacy.hindsight_enabled !== false;
  const instance = memoryInstanceFrom(legacy);

  spec.developers = profiles.map((raw, i) => {
    const path = `profiles[${i}]`;
    const profile = isRecord(raw) ? raw : {};
    const user = str(profile.user) ?? `developer-${i}`;

    if (profile.sudo === true) {
      issues.push(
        warn(
          `${path}.sudo`,
          "developer sudo has no place in the developer model — grant it through the operator account, or re-add it deliberately after migrating",
        ),
      );
    }
    const bridge: FileBridgeSpec = {};
    if (profile.sync_disk === true) bridge.sync_disk = true;
    if (typeof profile.sync_engine === "string") bridge.engine = profile.sync_engine as SyncEngineId;
    if (Array.isArray(profile.lazy_mounts) && profile.lazy_mounts.length) {
      bridge.lazy_mounts = profile.lazy_mounts.map((m: Record<string, unknown>) => ({
        label: String(m.label),
        path: String(m.path),
      }));
    }
    if (profile.lazy_mount_on_connect === true) bridge.lazy_mount_on_connect = true;

    const dev: DeveloperSpec = {
      user,
      // Every legacy profile is an account that already exists on a provisioned box.
      adopt_existing: true,
      login_ssh_keys: operatorKey ? [operatorKey] : [],
    };
    if (Object.keys(bridge).length) dev.file_bridge = bridge;


    const identity = gitIdentityFrom(profile);
    if (identity) {
      dev.git_identities = { default: identity };
      dev.default_git_identity = "default";
    } else {
      issues.push(
        warn(`${path}.git_name`, "no git identity on this profile — the developer starts with unmanaged git"),
      );
    }

    const agents = agentProfilesFrom(profile, path, issues);
    if (Object.keys(agents).length) {
      dev.agent_profiles = agents;
      dev.default_agent_profile = Object.keys(agents)[0]!;
    }

    dev.memory = memoryEnabled
      ? {
          enabled: true,
          default_space: "shared",
          instances: { primary: instance },
          // The legacy format kept ONE profile-wide bank; that is exactly one shared space.
          spaces: { shared: { instance: "primary", bank: `${user}-shared` } },
        }
      : { enabled: false, instances: {}, spaces: {} };

    const projects = projectsFrom(profile);
    if (projects.length) dev.projects = projects;

    return dev;
  });

  if (str(legacy.hindsight_llm_api_key)) {
    issues.push(
      warn(
        "hindsight_llm_api_key",
        "secrets are never migrated — move the key into devbox.secrets.yml and point memory.instances.primary.api_key_env at it",
      ),
    );
  }
  if (legacy.hindsight_per_project === true) {
    issues.push(
      warn(
        "hindsight_per_project",
        "per-project banks become one memory space per project — declare them under the developer's memory.spaces",
      ),
    );
  }

  return { spec, issues };
}

function gitIdentityFrom(profile: Record<string, unknown>): GitIdentity | null {
  const name = str(profile.git_name);
  const email = str(profile.git_email);
  return name && email ? { name, email } : null;
}

function agentProfilesFrom(
  profile: Record<string, unknown>,
  path: string,
  issues: Issue[],
): Record<string, AgentProfile> {
  const declared = Array.isArray(profile.agents) ? profile.agents : ["claude"];
  const out: Record<string, AgentProfile> = {};
  for (const entry of declared) {
    const provider = str(entry);
    if (provider === "claude" || provider === "codex") {
      out[`${provider}-default`] = { provider: provider as AgentProvider };
    } else {
      issues.push(warn(`${path}.agents`, `unknown agent '${String(entry)}' — no adapter for it, skipped`));
    }
  }
  return out;
}

function memoryInstanceFrom(legacy: Record<string, unknown>): MemoryInstance {
  const instance: MemoryInstance = {
    engine: "hindsight",
    llm_provider: str(legacy.hindsight_llm_provider) ?? "openrouter",
  };
  const model = str(legacy.hindsight_llm_model);
  if (model) instance.llm_model = model;
  const baseUrl = str(legacy.hindsight_llm_base_url);
  if (baseUrl) instance.llm_base_url = baseUrl;
  return instance;
}

/**
 * Legacy rc_* variables → the canonical remote_control block. Empty-string knobs meant
 * "no limit for this one" in the legacy file, so they are dropped rather than carried
 * over as "" — the canonical model says nothing at all when there is no limit.
 */
function remoteControlFrom(legacy: Record<string, unknown>): RemoteControlSpec | null {
  const block: RemoteControlSpec = {};

  const limits = pruneEmpty(legacy.rc_limits);
  if (limits) block.resources = limits as RcResourceSpec;
  const buildEnv = pruneEmpty(legacy.rc_build_env);
  if (buildEnv) block.build_env = buildEnv as Record<string, string>;

  const autorestart = dropUndefined({
    enabled: bool(legacy.rc_autorestart),
    restart_sec: num(legacy.rc_restart_sec),
    burst: num(legacy.rc_start_limit_burst),
    interval: num(legacy.rc_start_limit_interval),
  });
  if (autorestart) block.autorestart = autorestart;

  const resume = dropUndefined({
    on_boot: bool(legacy.rc_resume_on_boot),
    lookback_h: num(legacy.rc_resume_lookback_h),
    max_concurrent: num(legacy.rc_resume_max_concurrent),
    settle_sec: num(legacy.rc_resume_settle_sec),
    min_free_mb: num(legacy.rc_resume_min_free_mb),
    max_attempts: num(legacy.rc_resume_max_attempts),
    timeout_sec: num(legacy.rc_resume_timeout_sec),
    skip_workflow_warning: bool(legacy.rc_resume_skip_workflow_warning),
  });
  if (resume) block.resume = resume;

  return Object.keys(block).length ? block : null;
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The subset of an object with a value, or null when that subset is empty. */
function dropUndefined<T extends Record<string, unknown>>(o: T): T | null {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(out).length ? out : null;
}

const pruneEmpty = (raw: unknown): Record<string, unknown> | null =>
  isRecord(raw) ? dropUndefined(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""))) : null;

/** The server entry for a project, or `false` when the legacy box ran no unit for it. */
function projectRemoteControl(servers: unknown, projectName: string): ProjectRemoteControlSpec | false {
  const list = Array.isArray(servers) ? servers.filter(isRecord) : [];
  const found = list.find((s) => s.project === projectName);
  if (!found) return false;
  return (
    dropUndefined({
      name: str(found.name),
      spawn: found.spawn as RcSpawn | undefined,
      capacity: num(found.capacity),
    }) ?? {}
  );
}

function projectsFrom(profile: Record<string, unknown>): ProjectSpec[] {
  const raw = Array.isArray(profile.projects) ? profile.projects : [];
  const out: ProjectSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name);
    const repo = str(entry.repo);
    if (!name || !repo) continue;
    const project: ProjectSpec = { name, repo, remote_control: projectRemoteControl(profile.servers, name) };
    const branch = str(entry.branch);
    if (branch) project.branch = branch;
    if (typeof entry.install === "boolean") project.install = entry.install;
    if (typeof entry.update === "boolean") project.update = entry.update;
    if (Array.isArray(entry.ports)) {
      const ports = entry.ports.filter((p): p is number => typeof p === "number");
      if (ports.length) project.ports = ports;
    }
    out.push(project);
  }
  return out;
}

const MIGRATION_HEADER = [
  "---",
  "# Migrated from a legacy group_vars/all.yml by `devbox migrate-config`.",
  "# REVIEW BEFORE APPLYING: split git identities / agent profiles / memory spaces as",
  "# you actually want them, then run `devbox plan`.",
  "",
].join("\n");

export function renderMigration(spec: DevboxSpec): string {
  return MIGRATION_HEADER + toYaml(spec as unknown as Record<string, unknown>);
}
