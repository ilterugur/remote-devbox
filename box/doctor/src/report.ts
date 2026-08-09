import type { Health, HealthDocument, HealthResult, HealthStatus } from "./types";

const STATUS_PRIORITY: Record<HealthStatus, number> = {
  healthy: 0,
  recovering: 1,
  degraded: 2,
  unknown: 3,
  blocked: 4,
  failed: 5,
};

export function aggregateStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (worst, status) => STATUS_PRIORITY[status] > STATUS_PRIORITY[worst] ? status : worst,
    "healthy",
  );
}

export function createHealthDocument(observedAt: string, components: HealthResult[]): HealthDocument {
  const sorted = [...components].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    status: aggregateStatus(sorted.map((component) => component.status)),
    observedAt,
    components: sorted,
  };
}

/** Temporary adapter while the collector is migrated from its raw evidence model. */
export function healthDocumentFromEvidence(health: Health): HealthDocument {
  const components: HealthResult[] = health.units.map((unit) => {
    const healthy = unit.loaded && unit.active === "active";
    return {
      id: `remote-control.${unit.unit}`,
      status: healthy ? "healthy" : unit.active === "failed" ? "failed" : "degraded",
      expected: [`${unit.unit} active`],
      observed: [`${unit.active}/${unit.sub}`],
      ...(healthy ? {} : { reason: unit.active === "failed" ? "unit_failed" : "unit_inactive" }),
      recovery: healthy ? "confirmation-required" : "automatic",
    };
  });

  for (const condition of health.conditions) {
    if (!condition.id.startsWith("worktree-")) continue;
    components.push({
      id: `worktree.${condition.id.slice("worktree-".length)}`,
      status: condition.guard === "pass" ? "degraded" : "blocked",
      expected: ["worktree referenced by a live session or explicitly retained"],
      observed: [String(condition.facts.path ?? condition.id)],
      reason: "orphan_worktree",
      recovery: "confirmation-required",
    });
  }

  return createHealthDocument(new Date(health.now * 1_000).toISOString(), components);
}

export function formatJson(document: HealthDocument): string {
  return JSON.stringify(document, null, 2);
}

export function formatHuman(document: HealthDocument): string {
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
