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
  CLI_TARGETS,
  CONFIG_VERSION,
  type CliTarget,
  type DevboxSpec,
  type EngineId,
  type RcSpawn,
  SERVICE_RESOURCE_KEYS,
  SLICE_RESOURCE_KEYS,
  SUPPORTED_PLATFORM,
  type SshAccess,
} from "./types";
import { canonicalMemorySize, isMemoryWeight } from "./memory-limit";
import { resolveEntry } from "../app-configs/registry";
import { normalizePath, pathsOverlap } from "../bridge";

export const USERNAME_RE = /^[a-z_][a-z0-9_-]*$/;
const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** XKB layout/variant/model names: lowercase, no spaces — `tr`, `f`, `intl`, `pc105`. */
const XKB_NAME_RE = /^[a-z0-9_+-]+$/;
const ENGINES: readonly string[] = ["podman-rootless", "docker-rootless", "none"] satisfies EngineId[];
const SSH_ACCESS: readonly string[] = ["public", "tailnet"] satisfies SshAccess[];
const PROVIDERS: readonly string[] = ["claude", "codex"];
const DESKTOP_ACCESS: readonly string[] = ["tunnel", "tailnet", "unsafe-public"];
const RC_SPAWNS: readonly string[] = ["worktree", "same-dir", "session"] satisfies RcSpawn[];
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
/**
 * An agent profile becomes a launcher script on the developer's PATH. Naming a profile
 * after the agent's own binary makes the launcher overwrite that binary and then exec
 * itself — so the collision is rejected here rather than discovered as a fork bomb.
 */
const RESERVED_PROFILE_NAMES: readonly string[] = ["claude", "codex", "mise", "git", "node", "bun"];

/**
 * Accepts the classic types plus FIDO2/security-key types (sk-*) and certificates.
 * Rejecting sk-* would have blocked the one upgrade worth making here: a hardware key's
 * private half cannot be copied off the token.
 */
export const isSshPublicKey = (s: unknown): boolean =>
  typeof s === "string" &&
  /^(sk-)?(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d+)(-cert-v01)?(@openssh\.com)?\s+[A-Za-z0-9+/=]+/.test(s.trim());

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
  validateClients(raw, issues);
  validateRemoteControl(raw, issues);
  validateBrowser(raw, issues);
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
  const reserve = h.memory_reserve;
  const canonicalReserve = typeof reserve === "string" ? canonicalMemorySize(reserve) : null;
  if (
    reserve !== undefined &&
    !(canonicalReserve && !canonicalReserve.endsWith("%"))
  ) {
    issues.push(err("host.memory_reserve", "must be an absolute systemd size like '4G'"));
  }
  const oomd = h.oomd;
  if (oomd !== undefined) {
    if (!isRecord(oomd)) {
      issues.push(err("host.oomd", "must be a mapping"));
    } else {
      if (oomd.enabled !== undefined && typeof oomd.enabled !== "boolean") {
        issues.push(err("host.oomd.enabled", "must be true or false"));
      }
      const limit = oomd.memory_pressure_limit;
      const pct =
        typeof limit === "string" && /^\d{1,3}%$/.test(limit) ? Number.parseInt(limit, 10) : NaN;
      if (limit !== undefined && !(pct >= 1 && pct <= 99)) {
        issues.push(err("host.oomd.memory_pressure_limit", "must be a percentage in 1%..99%"));
      }
      const d = oomd.memory_pressure_duration_sec;
      if (d !== undefined && !(typeof d === "number" && Number.isInteger(d) && d > 0)) {
        issues.push(err("host.oomd.memory_pressure_duration_sec", "must be a positive integer"));
      }
    }
  }
  for (const k of ["mosh", "eternal_terminal", "harden_ssh", "hide_pids", "github_cli"] as const) {
    if (h[k] !== undefined && typeof h[k] !== "boolean") issues.push(err(`host.${k}`, "must be true or false"));
  }
  if (h.umask !== undefined && !(typeof h.umask === "string" && /^[0-7]{3,4}$/.test(h.umask))) {
    issues.push(err("host.umask", "must be an octal umask like '077'"));
  }
  const swap = h.swappiness;
  if (swap !== undefined && !(typeof swap === "number" && Number.isInteger(swap) && swap >= 0 && swap <= 200)) {
    issues.push(err("host.swappiness", "must be an integer in 0..200"));
  }
  if (h.locales !== undefined && !(Array.isArray(h.locales) && h.locales.every(isNonEmptyString))) {
    issues.push(err("host.locales", "must be a list of locale names"));
  }
  validateHeavyJobGate(h.heavy_job_gate, "host.heavy_job_gate", issues);
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
  if (ssh?.exposure !== undefined) {
    issues.push(
      err(
        "network.ssh.exposure",
        "replaced by 'access' — public_and_tailscale becomes [public, tailnet], tailscale_only becomes [tailnet], public_only becomes [public]",
      ),
    );
  }
  validateAccessList(ssh?.access, "network.ssh.access", SSH_ACCESS, issues);
  if (Array.isArray(ssh?.access) && ssh.access.length && !ssh.access.includes("public") && ts?.enabled === false) {
    issues.push(
      err("network.ssh.access", "a tailnet-only sshd needs network.tailscale.enabled: true"),
    );
  }
}

