export interface MemInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
}

export interface SwapDevice {
  name: string;
  type: string; // "file" | "partition"
  sizeBytes: number;
  usedBytes: number;
  priority: number;
}

export interface OomEvent {
  /** epoch seconds parsed from the `dmesg -T` bracket timestamp */
  at: number;
  /** raw timestamp text as printed by dmesg */
  atText: string;
  process: string; // e.g. "bun"
  pid: number;
  uid: number;
}

export interface RcUnit {
  unit: string; // e.g. "agent-rc-claude-dev-a-example-monorepo.service"
  loaded: boolean;
  active: string; // "active" | "failed" | "inactive" | ...
  sub: string; // "exited" | "failed" | "running" | ...
}

export type SessionState = "active" | "idle" | "dead";

export interface Session {
  cse: string; // e.g. "cse_01CVdoCP..."
  pid: number | null; // null when no live process
  /** epoch seconds of newest transcript write, or null if unknown */
  lastActivity: number | null;
  worktreePath: string | null;
  state: SessionState;
}

export interface Worktree {
  path: string;
  branch: string;
  locked: boolean;
  /** cse id extracted from the path, or null */
  cse: string | null;
}

export interface ProcRef {
  pid: number;
  /** full command line, used to detect cross-session worktree references */
  cmd: string;
}

export type ConditionSeverity = "high" | "medium" | "low";

export interface Condition {
  id: string; // stable id, e.g. "rc-...-failed"
  severity: ConditionSeverity;
  facts: Record<string, string | number | boolean>;
  candidateAction: string | "unknown";
  guard: "pass" | string; // "pass" | "blocked:active-session" | ...
}

export interface Health {
  now: number; // epoch seconds, injected (testable)
  mem: MemInfo;
  swap: SwapDevice[];
  oom: OomEvent[];
  units: RcUnit[];
  sessions: Session[];
  worktrees: Worktree[];
  conditions: Condition[];
}

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
  status: HealthStatus;
  expected: string[];
  observed: string[];
  reason?: string;
  recovery: RecoveryPolicy;
}

export interface HealthDocument {
  schemaVersion: 1;
  status: HealthStatus;
  observedAt: string;
  components: HealthResult[];
}
