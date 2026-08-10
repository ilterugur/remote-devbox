import {
  agentHealthIdentity,
  collectDoctorHealth,
  configuredAgentSpecs,
  type HealthDocument,
  type HealthResult,
  type RecoveryPolicy,
} from "./health";
import { recoverOwnedAgentLive } from "./agent";
import { recoverMountLive } from "./mount";
import { recoverSyncLive } from "./sync";
import type { Config } from "./config";

export interface RecoveryRegistration {
  component: string;
  policy: RecoveryPolicy;
  ownership: "client-agent" | "client-mount" | "client-sync" | "box-systemd" | "none";
  recoverableReasons: string[];
  maxAttempts: 3;
}

export type RecoveryDecision =
  | { action: "run"; registration: RecoveryRegistration }
  | { action: "skip" | "refuse"; reason: string };

type RegisteredPattern = RecoveryRegistration & { matches: RegExp };

const registration = (
  component: string,
  matches: RegExp,
  policy: RecoveryPolicy,
  ownership: RecoveryRegistration["ownership"],
  recoverableReasons: string[],
): RegisteredPattern => ({
  component,
  matches,
  policy,
  ownership,
  recoverableReasons,
  maxAttempts: 3,
});

const UNIT_FAILURES = ["unit_failed", "unit_inactive", "listener_missing", "listener_owner_mismatch"];
const AGENT_FAILURES = ["agent_not_loaded", "agent_not_running", "agent_not_ready", "listener_owner_mismatch"];

const REGISTRY: RegisteredPattern[] = [
  registration("desktop.xrdp", /^desktop\.xrdp$/, "automatic", "box-systemd", [
    ...UNIT_FAILURES, "tailnet_not_ready",
  ]),
  registration(
    "desktop.xrdp-sesman",
    /^desktop\.xrdp-sesman$/,
    "confirmation-required",
    "box-systemd",
    UNIT_FAILURES,
  ),
  registration("browser.proxy", /^browser\.proxy$/, "automatic", "box-systemd", UNIT_FAILURES),
  registration("browser.fallback", /^browser\.fallback$/, "automatic", "box-systemd", UNIT_FAILURES),
  registration("browser.mcp.*", /^browser\.mcp\.[a-z_][a-z0-9_-]{0,31}$/, "automatic", "box-systemd", UNIT_FAILURES),
  registration("memory.*", /^memory\.[a-z_][a-z0-9_-]{0,31}\.[a-z0-9][a-z0-9_-]*$/, "manual", "box-systemd", [
    ...UNIT_FAILURES, "process_missing",
  ]),
  registration("remote-control.*", /^remote-control\.agent-rc-[a-z0-9_.@-]+\.service$/, "automatic", "box-systemd", [
    ...UNIT_FAILURES, "process_missing",
  ]),
  registration("client.rdp-tunnel.*", /^client\.rdp-tunnel\.[a-z_][a-z0-9_-]{0,31}$/, "automatic", "client-agent", AGENT_FAILURES),
  registration("client.browser.*", /^client\.browser\.[a-z_][a-z0-9_-]{0,31}$/, "automatic", "client-agent", AGENT_FAILURES),
  registration(
    "client.agent.*.browser-port-*",
    /^client\.agent\.com\.devbox\.[a-z_][a-z0-9_-]{0,31}\.browser-port-[1-9][0-9]*$/,
    "automatic",
    "client-agent",
    AGENT_FAILURES,
  ),
  registration(
    "client.agent.*.browser-autobind-port-*",
    /^client\.agent\.com\.devbox\.[a-z_][a-z0-9_-]{0,31}\.browser-autobind-port-[1-9][0-9]*$/,
    "automatic",
    "client-agent",
    AGENT_FAILURES,
  ),
  registration(
    "client.agent.*.mount",
    /^client\.agent\.com\.devbox\.[a-z_][a-z0-9_-]{0,31}\.mount$/,
    "automatic",
    "client-agent",
    AGENT_FAILURES,
  ),
  registration("client.mount.*", /^client\.mount\.[a-z0-9._-]+$/, "automatic", "client-mount", [
    "mount_absent", "mount_disconnected_clean",
  ]),
  registration("client.sync.*", /^client\.sync\.[a-z_][a-z0-9_-]{0,31}$/, "automatic", "client-sync", [
    "sync_disconnected", "sync_paused",
  ]),
  registration("box.transport", /^box\.transport$/, "none", "none", []),
  registration("box.snapshot", /^box\.snapshot$/, "none", "none", []),
  registration("profile.*.isolation", /^profile\.[a-z_][a-z0-9_-]{0,31}\.isolation$/, "none", "none", []),
  registration("profile.*.resources", /^profile\.[a-z_][a-z0-9_-]{0,31}\.resources$/, "none", "none", []),
];

export function recoveryRegistrationFor(component: string): RecoveryRegistration | null {
  const found = REGISTRY.find((candidate) => candidate.matches.test(component));
  if (!found) return null;
  const { matches: _matches, ...publicRegistration } = found;
  return publicRegistration;
}

export function validateRecoveryCoverage(componentIds: string[]): string[] {
  return [...new Set(componentIds.filter((id) => recoveryRegistrationFor(id) === null))].sort();
}

