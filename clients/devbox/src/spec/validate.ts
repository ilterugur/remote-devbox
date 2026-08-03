/**
 * validate.ts — structural validation of a parsed devbox.yml.
 *
 * Answers exactly one question: "is this object shaped like a DevboxSpec?" Cross-
 * references between sections (does this git_identity exist?) are references.ts's job,
 * and default resolution is resolve.ts's. Collects every issue in one pass; returns a
 * typed spec only when no error was produced.
 */
import { type Issue, err, hasErrors, warn } from "./issues";
import {
  CONFIG_VERSION,
  type DevboxSpec,
  type EngineId,
  SUPPORTED_PLATFORM,
  type SshExposure,
} from "./types";

export const USERNAME_RE = /^[a-z_][a-z0-9_-]*$/;
const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const ENGINES: readonly string[] = ["podman-rootless", "docker-rootless", "none"] satisfies EngineId[];
const EXPOSURES: readonly string[] = [
  "public_and_tailscale",
  "tailscale_only",
  "public_only",
] satisfies SshExposure[];
const PROVIDERS: readonly string[] = ["claude", "codex"];
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
/**
 * An agent profile becomes a launcher script on the developer's PATH. Naming a profile
 * after the agent's own binary makes the launcher overwrite that binary and then exec
 * itself — so the collision is rejected here rather than discovered as a fork bomb.
 */
const RESERVED_PROFILE_NAMES: readonly string[] = ["claude", "codex", "mise", "git", "node", "bun"];

export const isSshPublicKey = (s: unknown): boolean =>
  typeof s === "string" && /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]+/.test(s.trim());

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function validateStructure(raw: unknown): { spec: DevboxSpec | null; issues: Issue[] } {
  if (!isRecord(raw)) {
    return { spec: null, issues: [err("", "devbox.yml must be a YAML mapping at the top level")] };
  }

  // Shape gate first, and it short-circuits: running a legacy profile-style file
  // through this schema produces a wall of noise that hides the one thing to do.
  const version = raw.config_version;
  if (typeof version !== "number") {
    return {
      spec: null,
      issues: [err("config_version", `missing config_version (expected ${CONFIG_VERSION})`)],
    };
  }
  if (version !== CONFIG_VERSION) {
    return {
      spec: null,
      issues: [
        err(
          "config_version",
          `unsupported config_version ${version} — if this is a legacy group_vars file, run 'devbox migrate-config'`,
        ),
      ],
    };
  }

  const issues: Issue[] = [];
  validatePlatform(raw, issues);
  validateRuntimes(raw, issues);
  validateHost(raw, issues);
  validateOperator(raw, issues);
  validateNetwork(raw, issues);
  validateContainer(raw, issues);
  validateSharedServices(raw, issues);
  validateDevelopers(raw, issues);

  return { spec: hasErrors(issues) ? null : (raw as unknown as DevboxSpec), issues };
}

function validatePlatform(raw: Record<string, unknown>, issues: Issue[]): void {
  // The escape hatch downgrades the platform gate to a warning — deliberately loud,
  // never silent, because every role below assumes the supported matrix.
  const level = raw.allow_unsupported_platform === true ? warn : err;
  const supported = `${SUPPORTED_PLATFORM.distribution} ${SUPPORTED_PLATFORM.version} ${SUPPORTED_PLATFORM.architecture}`;
  const p = raw.platform;
  if (!isRecord(p)) {
    issues.push(level("platform", `missing platform section (supported: ${supported})`));
    return;
  }
  const keys = ["distribution", "version", "architecture"] as const;
  const wrong = keys.filter((k) => String(p[k] ?? "") !== SUPPORTED_PLATFORM[k]);
  if (wrong.length) {
    const detail = wrong.map((k) => `${k} '${String(p[k] ?? "")}'`).join(", ");
    issues.push(level("platform", `unsupported ${detail} (supported: ${supported})`));
  }
}

function validateRuntimes(raw: Record<string, unknown>, issues: Issue[]): void {
  const r = raw.runtimes;
  if (r === undefined) return;
  if (!isRecord(r)) {
    issues.push(err("runtimes", "must be a mapping of tool -> version"));
    return;
  }
  for (const [tool, version] of Object.entries(r)) {
    if (!isNonEmptyString(version)) {
      issues.push(err(`runtimes.${tool}`, "must be a version string, 'lts' or 'latest'"));
    }
  }
}

