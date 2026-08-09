import type { RcUnit } from "../types";

export function parseRcUnits(systemctlOutput: string): RcUnit[] {
  return systemctlOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("agent-rc-"))
    .map((l) => l.split(/\s+/))
    .filter((f) => f.length >= 4)
    .map(([unit, load, active, sub]) => ({
      unit,
      loaded: load === "loaded",
      active,
      sub,
    }));
}
