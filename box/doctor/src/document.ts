import { existsSync, readFileSync } from "node:fs";
import { createHealthDocument } from "./report";
import type { HealthDocument, HealthResult, HealthStatus, RecoveryPolicy } from "./types";

const STATUSES = new Set<HealthStatus>([
  "healthy", "degraded", "recovering", "blocked", "failed", "unknown",
]);
const RECOVERY = new Set<RecoveryPolicy>([
  "automatic", "manual", "confirmation-required", "none",
]);

class UnsupportedSchemaError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
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

export function parseHealthDocument(value: unknown): HealthDocument {
  const raw = object(value, "health document");
  if (raw.schemaVersion !== 1) throw new UnsupportedSchemaError("unsupported health schema");
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

function unavailable(reason: string, now: Date): HealthDocument {
  return createHealthDocument(now.toISOString(), [{
    id: "box.snapshot",
    status: "unknown",
    expected: ["fresh schema version 1 host health snapshot"],
    observed: [reason],
    reason,
    recovery: "none",
  }]);
}

export interface ReadSnapshotOptions {
  profile: string;
  now?: Date;
  maxAgeMs?: number;
}

export function readHealthSnapshot(path: string, options: ReadSnapshotOptions): HealthDocument {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? 45_000;
  if (!existsSync(path)) return unavailable("snapshot_missing", now);

  let document: HealthDocument;
  try {
    document = parseHealthDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return unavailable(error instanceof UnsupportedSchemaError ? "unsupported_schema" : "snapshot_invalid", now);
  }

  const ageMs = now.getTime() - Date.parse(document.observedAt);
  if (ageMs < -5_000) return unavailable("snapshot_clock_skew", now);
  if (ageMs > maxAgeMs) return unavailable("snapshot_stale", now);

  return createHealthDocument(
    document.observedAt,
    document.components.filter((component) => component.profile === undefined || component.profile === options.profile),
  );
}
