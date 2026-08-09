import { expect, test } from "bun:test";
import { aggregateStatus, createHealthDocument, formatHuman, formatJson } from "./report";
import type { HealthResult, HealthStatus } from "./types";

const components: HealthResult[] = [
  {
    id: "remote-control.agent-rc-dev-a-example.service",
    status: "failed",
    expected: ["agent-rc-dev-a-example.service active"],
    observed: ["failed/failed"],
    reason: "unit_failed",
    recovery: "automatic",
  },
  {
    id: "desktop.xrdp",
    status: "healthy",
    expected: ["xrdp.service active", "127.0.0.1:3389 owned by xrdp"],
    observed: ["active/running", "xrdp pid 481 owns 127.0.0.1:3389"],
    recovery: "confirmation-required",
  },
];

test("aggregateStatus uses the fail-closed severity order", () => {
  const statuses: HealthStatus[] = ["healthy", "recovering", "degraded", "unknown", "blocked", "failed"];
  expect(aggregateStatus(statuses)).toBe("failed");
  expect(aggregateStatus(statuses.slice(0, -1))).toBe("blocked");
  expect(aggregateStatus(statuses.slice(0, -2))).toBe("unknown");
  expect(aggregateStatus([])).toBe("healthy");
});

test("createHealthDocument sorts components and derives aggregate status", () => {
  const doc = createHealthDocument("2026-08-09T00:00:00.000Z", components);
  expect(doc.schemaVersion).toBe(1);
  expect(doc.status).toBe("failed");
  expect(doc.components.map((component) => component.id)).toEqual([
    "desktop.xrdp",
    "remote-control.agent-rc-dev-a-example.service",
  ]);
});

test("formatJson emits only the versioned health document", () => {
  const doc = createHealthDocument("2026-08-09T00:00:00.000Z", components);
  expect(JSON.parse(formatJson(doc))).toEqual(doc);
  expect(Object.keys(JSON.parse(formatJson(doc)))).toEqual([
    "schemaVersion",
    "status",
    "observedAt",
    "components",
  ]);
});

test("formatHuman renders expected, observed, reason, and recovery from the same results", () => {
  const out = formatHuman(createHealthDocument("2026-08-09T00:00:00.000Z", components));
  expect(out).toContain("remote-control.agent-rc-dev-a-example.service  failed");
  expect(out).toContain("expected: agent-rc-dev-a-example.service active");
  expect(out).toContain("observed: failed/failed");
  expect(out).toContain("reason: unit_failed");
  expect(out).toContain("recovery: automatic");
});