/**
 * Shared shape check for the access lists: non-empty, known values, no repeats. The
 * per-value consequences (does this path exist? is it dangerous?) belong to the caller.
 */
function validateAccessList(
  access: unknown,
  path: string,
  allowed: readonly string[],
  issues: Issue[],
): void {
  if (access === undefined) return;
  if (!Array.isArray(access) || access.length === 0) {
    issues.push(err(path, `must be a non-empty list of: ${allowed.join(", ")}`));
    return;
  }
  const unknown = access.filter((a) => !allowed.includes(String(a)));
  if (unknown.length) {
    issues.push(err(path, `unknown value(s) ${unknown.join(", ")} (have: ${allowed.join(", ")})`));
    return;
  }
  if (new Set(access.map(String)).size !== access.length) {
    issues.push(err(path, "lists the same access path twice"));
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

function validateClients(raw: Record<string, unknown>, issues: Issue[]): void {
  const c = raw.clients;
  if (c === undefined) return;
  if (!isRecord(c)) {
    issues.push(err("clients", "must be a mapping"));
    return;
  }
  const t = c.cli_targets;
  if (t === undefined) return;
  // An empty list is legitimate and means "publish no binaries" — the box then tells a
  // developer to build their own rather than pretending one is waiting for them.
  if (!Array.isArray(t) || t.some((x) => !CLI_TARGETS.includes(x as CliTarget))) {
    issues.push(err("clients.cli_targets", `must be a list of: ${CLI_TARGETS.join(", ")}`));
  }
}

function validateDevelopers(raw: Record<string, unknown>, issues: Issue[]): void {
  const devs = raw.developers;
  if (!Array.isArray(devs) || devs.length === 0) {
    issues.push(err("developers", "at least one developer is required"));
    return;
  }
  devs.forEach((d, i) => validateDeveloper(d, `developers[${i}]`, issues));

  const modes = new Set<"direct" | "weight">();
  devs.filter(isRecord).forEach((developer) => {
    const resources = developer.resources;
    if (!isRecord(resources) || resources.memory_high === undefined) return;
    if (isMemoryWeight(resources.memory_high)) modes.add("weight");
    else if (typeof resources.memory_high === "string" && canonicalMemorySize(resources.memory_high) !== null) {
      modes.add("direct");
    }
  });
  if (modes.size > 1) {
    issues.push(err("developers.resources.memory_high", "direct sizes and weights cannot be mixed"));
  }

  // Two developers driven from one client would open two tunnels; the same local port
  // twice means the second silently fails to bind. Named both ways so the fix is obvious.
  const claimed = new Map<string, string>();
  for (const d of devs) {
    if (!isRecord(d) || !isRecord(d.desktop) || d.desktop.enabled !== true) continue;
    const port = d.desktop.client_port;
    if (typeof port !== "number") continue;
    const key = String(port);
    const first = claimed.get(key);
    if (first) {
      issues.push(
        err(`developers.${String(d.user)}.desktop.client_port`, `port ${key} is already claimed by developer '${first}'`),
      );
    } else {
      claimed.set(key, String(d.user));
    }
  }
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

  validateResources(d.resources, `${base}.resources`, issues, { allowMemoryHighWeight: true });
  validateResources(d.codex_host_resources, `${base}.codex_host_resources`, issues, { allowServiceKnobs: true });
  validateHeavyJobGate(d.heavy_job_gate, `${base}.heavy_job_gate`, issues);
  if (d.browser !== undefined && typeof d.browser !== "boolean") {
    issues.push(err(`${base}.browser`, "must be true or false"));
  }
  if (d.codex_remote_control !== undefined && typeof d.codex_remote_control !== "boolean") {
    issues.push(err(`${base}.codex_remote_control`, "must be true or false"));
  }
  validateAgentConfig(d.agent_config, `${base}.agent_config`, issues);
  validateGitIdentities(d, base, issues);
  validateAgentProfiles(d, base, issues);
  validateMemory(d.memory, `${base}.memory`, issues);
  validateDesktop(d.desktop, `${base}.desktop`, issues);
  validateFileBridge(d.file_bridge, `${base}.file_bridge`, issues);
  validateAppConfigs(d, base, issues);
  validateProjects(d.projects, `${base}.projects`, issues);
}

function validateHeavyJobGate(value: unknown, path: string, issues: Issue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(err(path, "must be a mapping"));
    return;
  }
  const allowedFields = new Set(["enabled", "categories", "wait_timeout_sec", "warn_after_sec", "memory_max"]);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) issues.push(err(`${path}.${key}`, "unknown heavy-job gate field"));
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    issues.push(err(`${path}.enabled`, "must be true or false"));
  }
  const categories = value.categories;
  if (categories !== undefined) {
    if (!isRecord(categories)) {
      issues.push(err(`${path}.categories`, "must be a mapping"));
    } else {
      const allowed = new Set(["build", "typecheck", "generate", "test"]);
      for (const [category, enabled] of Object.entries(categories)) {
        if (!allowed.has(category)) issues.push(err(`${path}.categories.${category}`, "is not a known heavy-job category"));
        else if (typeof enabled !== "boolean") issues.push(err(`${path}.categories.${category}`, "must be true or false"));
      }
    }
  }
  for (const key of ["wait_timeout_sec", "warn_after_sec"] as const) {
    const setting = value[key];
    if (setting !== undefined && !(typeof setting === "number" && Number.isInteger(setting) && setting >= 0)) {
      issues.push(err(`${path}.${key}`, "must be a non-negative integer"));
    }
  }
  const memoryMax = value.memory_max;
  if (memoryMax !== undefined && !(typeof memoryMax === "string" && canonicalMemorySize(memoryMax) !== null)) {
    issues.push(err(`${path}.memory_max`, "must be a systemd size like '8G' (or '' for no per-job ceiling)"));
  }
}

