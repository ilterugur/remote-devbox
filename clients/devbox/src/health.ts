import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  agentsFor,
  browserAutoBindAgent,
  browserAutoBindPorts,
  browserPortAgent,
  installedAnyBrowserPortAgentLabels,
  localForwardPort,
  readBrowserMode,
  type AgentSpec,
} from "./agent";
import { hostFor, type Config } from "./config";
import { collectMountHealth } from "./mount";
import { collectSyncHealth } from "./sync";

export type HealthStatus =
  | "healthy"
  | "degraded"
  | "recovering"
  | "blocked"
  | "failed"
  | "unknown";

export type RecoveryPolicy = "automatic" | "manual" | "confirmation-required" | "none";

export interface HealthResult {
  id: string;
  profile?: string;
  status: HealthStatus;
  expected: string[];
  observed: string[];
  reason?: string;
  recovery: RecoveryPolicy;
}

export interface LocalHealthResult extends HealthResult {
  remoteComponent?: string;
}

export interface HealthDocument {
  schemaVersion: 1;
  status: HealthStatus;
  observedAt: string;
  components: HealthResult[];
}

export type DoctorRunner = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

export type LocalProbeRunner = DoctorRunner;

const STATUSES = new Set<HealthStatus>([
  "healthy", "degraded", "recovering", "blocked", "failed", "unknown",
]);
const RECOVERY = new Set<RecoveryPolicy>([
  "automatic", "manual", "confirmation-required", "none",
]);
const STATUS_PRIORITY: Record<HealthStatus, number> = {
  healthy: 0,
  recovering: 1,
  degraded: 2,
  unknown: 3,
  blocked: 4,
  failed: 5,
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string list`);
  }
  return [...value] as string[];
}

function parseComponent(value: unknown, index: number): HealthResult {
  const raw = object(value, `health component ${index}`);
  if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(raw.id)) {
    throw new Error(`invalid health component id at index ${index}`);
  }
  if (raw.profile !== undefined && (
    typeof raw.profile !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(raw.profile)
  )) throw new Error(`invalid profile for '${raw.id}'`);
  if (!STATUSES.has(raw.status as HealthStatus)) throw new Error(`invalid status for '${raw.id}'`);
  if (!RECOVERY.has(raw.recovery as RecoveryPolicy)) throw new Error(`invalid recovery for '${raw.id}'`);
  if (raw.reason !== undefined && (
    typeof raw.reason !== "string" || !/^[a-z0-9_]+$/.test(raw.reason)
  )) throw new Error(`invalid reason for '${raw.id}'`);
  return {
    id: raw.id,
    ...(raw.profile === undefined ? {} : { profile: raw.profile as string }),
    status: raw.status as HealthStatus,
    expected: strings(raw.expected, `expected for '${raw.id}'`),
    observed: strings(raw.observed, `observed for '${raw.id}'`),
    ...(raw.reason === undefined ? {} : { reason: raw.reason as string }),
    recovery: raw.recovery as RecoveryPolicy,
  };
}

export function aggregateStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (worst, status) => STATUS_PRIORITY[status] > STATUS_PRIORITY[worst] ? status : worst,
    "healthy",
  );
}

function createHealthDocument(observedAt: string, components: HealthResult[]): HealthDocument {
  const sorted = [...components].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    status: aggregateStatus(sorted.map((component) => component.status)),
    observedAt,
    components: sorted,
  };
}

export function parseHealthDocument(value: unknown): HealthDocument {
  const raw = object(value, "health document");
  if (raw.schemaVersion !== 1) throw new Error("unsupported health schema");
  if (typeof raw.observedAt !== "string" || !Number.isFinite(Date.parse(raw.observedAt))) {
    throw new Error("invalid observedAt");
  }
  if (!Array.isArray(raw.components)) throw new Error("health components must be a list");
  const components = raw.components.map(parseComponent);
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id)) throw new Error(`duplicate component '${component.id}'`);
    ids.add(component.id);
  }
  return createHealthDocument(raw.observedAt, components);
}

function unavailable(now: Date = new Date()): HealthDocument {
  return createHealthDocument(now.toISOString(), [{
    id: "box.transport",
    status: "unknown",
    expected: ["schema version 1 box doctor JSON over SSH"],
    observed: ["box health evidence unavailable"],
    reason: "transport_failed",
    recovery: "none",
  }]);
}

const defaultDoctorRunner: DoctorRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export function fetchBoxHealth(
  host: string,
  runner: DoctorRunner = defaultDoctorRunner,
  now: Date = new Date(),
): HealthDocument {
  let result: ReturnType<DoctorRunner>;
  try {
    result = runner("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=8",
      host,
      "devbox doctor --json",
    ]);
  } catch {
    return unavailable(now);
  }
  if (!result.stdout.trim()) return unavailable(now);
  try {
    return parseHealthDocument(JSON.parse(result.stdout));
  } catch {
    return unavailable(now);
  }
}

export interface LaunchctlState {
  state: string | null;
  pid: number | null;
}

export function parseLaunchctlState(output: string): LaunchctlState {
  const state = output.match(/^\s*state\s*=\s*([^\s]+)\s*$/m)?.[1] ?? null;
  const rawPid = output.match(/^\s*pid\s*=\s*([1-9][0-9]*)\s*$/m)?.[1];
  return { state, pid: rawPid ? Number(rawPid) : null };
}

export function agentHealthIdentity(spec: AgentSpec, profile: string): Pick<LocalHealthResult, "id" | "remoteComponent"> {
  if (spec.label === `com.devbox.${profile}.desktop`) {
    return { id: `client.rdp-tunnel.${profile}`, remoteComponent: "desktop.xrdp" };
  }
  if (spec.label === `com.devbox.${profile}.browser`) {
    return { id: `client.browser.${profile}`, remoteComponent: "browser.proxy" };
  }
  return { id: `client.agent.${spec.label}` };
}

export function probeAgentHealth(
  spec: AgentSpec,
  profile: string,
  runner: LocalProbeRunner = defaultDoctorRunner,
  readReadyFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): LocalHealthResult {
  const identity = agentHealthIdentity(spec, profile);
  const domain = `gui/${process.getuid?.() ?? 0}/${spec.label}`;
  let launchd: ReturnType<LocalProbeRunner>;
  try {
    launchd = runner("launchctl", ["print", domain]);
  } catch {
    return {
      ...identity,
      status: "unknown",
      expected: [`${spec.label} loaded and running`],
      observed: ["launchd evidence unavailable"],
      reason: "launchctl_unavailable",
      recovery: "none",
    };
  }
  if (launchd.status !== 0) {
    return {
      ...identity,
      status: "failed",
      expected: [`${spec.label} loaded and running`],
      observed: ["agent is not loaded"],
      reason: "agent_not_loaded",
      recovery: "automatic",
    };
  }

  const runtime = parseLaunchctlState(launchd.stdout);
  if (spec.mode === "interval") {
    return {
      ...identity,
      status: "healthy",
      expected: [`${spec.label} loaded for periodic reconciliation`],
      observed: [runtime.state ? `launchd state ${runtime.state}` : "agent loaded"],
      recovery: "automatic",
    };
  }
  if (runtime.state !== "running" || runtime.pid === null) {
    return {
      ...identity,
      status: "recovering",
      expected: [`${spec.label} running with a launchd-owned PID`],
      observed: [runtime.state ? `launchd state ${runtime.state}` : "running state unavailable"],
      reason: "agent_not_running",
      recovery: "automatic",
    };
  }

  const port = localForwardPort(spec);
  if (port) {
    let listenerPid = runtime.pid;
    if (spec.readyFile) {
      let marker: string;
      try {
        marker = readReadyFile(spec.readyFile).trim();
      } catch {
        marker = "";
      }
      if (!/^[1-9][0-9]*$/.test(marker)) {
        return {
          ...identity,
          status: "recovering",
          expected: [`supervisor publishes its SSH child PID for 127.0.0.1:${port}`],
          observed: ["SSH child readiness marker unavailable"],
          reason: "agent_not_ready",
          recovery: "automatic",
        };
      }
      listenerPid = Number(marker);
    }
    let ownership: ReturnType<LocalProbeRunner>;
    try {
      ownership = runner("/usr/sbin/lsof", [
        "-nP", "-a", "-p", String(listenerPid), `-iTCP:${port}`, "-sTCP:LISTEN",
      ]);
    } catch {
      return {
        ...identity,
        status: "unknown",
        expected: [`launchd SSH PID owns 127.0.0.1:${port}`],
        observed: ["listener ownership evidence unavailable"],
        reason: "listener_probe_unavailable",
        recovery: "none",
      };
    }
    if (ownership.status !== 0) {
      return {
        ...identity,
        status: "failed",
        expected: [`launchd SSH PID owns 127.0.0.1:${port}`],
        observed: [`managed SSH PID ${listenerPid} does not own 127.0.0.1:${port}`],
        reason: "listener_owner_mismatch",
        recovery: "automatic",
      };
    }
    return {
      ...identity,
      status: "healthy",
      expected: [`launchd SSH PID owns 127.0.0.1:${port}`],
      observed: [`ssh pid ${listenerPid} owns 127.0.0.1:${port}`],
      recovery: "automatic",
    };
  }

  return {
    ...identity,
    status: "healthy",
    expected: [`${spec.label} running under launchd`],
    observed: [`launchd state running, pid ${runtime.pid}`],
    recovery: "automatic",
  };
}

export function configuredAgentSpecs(cfg: Config, profile: string): AgentSpec[] {
  const host = hostFor(cfg, profile);
  const mode = readBrowserMode(profile);
  const browserEnabled = cfg.profiles.find((candidate) => candidate.user === profile)?.browserFailover !== undefined;
  const specs = agentsFor(cfg, profile)
    .filter((spec) => spec.label !== `com.devbox.${profile}.browser` || mode === "client");
  if (mode === "client" && browserEnabled) {
    for (const port of browserAutoBindPorts(cfg, profile)) {
      specs.push(browserAutoBindAgent(profile, port, host));
    }
  }
  for (const label of installedAnyBrowserPortAgentLabels(profile)) {
    if (specs.some((spec) => spec.label === label)) continue;
    const port = Number(label.match(/-port-([1-9][0-9]*)$/)?.[1]);
    if (!Number.isSafeInteger(port) || port > 65_535) continue;
    specs.push(label.includes(".browser-autobind-port-")
      ? browserAutoBindAgent(profile, port, host)
      : browserPortAgent(profile, port, host));
  }
  return specs.sort((a, b) => a.label.localeCompare(b.label));
}

export function collectLocalAgentHealth(
  cfg: Config,
  profile: string,
  runner: LocalProbeRunner = defaultDoctorRunner,
): LocalHealthResult[] {
  return configuredAgentSpecs(cfg, profile).map((spec) => probeAgentHealth(spec, profile, runner));
}

export interface DoctorOptions {
  json?: boolean;
  now?: Date;
  runner?: DoctorRunner;
  write?: (value: string) => void;
}

export function formatHealthHuman(document: HealthDocument): string {
  const lines = [`health ${document.status}  observed ${document.observedAt}`];
  if (!document.components.length) lines.push("  (no configured components)");
  for (const component of document.components) {
    lines.push("", `${component.id}  ${component.status}`);
    lines.push(`  expected: ${component.expected.join("; ") || "-"}`);
    lines.push(`  observed: ${component.observed.join("; ") || "-"}`);
    if (component.reason) lines.push(`  reason: ${component.reason}`);
    lines.push(`  recovery: ${component.recovery}`);
  }
  return lines.join("\n");
}

export async function collectDoctorHealth(
  cfg: Config,
  profile: string,
  options: Pick<DoctorOptions, "now" | "runner"> = {},
): Promise<HealthDocument> {
  const now = options.now ?? new Date();
  const runner = options.runner ?? defaultDoctorRunner;
  const remote = fetchBoxHealth(hostFor(cfg, profile), runner, now);
  const sync = await collectSyncHealth(cfg, profile);
  const local = [
    ...collectLocalAgentHealth(cfg, profile, runner),
    ...collectMountHealth(cfg, profile, runner),
    ...(sync ? [sync] : []),
  ];
  return combineHealth(remote, local, now);
}

export async function runDoctor(cfg: Config, profile: string, options: DoctorOptions = {}): Promise<number> {
  const document = await collectDoctorHealth(cfg, profile, options);
  const rendered = options.json ? JSON.stringify(document, null, 2) : formatHealthHuman(document);
  (options.write ?? ((value) => process.stdout.write(value)))(`${rendered}\n`);
  return document.status === "healthy" ? 0 : 1;
}

function downstreamResult(local: LocalHealthResult, remote: HealthResult | undefined): HealthResult {
  const { remoteComponent: _remoteComponent, ...base } = local;
  if (local.status !== "healthy") return base;
  if (!remote || remote.status === "unknown") {
    return {
      ...base,
      status: "unknown",
      observed: [...base.observed, "downstream health evidence unavailable"],
      reason: "downstream_unknown",
    };
  }
  if (remote.status === "failed" || remote.status === "blocked") {
    return {
      ...base,
      status: remote.status,
      observed: [...base.observed, `${remote.id} ${remote.status}`],
      reason: remote.status === "failed" ? "downstream_unit_failed" : "downstream_blocked",
    };
  }
  if (remote.status !== "healthy") {
    return {
      ...base,
      status: remote.status,
      observed: [...base.observed, `${remote.id} ${remote.status}`],
      reason: "downstream_unhealthy",
    };
  }
  return base;
}

export function combineHealth(
  box: HealthDocument,
  local: LocalHealthResult[],
  now: Date = new Date(),
): HealthDocument {
  const remote = new Map(box.components.map((component) => [component.id, component]));
  const combined = local.map((component) => component.remoteComponent
    ? downstreamResult(component, remote.get(component.remoteComponent))
    : (({ remoteComponent: _remoteComponent, ...result }) => result)(component));
  return createHealthDocument(now.toISOString(), [...box.components, ...combined]);
}
