import type { MemoryLimitSpec, MemoryWeightSpec } from "./types";

const DIRECT_SIZE_RE = /^(\d+)([KMGT]?)(?:B)?$/;
const PERCENT_RE = /^(?:[1-9]\d?|100)%$/;

/**
 * Normalizes direct systemd memory values. An empty value means the corresponding
 * systemd limit is disabled; percentages remain percentages of physical memory.
 */
export function canonicalMemorySize(value: string): string | null {
  if (value === "" || PERCENT_RE.test(value)) return value;

  const match = DIRECT_SIZE_RE.exec(value);
  if (!match) return null;

  const [, amount, unit] = match;
  return `${amount}${unit}`;
}

/** A proportional memory share has one, and only one, positive integer field. */
export function isMemoryWeight(value: unknown): value is MemoryWeightSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const entries = Object.entries(value);
  return (
    entries.length === 1 &&
    entries[0]?.[0] === "weight" &&
    typeof entries[0][1] === "number" &&
    Number.isInteger(entries[0][1]) &&
    entries[0][1] > 0
  );
}

export function formatMemoryLimit(value: MemoryLimitSpec): string {
  return typeof value === "string" ? canonicalMemorySize(value) ?? value : String(value.weight);
}