function validateAppConfigs(d: Record<string, unknown>, base: string, issues: Issue[]): void {
  const ac = d.app_configs;
  if (ac === undefined) return;
  const path = `${base}.app_configs`;
  if (!isRecord(ac)) {
    issues.push(err(path, "must be a mapping"));
    return;
  }
  if (ac.enabled !== undefined && typeof ac.enabled !== "boolean") {
    issues.push(err(`${path}.enabled`, "must be true or false"));
  }
  // The feature stores its real files inside the sync disk — without it there is
  // nowhere to link to, and a dangling symlink makes apps write fresh empty configs.
  const bridge = isRecord(d.file_bridge) ? d.file_bridge : {};
  if (ac.enabled === true && bridge.sync_disk !== true) {
    issues.push(err(`${path}.enabled`, "needs file_bridge.sync_disk: true — app configs live inside the sync disk"));
  }
  if (ac.paths === undefined) return;
  if (!Array.isArray(ac.paths)) {
    issues.push(err(`${path}.paths`, "must be a list of registry keys or entry mappings"));
    return;
  }
  const disk = normalizePath(`~/devbox/${String(d.user)}`);
  // The box path is absolute and belongs to the box, so it is compared as written.
  const boxDisk = `/home/${String(d.user)}/sync`;
  const seen = new Set<string>();
  ac.paths.forEach((raw, i) => {
    const at = `${path}.paths[${i}]`;
    if (typeof raw !== "string" && !isRecord(raw)) {
      issues.push(err(at, "must be a registry key or an entry mapping"));
      return;
    }
    const r = resolveEntry(raw as string | Record<string, unknown>);
    if ("error" in r) {
      issues.push(err(at, r.error));
      return;
    }
    if (seen.has(r.entry.label)) issues.push(err(at, `duplicate app config "${r.entry.label}"`));
    seen.add(r.entry.label);
    // The store lives inside the disk, so the app-visible path has to stay outside it on
    // BOTH sides — a link pointing into its own store points at itself. The two sides
    // have different disks: ~/devbox/<user> on the client, /home/<user>/sync on the box.
    if (pathsOverlap(r.entry.client, disk)) {
      issues.push(err(`${at}.client`, `overlaps the sync disk ${disk}`));
    }
    if (pathsOverlap(r.entry.box, boxDisk)) {
      issues.push(err(`${at}.box`, `overlaps the box sync disk ${boxDisk}`));
    }
  });
}

