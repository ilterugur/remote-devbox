import type { HealthResult, RecoveryPolicy } from "./health";

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
  registration("client.mount.*", /^client\.mount\.[a-z0-9._-]+$/, "automatic", "client-mount", [
    "mount_absent", "mount_disconnected_clean",
  ]),
  registration("client.sync.*", /^client\.sync\.[a-z_][a-z0-9_-]{0,31}$/, "automatic", "client-sync", [
    "sync_disconnected", "sync_paused",
  ]),
  registration("box.transport", /^box\.transport$/, "none", "none", []),
  registration("box.snapshot", /^box\.snapshot$/, "none", "none", []),
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