function validateHost(raw: Record<string, unknown>, issues: Issue[]): void {
  const h = raw.host;
  if (h === undefined) return;
  if (!isRecord(h)) {
    issues.push(err("host", "must be a mapping"));
    return;
  }
  if (h.swap_size !== undefined && !(typeof h.swap_size === "string" && /^\d+[KMGT]?$/.test(h.swap_size))) {
    issues.push(err("host.swap_size", "must be a size like '8G'"));
  }
  for (const k of ["mosh", "eternal_terminal", "harden_ssh", "hide_pids"] as const) {
    if (h[k] !== undefined && typeof h[k] !== "boolean") issues.push(err(`host.${k}`, "must be true or false"));
  }
  if (h.umask !== undefined && !(typeof h.umask === "string" && /^[0-7]{3,4}$/.test(h.umask))) {
    issues.push(err("host.umask", "must be an octal umask like '077'"));
  }
  if (h.locales !== undefined && !(Array.isArray(h.locales) && h.locales.every(isNonEmptyString))) {
    issues.push(err("host.locales", "must be a list of locale names"));
  }
  const z = h.zram;
  if (z !== undefined) {
    if (!isRecord(z)) {
      issues.push(err("host.zram", "must be a mapping"));
    } else {
      if (typeof z.enabled !== "boolean") issues.push(err("host.zram.enabled", "must be true or false"));
      if (z.percent !== undefined && !(typeof z.percent === "number" && z.percent > 0 && z.percent <= 100)) {
        issues.push(err("host.zram.percent", "must be 1..100"));
      }
    }
  }
}

function validateOperator(raw: Record<string, unknown>, issues: Issue[]): void {
  const o = raw.operator;
  if (!isRecord(o)) {
    issues.push(err("operator", "missing operator section"));
    return;
  }
  if (typeof o.user !== "string" || !USERNAME_RE.test(o.user)) {
    issues.push(err("operator.user", `'${String(o.user)}' is not a valid Linux username`));
  }
  const keys = o.ssh_authorized_keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    issues.push(err("operator.ssh_authorized_keys", "at least one SSH public key is required"));
    return;
  }
  keys.forEach((k, i) => {
    if (!isSshPublicKey(k)) {
      issues.push(err(`operator.ssh_authorized_keys[${i}]`, "not an SSH public key"));
    }
  });
}

function validateNetwork(raw: Record<string, unknown>, issues: Issue[]): void {
  const n = raw.network;
  if (!isRecord(n)) {
    issues.push(err("network", "missing network section"));
    return;
  }
  const ts = isRecord(n.tailscale) ? n.tailscale : null;
  if (!ts || typeof ts.enabled !== "boolean") {
    issues.push(err("network.tailscale.enabled", "must be true or false"));
  }
  const ssh = isRecord(n.ssh) ? n.ssh : null;
  const exposure = ssh?.exposure;
  if (typeof exposure !== "string" || !EXPOSURES.includes(exposure)) {
    issues.push(err("network.ssh.exposure", `must be one of: ${EXPOSURES.join(", ")}`));
    return;
  }
  if (exposure === "tailscale_only" && ts?.enabled === false) {
    issues.push(
      err("network.ssh.exposure", "tailscale_only requires network.tailscale.enabled: true"),
    );
  }
}

function validateContainer(raw: Record<string, unknown>, issues: Issue[]): void {
  const c = raw.container;
  if (!isRecord(c)) {
    issues.push(err("container", "missing container section"));
    return;
  }
  const installs = c.install_engines;
  const installsOk =
    Array.isArray(installs) && installs.length > 0 && installs.every((e) => ENGINES.includes(String(e)));
  if (!installsOk) {
    issues.push(
      err("container.install_engines", `must be a non-empty list of: ${ENGINES.join(", ")}`),
    );
  }
  const def = c.default_engine;
  if (typeof def !== "string" || !ENGINES.includes(def)) {
    issues.push(err("container.default_engine", `must be one of: ${ENGINES.join(", ")}`));
    return;
  }
  if (def !== "none" && installsOk && !(installs as string[]).includes(def)) {
    issues.push(err("container.default_engine", `'${def}' is not listed in container.install_engines`));
  }
}

function validateSharedServices(raw: Record<string, unknown>, issues: Issue[]): void {
  const s = raw.shared_services;
  if (s === undefined) return;
  if (!isRecord(s)) {
    issues.push(err("shared_services", "must be a mapping"));
    return;
  }
  if (typeof s.enabled !== "boolean") {
    issues.push(err("shared_services.enabled", "must be true or false"));
  }
  if (s.engine !== undefined && s.engine !== "system-docker") {
    issues.push(err("shared_services.engine", "only 'system-docker' is supported"));
  }
}

function validateDevelopers(raw: Record<string, unknown>, issues: Issue[]): void {
  const devs = raw.developers;
  if (!Array.isArray(devs) || devs.length === 0) {
    issues.push(err("developers", "at least one developer is required"));
    return;
  }
  devs.forEach((d, i) => validateDeveloper(d, `developers[${i}]`, issues));
}

