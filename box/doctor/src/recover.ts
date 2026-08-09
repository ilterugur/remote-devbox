import { collectHostDocument, type CommandRunner } from "./collect";
import type { HealthComponentFact, HealthFacts } from "./facts";
import type { HealthDocument } from "./types";

export interface BoxRecoveryOptions {
  uid: number | undefined;
  facts: HealthFacts;
  run: CommandRunner;
  collectFresh?: () => Promise<HealthDocument>;
  hasActiveTurn?: (fact: HealthComponentFact) => Promise<boolean>;
}

export type BoxRecoveryResult = {
  status: "recovered" | "skipped" | "refused" | "failed";
  reason: string;
};

const validComponentId = (value: string): boolean => /^[a-z0-9][a-z0-9._-]*$/.test(value);

function systemctlArgs(fact: HealthComponentFact, action: "reset-failed" | "start"): string[] {
  const scope = fact.unitScope === "user"
    ? ["--user", `--machine=${fact.profile}@`]
    : [];
  return ["systemctl", ...scope, action, fact.unit!];
}

async function defaultActiveTurn(fact: HealthComponentFact, run: CommandRunner): Promise<boolean> {
  if (!fact.id.startsWith("remote-control.") || !fact.unit || !fact.profile) return true;
  const socket = fact.unit.slice(0, -".service".length);
  const result = await run(["runuser", "-u", fact.profile, "--", "tmux", "-L", socket, "has-session"]);
  // Unknown evidence is treated as active by the caller's safety boundary.
  return result.timedOut || result.exitCode === null || result.exitCode === 0;
}

export async function recoverBoxComponent(
  componentId: string,
  options: BoxRecoveryOptions,
): Promise<BoxRecoveryResult> {
  if (options.uid !== 0) return { status: "refused", reason: "root_required" };
  if (!validComponentId(componentId)) return { status: "refused", reason: "component_not_allowlisted" };
  const fact = options.facts.components.find((candidate) => candidate.id === componentId);
  if (!fact?.unit) return { status: "refused", reason: "component_not_allowlisted" };
  if (fact.recovery === "confirmation-required") {
    return { status: "refused", reason: "confirmation_required" };
  }
  if (fact.recovery !== "automatic" && fact.recovery !== "manual") {
    return { status: "refused", reason: "recovery_not_supported" };
  }

  const collectFresh = options.collectFresh
    ?? (() => collectHostDocument(options.facts, options.run, new Date()));
  const before = (await collectFresh()).components.find((component) => component.id === componentId);
  if (!before) return { status: "refused", reason: "evidence_missing" };
  if (before.status === "healthy") return { status: "skipped", reason: "already_healthy" };
  if (before.status !== "failed") return { status: "refused", reason: "component_not_failed" };

  if (fact.id.startsWith("remote-control.")) {
    const active = await (options.hasActiveTurn?.(fact) ?? defaultActiveTurn(fact, options.run));
    if (active) return { status: "refused", reason: "active_session" };
  }

  for (const action of ["reset-failed", "start"] as const) {
    let command;
    try {
      command = await options.run(systemctlArgs(fact, action));
    } catch {
      return { status: "failed", reason: "systemd_action_failed" };
    }
    if (command.timedOut || command.exitCode !== 0) {
      return { status: "failed", reason: "systemd_action_failed" };
    }
  }

  const after = (await collectFresh()).components.find((component) => component.id === componentId);
  return after?.status === "healthy"
    ? { status: "recovered", reason: "component_healthy" }
    : { status: "failed", reason: "post_recovery_unhealthy" };
}