const SYNC_ENGINES = ["mutagen", "syncthing"];

function validateFileBridge(fb: unknown, base: string, issues: Issue[]): void {
  if (fb === undefined) return;
  if (!isRecord(fb)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  if (fb.sync_disk !== undefined && typeof fb.sync_disk !== "boolean") {
    issues.push(err(`${base}.sync_disk`, "must be true or false"));
  }
  if (fb.engine !== undefined && !SYNC_ENGINES.includes(String(fb.engine))) {
    issues.push(err(`${base}.engine`, `must be one of: ${SYNC_ENGINES.join(", ")}`));
  }
  if (fb.lazy_mount_on_connect !== undefined && typeof fb.lazy_mount_on_connect !== "boolean") {
    issues.push(err(`${base}.lazy_mount_on_connect`, "must be true or false"));
  }
  validateLazyMounts(fb.lazy_mounts, `${base}.lazy_mounts`, issues);
}

/** A mount label becomes the box directory ~/mnt/<label>, so it has to be a filename. */
const MOUNT_LABEL_RE = /^[A-Za-z0-9._-]+$/;

function validateLazyMounts(raw: unknown, base: string, issues: Issue[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    issues.push(err(base, "must be a list of { label, path }"));
    return;
  }
  const seen = new Set<string>();
  raw.forEach((m, i) => {
    const at = `${base}[${i}]`;
    if (!isRecord(m)) {
      issues.push(err(at, "must be a mapping with label and path"));
      return;
    }
    const label = String(m.label ?? "");
    if (!MOUNT_LABEL_RE.test(label)) {
      issues.push(err(`${at}.label`, `'${label}' is not usable as a directory name`));
    } else if (seen.has(label)) {
      // Two mounts sharing a label would land on one box directory, and the second would
      // silently take the first one's place.
      issues.push(err(`${at}.label`, `duplicate label '${label}'`));
    } else {
      seen.add(label);
    }
    if (!isNonEmptyString(m.path)) {
      issues.push(err(`${at}.path`, "must be a client path"));
    }
  });

  // Nesting one served path inside another means the box sees the same files under two
  // mountpoints, and unmounting either can pull the ground out from under the other.
  const paths = raw
    .filter(isRecord)
    .map((m) => (isNonEmptyString(m.path) ? normalizePath(m.path) : null));
  paths.forEach((a, i) => {
    if (!a) return;
    paths.forEach((b, j) => {
      if (j <= i || !b) return;
      if (pathsOverlap(a, b)) issues.push(err(`${base}[${j}].path`, `overlaps ${base}[${i}].path (${a})`));
    });
  });
}

interface ResourceValidationOptions {
  allowMemoryHighWeight?: boolean;
  allowServiceKnobs?: boolean;
}

function validateResources(
  r: unknown,
  base: string,
  issues: Issue[],
  options: ResourceValidationOptions = {},
): void {
  if (r === undefined) return;
  if (!isRecord(r)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  const allowedKeys: readonly string[] = options.allowServiceKnobs ? SERVICE_RESOURCE_KEYS : SLICE_RESOURCE_KEYS;
  for (const key of Object.keys(r)) {
    if (!allowedKeys.includes(key)) issues.push(err(`${base}.${key}`, "unknown resource field"));
  }
  for (const k of ["memory_high", "memory_max", "memory_swap_max"] as const) {
    const value = r[k];
    const valid =
      (typeof value === "string" && canonicalMemorySize(value) !== null) ||
      (k === "memory_high" && options.allowMemoryHighWeight && isMemoryWeight(value));
    // systemd byte suffixes or bounded percentages; "" means "no limit for this knob".
    if (value !== undefined && !valid) {
      issues.push(err(`${base}.${k}`, "must be a systemd size like '10G' (or '' for no limit)"));
    }
  }
  for (const k of ["cpu_weight", "io_weight", "tasks_max"] as const) {
    if (r[k] !== undefined && !(typeof r[k] === "number" && Number.isInteger(r[k]) && (r[k] as number) > 0)) {
      issues.push(err(`${base}.${k}`, "must be a positive integer"));
    }
  }
  // Service-only knobs. Both have kernel-defined ranges, and a value outside them is
  // rejected by systemd at unit load — which surfaces as a unit that simply never
  // starts, so catch it here instead.
  if (
    options.allowServiceKnobs &&
    r.nice !== undefined &&
    !(typeof r.nice === "number" && Number.isInteger(r.nice) && r.nice >= -20 && r.nice <= 19)
  ) {
    issues.push(err(`${base}.nice`, "must be an integer in -20..19"));
  }
  if (
    options.allowServiceKnobs &&
    r.oom_score_adjust !== undefined &&
    !(
      typeof r.oom_score_adjust === "number" &&
      Number.isInteger(r.oom_score_adjust) &&
      r.oom_score_adjust >= -1000 &&
      r.oom_score_adjust <= 1000
    )
  ) {
    issues.push(err(`${base}.oom_score_adjust`, "must be an integer in -1000..1000"));
  }
  if (
    options.allowServiceKnobs &&
    r.cpu_quota !== undefined &&
    !(typeof r.cpu_quota === "string" && /^(\d+%|)$/.test(String(r.cpu_quota)))
  ) {
    issues.push(err(`${base}.cpu_quota`, "must be a percentage like '300%' (or '' for no cap)"));
  }
  if (
    options.allowServiceKnobs &&
    r.oom_policy !== undefined &&
    !(typeof r.oom_policy === "string" && ["continue", "stop", "kill"].includes(r.oom_policy))
  ) {
    issues.push(err(`${base}.oom_policy`, "must be one of 'continue', 'stop', 'kill'"));
  }
}

function validateBuildEnv(raw: unknown, base: string, issues: Issue[]): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    issues.push(err(base, "must be a mapping of NAME -> value"));
    return;
  }
  for (const [k, v] of Object.entries(raw)) {
    // Values land in systemd Environment= lines, which are strings. Accepting a number
    // here would render fine and then differ from what the same key means elsewhere.
    if (typeof v !== "string") issues.push(err(`${base}.${k}`, "must be a string"));
  }
}

