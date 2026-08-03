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
  GitIdentity,
  MemoryInstance,
  ProjectSpec,
  ResourceSpec,
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
      // The legacy format had no exposure switch: sshd listened everywhere the
      // firewall allowed, which is exactly public_and_tailscale.
      ssh: { exposure: "public_and_tailscale" },
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
    if (Array.isArray(profile.servers) && profile.servers.length) {
      issues.push(
        warn(
          `${path}.servers`,
          "always-on agent services are now declared per agent profile — redeclare them after migrating",
        ),
      );
    }
    for (const key of ["lazy_mounts", "sync_disk", "sync_engine"] as const) {
      if (profile[key] !== undefined) {
        issues.push(warn(`${path}.${key}`, "not represented in the canonical config yet — carry it over by hand"));
      }
    }

    const dev: DeveloperSpec = {
      user,
      // Every legacy profile is an account that already exists on a provisioned box.
      adopt_existing: true,
      login_ssh_keys: operatorKey ? [operatorKey] : [],
    };

    const resources = resourcesFrom(legacy.rc_limits);
    if (resources) dev.resources = resources;

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

function resourcesFrom(raw: unknown): ResourceSpec | null {
  if (!isRecord(raw)) return null;
  const out: ResourceSpec = {};
  for (const key of ["memory_high", "memory_max", "memory_swap_max"] as const) {
    const v = str(raw[key]);
    if (v) out[key] = v;
  }
  for (const key of ["cpu_weight", "io_weight"] as const) {
    if (typeof raw[key] === "number") out[key] = raw[key] as number;
  }
  return Object.keys(out).length ? out : null;
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

function projectsFrom(profile: Record<string, unknown>): ProjectSpec[] {
  const raw = Array.isArray(profile.projects) ? profile.projects : [];
  const out: ProjectSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name);
    const repo = str(entry.repo);
    if (!name || !repo) continue;
    const project: ProjectSpec = { name, repo };
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