export function decideRecovery(
  result: HealthResult,
  registered: RecoveryRegistration,
  _scope: "single" | "all",
): RecoveryDecision {
  if (result.status === "healthy") return { action: "skip", reason: "already_healthy" };
  if (result.status === "recovering") return { action: "skip", reason: "recovery_in_progress" };
  if (result.status === "unknown") return { action: "refuse", reason: "evidence_unknown" };
  if (result.status === "blocked") return { action: "refuse", reason: "component_blocked" };
  if (result.recovery !== registered.policy) return { action: "refuse", reason: "policy_mismatch" };
  if (registered.policy === "none") return { action: "refuse", reason: "recovery_not_supported" };
  if (registered.policy === "confirmation-required") return { action: "refuse", reason: "confirmation_required" };
  if (!result.reason || !registered.recoverableReasons.includes(result.reason)) {
    return { action: "refuse", reason: "reason_not_allowlisted" };
  }
  return { action: "run", registration: registered };
}

export interface RecoveryActionResult {
  status: "acted" | "blocked" | "failed";
  reason: string;
}

export interface RecoverySelectionDependencies {
  collect: () => Promise<HealthDocument>;
  act: (component: HealthResult, registration: RecoveryRegistration) => Promise<RecoveryActionResult>;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface RecoverySelectionResult {
  exitCode: 0 | 1;
  lines: string[];
}

export async function runRecoverySelection(
  target: string,
  dependencies: RecoverySelectionDependencies,
): Promise<RecoverySelectionResult> {
  const before = await dependencies.collect();
  const selected = target === "all"
    ? before.components
    : before.components.filter((component) => component.id === target);
  if (!selected.length) {
    return { exitCode: 1, lines: [`${target} refused: component_not_found`] };
  }

  const lines: string[] = [];
  let failed = false;
  for (const component of selected) {
    const registered = recoveryRegistrationFor(component.id);
    if (!registered) {
      failed = true;
      lines.push(`${component.id} refused: component_not_registered`);
      continue;
    }
    const decision = decideRecovery(component, registered, target === "all" ? "all" : "single");
    if (decision.action === "skip") {
      lines.push(`${component.id} skipped: ${decision.reason}`);
      continue;
    }
    if (decision.action === "refuse") {
      failed = true;
      lines.push(`${component.id} refused: ${decision.reason}`);
      continue;
    }
    if (registered.ownership === "box-systemd") {
      failed = true;
      lines.push(
        `${component.id} operator-required: sudo /usr/local/libexec/remote-devbox-doctor recover ${component.id}`,
      );
      continue;
    }
    if (registered.ownership === "none") {
      failed = true;
      lines.push(`${component.id} refused: recovery_not_supported`);
      continue;
    }

    const action = await dependencies.act(component, registered);
    if (action.status !== "acted") {
      failed = true;
      lines.push(`${component.id} ${action.status}: ${action.reason}`);
      continue;
    }
    let post: HealthResult | undefined;
    for (let attempt = 0; attempt < registered.maxAttempts; attempt++) {
      if (attempt > 0) {
        await (dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(1_000);
      }
      const after = await dependencies.collect();
      post = after.components.find((candidate) => candidate.id === component.id);
      if (post?.status === "healthy") break;
    }
    if (post?.status !== "healthy") {
      failed = true;
      lines.push(`${component.id} failed: post_probe_failed`);
      continue;
    }
    lines.push(`${component.id} recovered: healthy after ${action.reason}`);
  }
  return { exitCode: failed ? 1 : 0, lines };
}

export async function runRecover(
  cfg: Config,
  profile: string,
  target = "all",
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<number> {
  const collect = () => collectDoctorHealth(cfg, profile);
  const outcome = await runRecoverySelection(target, {
    collect,
    act: async (component, registered) => {
      if (registered.ownership === "client-agent") {
        if (process.platform !== "darwin") return { status: "blocked", reason: "launchd_required" };
        const spec = configuredAgentSpecs(cfg, profile)
          .find((candidate) => agentHealthIdentity(candidate, profile).id === component.id);
        if (!spec) return { status: "blocked", reason: "agent_spec_missing" };
        const result = recoverOwnedAgentLive(spec, component);
        return {
          status: result.status === "recovered" ? "acted" : result.status === "failed" ? "failed" : "blocked",
          reason: result.reason,
        };
      }
      if (registered.ownership === "client-mount") {
        const prefix = `client.mount.${profile}.`;
        if (!component.id.startsWith(prefix)) return { status: "blocked", reason: "mount_profile_mismatch" };
        return recoverMountLive(cfg, profile, component.id.slice(prefix.length), component.reason ?? "");
      }
      if (registered.ownership === "client-sync") {
        if (component.id !== `client.sync.${profile}`) return { status: "blocked", reason: "sync_profile_mismatch" };
        return recoverSyncLive(cfg, profile, component.reason ?? "");
      }
      return { status: "blocked", reason: "recovery_not_supported" };
    },
  });
  write(`${outcome.lines.join("\n")}\n`);
  return outcome.exitCode;
}
