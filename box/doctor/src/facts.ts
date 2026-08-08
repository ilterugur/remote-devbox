import type { RecoveryPolicy } from "./types";

export interface TcpListenerFact {
  protocol: "tcp";
  address: string;
  port: number;
  process: string;
  processMatch?: "exact" | "prefix";
}

export interface UnixListenerFact {
  protocol: "unix";
  path: string;
  process: string;
  processMatch?: "exact" | "prefix";
}

export interface HealthComponentFact {
  id: string;
  profile?: string;
  unit?: string;
  listeners?: (TcpListenerFact | UnixListenerFact)[];
  recovery: RecoveryPolicy;
}

export interface HealthFacts {
  schemaVersion: 1;
  components: HealthComponentFact[];
}

const RECOVERY_POLICIES = new Set<RecoveryPolicy>([
  "automatic",
  "manual",
  "confirmation-required",
  "none",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseListener(value: unknown): TcpListenerFact | UnixListenerFact {
  const raw = record(value, "health listener");
  const process = raw.process;
  if (typeof process !== "string" || !/^[A-Za-z0-9_.@-]+$/.test(process)) {
    throw new Error("invalid listener process");
  }
  if (raw.processMatch !== undefined && raw.processMatch !== "exact" && raw.processMatch !== "prefix") {
    throw new Error("invalid listener process match");
  }
  const match = raw.processMatch === undefined ? {} : { processMatch: raw.processMatch };
  if (raw.protocol === "tcp") {
    if (
      typeof raw.address !== "string"
      || !/^[A-Fa-f0-9:.]+$/.test(raw.address)
      || !Number.isInteger(raw.port)
      || (raw.port as number) < 1
      || (raw.port as number) > 65_535
    ) throw new Error("invalid TCP listener");
    return { protocol: "tcp", address: raw.address, port: raw.port as number, process, ...match };
  }
  if (raw.protocol === "unix") {
    if (typeof raw.path !== "string" || !/^[A-Za-z0-9_./@-]+$/.test(raw.path)) {
      throw new Error("invalid Unix listener");
    }
    return { protocol: "unix", path: raw.path, process, ...match };
  }
  throw new Error("invalid listener protocol");
}

export function parseHealthFacts(value: unknown): HealthFacts {
  const raw = record(value, "health facts");
  if (raw.schemaVersion !== 1) throw new Error("unsupported health facts schema");
  if (!Array.isArray(raw.components)) throw new Error("health facts components must be a list");

  const seen = new Set<string>();
  const components = raw.components.map((value, index): HealthComponentFact => {
    const component = record(value, `health component ${index}`);
    if (typeof component.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(component.id)) {
      throw new Error(`invalid component id at index ${index}`);
    }
    if (seen.has(component.id)) throw new Error(`duplicate component id '${component.id}'`);
    seen.add(component.id);
    if (
      component.profile !== undefined
      && (typeof component.profile !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(component.profile))
    ) throw new Error(`invalid profile for '${component.id}'`);
    if (!RECOVERY_POLICIES.has(component.recovery as RecoveryPolicy)) {
      throw new Error(`invalid recovery policy for '${component.id}'`);
    }
    if (
      component.unit !== undefined
      && (typeof component.unit !== "string" || !/^[A-Za-z0-9_.@-]+[.]service$/.test(component.unit))
    ) throw new Error(`invalid unit for '${component.id}'`);
    if (component.listeners !== undefined && !Array.isArray(component.listeners)) {
      throw new Error(`listeners for '${component.id}' must be a list`);
    }
    return {
      id: component.id,
      ...(component.profile === undefined ? {} : { profile: component.profile as string }),
      ...(component.unit === undefined ? {} : { unit: component.unit as string }),
      ...(component.listeners === undefined ? {} : { listeners: component.listeners.map(parseListener) }),
      recovery: component.recovery as RecoveryPolicy,
    };
  });

  return { schemaVersion: 1, components };
}