function validatePositiveInts(
  raw: Record<string, unknown>,
  base: string,
  keys: readonly string[],
  issues: Issue[],
): void {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v > 0)) {
      issues.push(err(`${base}.${k}`, "must be a positive integer"));
    }
  }
}

/** The box-wide Remote Control block. Per-project overrides are validated with the project. */
function validateRemoteControl(raw: Record<string, unknown>, issues: Issue[]): void {
  const rc = raw.remote_control;
  if (rc === undefined) return;
  if (!isRecord(rc)) {
    issues.push(err("remote_control", "must be a mapping"));
    return;
  }
  if (rc.enabled !== undefined && typeof rc.enabled !== "boolean") {
    issues.push(err("remote_control.enabled", "must be true or false"));
  }
  if (rc.spawn !== undefined && !RC_SPAWNS.includes(String(rc.spawn))) {
    issues.push(err("remote_control.spawn", `must be one of: ${RC_SPAWNS.join(", ")}`));
  }
  validatePositiveInts(rc, "remote_control", ["capacity"], issues);
  validateResources(rc.resources, "remote_control.resources", issues, { allowServiceKnobs: true });
  validateBuildEnv(rc.build_env, "remote_control.build_env", issues);

  const ar = rc.autorestart;
  if (ar !== undefined) {
    if (!isRecord(ar)) {
      issues.push(err("remote_control.autorestart", "must be a mapping"));
    } else {
      if (ar.enabled !== undefined && typeof ar.enabled !== "boolean") {
        issues.push(err("remote_control.autorestart.enabled", "must be true or false"));
      }
      validatePositiveInts(ar, "remote_control.autorestart", ["restart_sec", "burst", "interval"], issues);
    }
  }

  const re = rc.resume;
  if (re !== undefined) {
    if (!isRecord(re)) {
      issues.push(err("remote_control.resume", "must be a mapping"));
    } else {
      for (const k of ["on_boot", "skip_workflow_warning"] as const) {
        if (re[k] !== undefined && typeof re[k] !== "boolean") {
          issues.push(err(`remote_control.resume.${k}`, "must be true or false"));
        }
      }
      validatePositiveInts(
        re,
        "remote_control.resume",
        ["lookback_h", "max_concurrent", "settle_sec", "min_free_mb", "max_attempts", "timeout_sec"],
        issues,
      );
    }
  }

  const rp = rc.reap;
  if (rp !== undefined) {
    if (!isRecord(rp)) {
      issues.push(err("remote_control.reap", "must be a mapping"));
    } else {
      if (rp.enabled !== undefined && typeof rp.enabled !== "boolean") {
        issues.push(err("remote_control.reap.enabled", "must be true or false"));
      }
      validatePositiveInts(rp, "remote_control.reap", ["interval_sec", "grace_sec"], issues);
    }
  }
}