function validateDeveloper(d: unknown, base: string, issues: Issue[]): void {
  if (!isRecord(d)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  if (typeof d.user !== "string" || !USERNAME_RE.test(d.user)) {
    issues.push(err(`${base}.user`, `'${String(d.user)}' is not a valid Linux username`));
  }
  if (d.adopt_existing !== undefined && typeof d.adopt_existing !== "boolean") {
    issues.push(err(`${base}.adopt_existing`, "must be true or false"));
  }
  if (d.container_engine !== undefined && !ENGINES.includes(String(d.container_engine))) {
    issues.push(err(`${base}.container_engine`, `must be one of: ${ENGINES.join(", ")}`));
  }

  const keys = d.login_ssh_keys;
  if (keys === undefined || (Array.isArray(keys) && keys.length === 0)) {
    issues.push(warn(`${base}.login_ssh_keys`, "no key can log in as this developer"));
  } else if (!Array.isArray(keys)) {
    issues.push(err(`${base}.login_ssh_keys`, "must be a list of SSH public keys"));
  } else {
    keys.forEach((k, j) => {
      if (!isSshPublicKey(k)) issues.push(err(`${base}.login_ssh_keys[${j}]`, "not an SSH public key"));
    });
  }

  validateResources(d.resources, `${base}.resources`, issues);
  validateGitIdentities(d, base, issues);
  validateAgentProfiles(d, base, issues);
  validateMemory(d.memory, `${base}.memory`, issues);
  validateDesktop(d.desktop, `${base}.desktop`, issues);
  validateProjects(d.projects, `${base}.projects`, issues);
}

function validateResources(r: unknown, base: string, issues: Issue[]): void {
  if (r === undefined) return;
  if (!isRecord(r)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  for (const k of ["memory_high", "memory_max", "memory_swap_max"] as const) {
    // systemd byte suffixes; "" means "no limit for this knob".
    if (r[k] !== undefined && !(typeof r[k] === "string" && /^(\d+[KMGT]?|)$/.test(String(r[k])))) {
      issues.push(err(`${base}.${k}`, "must be a systemd size like '10G' (or '' for no limit)"));
    }
  }
  for (const k of ["cpu_weight", "io_weight", "tasks_max"] as const) {
    if (r[k] !== undefined && !(typeof r[k] === "number" && Number.isInteger(r[k]) && (r[k] as number) > 0)) {
      issues.push(err(`${base}.${k}`, "must be a positive integer"));
    }
  }
}

function validateGitIdentities(d: Record<string, unknown>, base: string, issues: Issue[]): void {
  const gi = d.git_identities;
  if (gi !== undefined) {
    if (!isRecord(gi)) {
      issues.push(err(`${base}.git_identities`, "must be a mapping of key -> identity"));
    } else {
      for (const [key, val] of Object.entries(gi)) {
        const p = `${base}.git_identities.${key}`;
        if (!isRecord(val)) {
          issues.push(err(p, "must be a mapping"));
          continue;
        }
        if (!isNonEmptyString(val.name)) issues.push(err(`${p}.name`, "is required"));
        if (!isNonEmptyString(val.email)) issues.push(err(`${p}.email`, "is required"));
      }
    }
  }
  if (d.default_git_identity !== undefined && !isNonEmptyString(d.default_git_identity)) {
    issues.push(err(`${base}.default_git_identity`, "must be a git identity key"));
  }
}

function validateAgentProfiles(d: Record<string, unknown>, base: string, issues: Issue[]): void {
  const ap = d.agent_profiles;
  if (ap !== undefined) {
    if (!isRecord(ap)) {
      issues.push(err(`${base}.agent_profiles`, "must be a mapping of key -> profile"));
    } else {
      for (const [key, val] of Object.entries(ap)) {
        const p = `${base}.agent_profiles.${key}`;
        if (!PROFILE_NAME_RE.test(key)) {
          issues.push(err(p, `'${key}' must match ${PROFILE_NAME_RE.source} — it becomes a launcher filename`));
        }
        if (RESERVED_PROFILE_NAMES.includes(key)) {
          issues.push(
            err(
              p,
              `'${key}' is the name of a command on PATH; its launcher would shadow (and then exec) itself — pick something like '${key}-work'`,
            ),
          );
        }
        if (!isRecord(val)) {
          issues.push(err(p, "must be a mapping"));
          continue;
        }
        if (typeof val.provider !== "string" || !PROVIDERS.includes(val.provider)) {
          issues.push(err(`${p}.provider`, `must be one of: ${PROVIDERS.join(", ")}`));
        }
        if (val.memory_space !== undefined && !isNonEmptyString(val.memory_space)) {
          issues.push(err(`${p}.memory_space`, "must be a memory space key (or 'none')"));
        }
      }
    }
  }
  if (d.default_agent_profile !== undefined && !isNonEmptyString(d.default_agent_profile)) {
    issues.push(err(`${base}.default_agent_profile`, "must be an agent profile key"));
  }
}

function validateMemory(m: unknown, base: string, issues: Issue[]): void {
  if (m === undefined) return;
  if (!isRecord(m)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  if (typeof m.enabled !== "boolean") {
    issues.push(err(`${base}.enabled`, "must be true or false"));
  }
  if (m.default_space !== undefined && !isNonEmptyString(m.default_space)) {
    issues.push(err(`${base}.default_space`, "must be a memory space key"));
  }
  const instances = m.instances;
  if (instances !== undefined) {
    if (!isRecord(instances)) {
      issues.push(err(`${base}.instances`, "must be a mapping of key -> instance"));
    } else {
      for (const [key, val] of Object.entries(instances)) {
        const p = `${base}.instances.${key}`;
        if (!isRecord(val)) {
          issues.push(err(p, "must be a mapping"));
          continue;
        }
        if (val.engine !== "hindsight") issues.push(err(`${p}.engine`, "only 'hindsight' is supported"));
        if (!isNonEmptyString(val.llm_provider)) issues.push(err(`${p}.llm_provider`, "is required"));
      }
    }
  }
  const spaces = m.spaces;
  if (spaces !== undefined) {
    if (!isRecord(spaces)) {
      issues.push(err(`${base}.spaces`, "must be a mapping of key -> space"));
    } else {
      for (const [key, val] of Object.entries(spaces)) {
        const p = `${base}.spaces.${key}`;
        if (!isRecord(val)) {
          issues.push(err(p, "must be a mapping"));
          continue;
        }
        if (!isNonEmptyString(val.instance)) issues.push(err(`${p}.instance`, "is required"));
        if (!isNonEmptyString(val.bank)) issues.push(err(`${p}.bank`, "is required"));
      }
    }
  }
}

function validateDesktop(d: unknown, base: string, issues: Issue[]): void {
  if (d === undefined) return;
  if (!isRecord(d)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  if (typeof d.enabled !== "boolean") issues.push(err(`${base}.enabled`, "must be true or false"));
  if (d.environment !== undefined && d.environment !== "xfce") {
    issues.push(err(`${base}.environment`, "only 'xfce' is supported"));
  }
  if (d.transport !== undefined && d.transport !== "xrdp") {
    issues.push(err(`${base}.transport`, "only 'xrdp' is supported"));
  }
  if (d.tailscale_only !== undefined && typeof d.tailscale_only !== "boolean") {
    issues.push(err(`${base}.tailscale_only`, "must be true or false"));
  }
  const idle = d.idle_logout_minutes;
  if (idle !== undefined && !(typeof idle === "number" && Number.isInteger(idle) && idle > 0)) {
    issues.push(err(`${base}.idle_logout_minutes`, "must be a positive integer"));
  }
}

function validateProjects(projects: unknown, base: string, issues: Issue[]): void {
  if (projects === undefined) return;
  if (!Array.isArray(projects)) {
    issues.push(err(base, "must be a list"));
    return;
  }
  projects.forEach((p, j) => {
    const path = `${base}[${j}]`;
    if (!isRecord(p)) {
      issues.push(err(path, "must be a mapping"));
      return;
    }
    if (typeof p.name !== "string" || !PROJECT_NAME_RE.test(p.name)) {
      issues.push(err(`${path}.name`, `'${String(p.name)}' must match ${PROJECT_NAME_RE.source}`));
    }
    if (!isNonEmptyString(p.repo)) issues.push(err(`${path}.repo`, "is required"));
    if (p.branch !== undefined && !isNonEmptyString(p.branch)) {
      issues.push(err(`${path}.branch`, "must be a branch name"));
    }
    for (const k of ["git_identity", "agent_profile", "memory_space"] as const) {
      if (p[k] !== undefined && !isNonEmptyString(p[k])) issues.push(err(`${path}.${k}`, "must be a key name"));
    }
    if (p.container_engine !== undefined && !ENGINES.includes(String(p.container_engine))) {
      issues.push(err(`${path}.container_engine`, `must be one of: ${ENGINES.join(", ")}`));
    }
    for (const k of ["install", "update"] as const) {
      if (p[k] !== undefined && typeof p[k] !== "boolean") issues.push(err(`${path}.${k}`, "must be true or false"));
    }
    const ports = p.ports;
    if (ports !== undefined) {
      if (!Array.isArray(ports)) {
        issues.push(err(`${path}.ports`, "must be a list of port numbers"));
      } else if (!ports.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535)) {
        issues.push(err(`${path}.ports`, "every port must be an integer in 1..65535"));
      }
    }
  });
}
