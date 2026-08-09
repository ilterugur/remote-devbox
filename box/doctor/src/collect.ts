import { parseMem } from "./parse/mem";
import { parseSwap } from "./parse/swap";
import { parseOomEvents } from "./parse/oom";
import { parseRcUnits } from "./parse/rc";
import { parseWorktrees } from "./parse/worktrees";
import { parseProcs, sessionPidsByCse } from "./parse/sessions";
import { classifySession } from "./classify";
import { detectConditions } from "./conditions";
import type { Health, HealthResult, HealthStatus, Session } from "./types";
import type { HealthComponentFact, HealthFacts, TcpListenerFact, UnixListenerFact } from "./facts";
import { createHealthDocument } from "./report";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type CommandRunner = (argv: string[], timeoutMs?: number) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (argv, timeoutMs = 8_000) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

async function sh(cmd: string[], timeoutMs = 10_000): Promise<string> {
  return (await runCommand(cmd, timeoutMs)).stdout;
}

const STATUS_PRIORITY: Record<HealthStatus, number> = {
  healthy: 0,
  recovering: 1,
  degraded: 2,
  unknown: 3,
  blocked: 4,
  failed: 5,
};

function worsen(current: HealthStatus, next: HealthStatus): HealthStatus {
  return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
}

function systemdProperties(output: string): Record<string, string> {
  return Object.fromEntries(
    output.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function expectedListener(listener: TcpListenerFact | UnixListenerFact): string {
  return listener.protocol === "tcp"
    ? `${listener.address}:${listener.port} owned by ${listener.process}`
    : `${listener.path} owned by ${listener.process}`;
}

function listenerLine(listener: TcpListenerFact | UnixListenerFact, evidence: string): string | undefined {
  const location = listener.protocol === "tcp" ? `${listener.address}:${listener.port}` : listener.path;
  return evidence.split("\n").find((line) => line.includes(location));
}

function listenerOwnerMatches(listener: TcpListenerFact | UnixListenerFact, line: string): boolean {
  const names = [...line.matchAll(/\("([^"]+)"/g)].map((match) => match[1]!);
  return listener.processMatch === "prefix"
    ? names.some((name) => name.startsWith(listener.process))
    : names.includes(listener.process);
}

async function safeRun(run: CommandRunner, argv: string[]): Promise<CommandResult> {
  try {
    return await run(argv);
  } catch {
    // Never serialize the thrown error: process-launch failures can include environment,
    // paths, or wrapper text that is outside the health report's credential boundary.
    return { stdout: "", stderr: "", exitCode: null, timedOut: false };
  }
}

async function collectComponent(
  fact: HealthComponentFact,
  run: CommandRunner,
  tcpEvidence: Promise<CommandResult> | null,
  unixEvidence: Promise<CommandResult> | null,
): Promise<HealthResult> {
  const expected = [
    ...(fact.unit ? [`${fact.unit} active`] : []),
    ...(fact.listeners ?? []).map(expectedListener),
  ];
  const observed: string[] = [];
  let status: HealthStatus = "healthy";
  let reason: string | undefined;

  if (fact.unit) {
    const scope = fact.unitScope === "user"
      ? ["--user", `--machine=${fact.profile}@`]
      : [];
    const unit = await safeRun(run, [
      "systemctl", ...scope, "show", "--no-pager",
      "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=MainPID",
      fact.unit,
    ]);
    if (unit.timedOut) {
      status = worsen(status, "unknown");
      reason = "probe_timeout";
      observed.push("systemd probe timed out");
    } else if (unit.exitCode !== 0) {
      status = worsen(status, "unknown");
      reason = unit.exitCode === null ? "probe_unavailable" : "systemd_unavailable";
      observed.push("systemd state unavailable");
    } else {
      const state = systemdProperties(unit.stdout);
      const active = state.ActiveState ?? "unknown";
      const sub = state.SubState ?? "unknown";
      const pid = state.MainPID ?? "0";
      observed.push(`${active}/${sub} pid ${pid}`);
      if (state.LoadState !== "loaded") {
        status = worsen(status, "failed");
        reason = "unit_not_loaded";
      } else if (active === "activating") {
        status = worsen(status, "recovering");
        reason = "unit_activating";
      } else if (active !== "active") {
        status = worsen(status, "failed");
        reason = active === "failed" ? "unit_failed" : "unit_inactive";
      }
    }
  }

  for (const listener of fact.listeners ?? []) {
    const probe = await (listener.protocol === "tcp" ? tcpEvidence : unixEvidence);
    if (!probe || probe.timedOut) {
      status = worsen(status, "unknown");
      if (status === "unknown") reason = "probe_timeout";
      observed.push(`${listener.protocol} listener evidence timed out`);
      continue;
    }
    if (probe.exitCode !== 0) {
      status = worsen(status, "unknown");
      if (status === "unknown") reason = probe.exitCode === null ? "probe_unavailable" : "permission_denied";
      observed.push(`${listener.protocol} listener evidence unavailable`);
      continue;
    }
    const line = listenerLine(listener, probe.stdout);
    if (!line) {
      status = worsen(status, "failed");
      reason = "listener_missing";
      observed.push(`${listener.protocol} listener missing`);
      continue;
    }
    if (!listenerOwnerMatches(listener, line)) {
      status = worsen(status, "failed");
      reason = "listener_owner_mismatch";
      observed.push(`${listener.protocol} listener has a different owner`);
      continue;
    }
    const location = listener.protocol === "tcp" ? `${listener.address}:${listener.port}` : listener.path;
    observed.push(`${listener.process} owns ${location}`);
  }

  return {
    id: fact.id,
    ...(fact.profile ? { profile: fact.profile } : {}),
    status,
    expected,
    observed,
    ...(reason ? { reason } : {}),
    recovery: fact.recovery,
  };
}

export async function collectHostDocument(facts: HealthFacts, run: CommandRunner, now = new Date()) {
  const needsTcp = facts.components.some((component) => component.listeners?.some((listener) => listener.protocol === "tcp"));
  const needsUnix = facts.components.some((component) => component.listeners?.some((listener) => listener.protocol === "unix"));
  const tcpEvidence = needsTcp ? safeRun(run, ["ss", "-Hlnpt"]) : null;
  const unixEvidence = needsUnix ? safeRun(run, ["ss", "-Hxlpn"]) : null;
  const components = await Promise.all(
    facts.components.map((fact) => collectComponent(fact, run, tcpEvidence, unixEvidence)),
  );
  return createHealthDocument(now.toISOString(), components);
}

export interface CollectOpts {
  profileHome: string; // e.g. /home/dev-a
  activityWindowSec: number;
  idleAfterSec: number;
}

export async function collect(opts: CollectOpts): Promise<Health> {
  const now = Math.floor(Date.now() / 1000);

  const [free, swap, dmesg, units, ps] = await Promise.all([
    sh(["free", "-b"]),
    sh(["swapon", "--show=NAME,TYPE,SIZE,USED,PRIO", "--bytes", "--noheadings"]),
    sh(["sh", "-c", "dmesg -T 2>/dev/null | grep -i 'killed process' || true"]),
    sh(["systemctl", "list-units", "agent-rc-*", "--all", "--no-legend", "--plain"]),
    sh(["ps", "-eo", "pid,cmd", "--no-headers"]),
  ]);

  const procs = parseProcs(ps);
  const sessionPids = sessionPidsByCse(procs);

  const wtRaw = await sh([
    "sh",
    "-c",
    `for d in "${opts.profileHome}"/projects/*/; do git -C "$d" -c safe.directory='*' worktree list --porcelain 2>/dev/null; done`,
  ]);
  const worktrees = parseWorktrees(wtRaw);

  const sessions: Session[] = [...sessionPids.entries()].map(([cse, pid]) => ({
    cse,
    pid,
    lastActivity: null,
    worktreePath: worktrees.find((w) => w.cse === cse)?.path ?? null,
    state: classifySession(
      { pid, lastActivity: null },
      { now, activityWindowSec: opts.activityWindowSec, idleAfterSec: opts.idleAfterSec },
    ),
  }));

  const rcUnits = parseRcUnits(units);
  return {
    now,
    mem: parseMem(free),
    swap: parseSwap(swap),
    oom: parseOomEvents(dmesg),
    units: rcUnits,
    sessions,
    worktrees,
    conditions: detectConditions({ units: rcUnits, worktrees, procs }),
  };
}