function validateProjectRemoteControl(raw: unknown, base: string, issues: Issue[]): void {
  if (raw === undefined || raw === false) return;
  if (!isRecord(raw)) {
    issues.push(err(base, "must be a mapping, or false to turn Remote Control off for this project"));
    return;
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    issues.push(err(`${base}.enabled`, "must be true or false"));
  }
  if (raw.name !== undefined && !isNonEmptyString(raw.name)) {
    issues.push(err(`${base}.name`, "must be a non-empty title"));
  }
  if (raw.spawn !== undefined && !RC_SPAWNS.includes(String(raw.spawn))) {
    issues.push(err(`${base}.spawn`, `must be one of: ${RC_SPAWNS.join(", ")}`));
  }
  validatePositiveInts(raw, base, ["capacity"], issues);
  validateResources(raw.resources, `${base}.resources`, issues, { allowServiceKnobs: true });
  validateBuildEnv(raw.build_env, `${base}.build_env`, issues);
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
  // Renamed rather than silently ignored: a leftover tailscale_only would read as
  // "restricted" while the desktop quietly fell back to the default.
  if (d.tailscale_only !== undefined) {
    issues.push(
      err(
        `${base}.tailscale_only`,
        "replaced by 'access' — use access: [tailnet] for the old true, or [tunnel] for the new default",
      ),
    );
  }
  validateDesktopAccess(d.access, `${base}.access`, issues);
  const idle = d.idle_logout_minutes;
  if (idle !== undefined && !(typeof idle === "number" && Number.isInteger(idle) && idle > 0)) {
    issues.push(err(`${base}.idle_logout_minutes`, "must be a positive integer"));
  }
  const port = d.client_port;
  if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535)) {
    issues.push(err(`${base}.client_port`, "must be an integer between 1024 and 65535"));
  }
  validateKeyboard(d.keyboard, `${base}.keyboard`, issues);
}

/**
 * The fields go to `setxkbmap` unquoted, so they are checked against XKB's own naming
 * rather than merely "is a string" — a layout with a space in it would otherwise become
 * two arguments on the box and fail there instead of here.
 */
function validateKeyboard(k: unknown, base: string, issues: Issue[]): void {
  if (k === undefined) return;
  if (!isRecord(k)) {
    issues.push(err(base, "must be a mapping"));
    return;
  }
  if (typeof k.layout !== "string" || !XKB_NAME_RE.test(k.layout)) {
    issues.push(err(`${base}.layout`, `'${String(k.layout)}' must be an XKB layout such as 'tr' or 'us'`));
  }
  if (k.variant !== undefined && (typeof k.variant !== "string" || !XKB_NAME_RE.test(k.variant))) {
    issues.push(err(`${base}.variant`, `'${String(k.variant)}' must be an XKB variant such as 'f' or 'intl'`));
  }
  if (k.model !== undefined && (typeof k.model !== "string" || !XKB_NAME_RE.test(k.model))) {
    issues.push(err(`${base}.model`, `'${String(k.model)}' must be an XKB model such as 'pc105'`));
  }
}

function validateDesktopAccess(access: unknown, base: string, issues: Issue[]): void {
  const before = issues.length;
  validateAccessList(access, base, DESKTOP_ACCESS, issues);
  if (issues.length !== before || !Array.isArray(access)) return;
  // Binding the wildcard alongside a specific address on the same port does not work,
  // so this is an error rather than a redundancy warning: xrdp would fail to start.
  const seen = new Set(access.map(String));
  if (seen.has("unsafe-public") && seen.size > 1) {
    issues.push(
      err(base, "'unsafe-public' already listens on every interface — it cannot be combined with tunnel or tailnet"),
    );
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
    validateProjectRemoteControl(p.remote_control, `${path}.remote_control`, issues);
  });
}

const isPort = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/**
 * The failover endpoint runs a real Chrome under a real account. Legacy picked the
 * first profile silently, which made "whose browser is this?" a question you answered
 * by reading the generated config.
 */
function validateBrowser(raw: Record<string, unknown>, issues: Issue[]): void {
  const b = raw.browser;
  if (b === undefined) return;
  if (!isRecord(b)) {
    issues.push(err("browser", "must be a mapping"));
    return;
  }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    issues.push(err("browser.enabled", "must be true or false"));
  }
  if (b.mcp_port !== undefined && !isPort(b.mcp_port)) {
    issues.push(err("browser.mcp_port", "must be an integer in 1..65535"));
  }
  const f = b.failover;
  if (f === undefined) return;
  if (!isRecord(f)) {
    issues.push(err("browser.failover", "must be a mapping"));
    return;
  }
  if (f.enabled !== undefined && typeof f.enabled !== "boolean") {
    issues.push(err("browser.failover.enabled", "must be true or false"));
  }
  if (f.autobind !== undefined && typeof f.autobind !== "boolean") {
    issues.push(err("browser.failover.autobind", "must be true or false"));
  }
  if (f.enabled === true && !isNonEmptyString(f.chrome_user)) {
    issues.push(err("browser.failover.chrome_user", "is required — name the developer whose account runs the fallback Chrome"));
  }
  for (const k of ["cdp_port", "fallback_chrome_port", "client_tunnel_port"] as const) {
    if (f[k] !== undefined && !isPort(f[k])) {
      issues.push(err(`browser.failover.${k}`, "must be an integer in 1..65535"));
    }
  }
}

function validateAgentConfig(raw: unknown, base: string, issues: Issue[]): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    issues.push(err(base, "must be a mapping with a source"));
    return;
  }
  if (!isNonEmptyString(raw.source)) {
    issues.push(err(`${base}.source`, "is required — the client-side directory to copy from"));
  }
  if (raw.include_settings !== undefined && typeof raw.include_settings !== "boolean") {
    issues.push(err(`${base}.include_settings`, "must be true or false"));
  }
}
