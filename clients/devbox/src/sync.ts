/**
 * sync.ts — `devbox sync`: a persistent two-way "disk" per profile
 * (~/devbox/<profile> <-> /home/<profile>/sync) driven by the configured engine.
 * planSync is pure (tested); runSync* orchestrate (honor DEVBOX_DRYRUN).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appConfigsFor, die, hostFor, lazyMountsFor, syncDiskEnabled, syncEngineFor, type Config, type EngineId,
} from "./config";
import { normalizePath, pathsOverlap, syncDiskRoot } from "./bridge";
import { STORE_ROOT } from "./app-configs/registry";
import {
  DEFAULT_IGNORES, engineFor, type SyncAutostart, type SyncEngine, type SyncStatus,
} from "./sync/engine";
import type { LocalHealthResult } from "./health";

export type SyncPlan = { localRoot: string; remoteRoot: string; host: string; engine: EngineId; ignores: string[] };

export function syncHealthFromStatus(
  profile: string,
  evidence: SyncStatus,
  autostart: SyncAutostart | null = null,
): LocalHealthResult {
  const observed = [
    `session ${evidence.name}`,
    `state ${evidence.state || "unknown"}`,
    evidence.conflicts === null ? "conflicts unknown" : `conflicts ${evidence.conflicts}`,
    ...(autostart ? [`login autostart ${autostart.registered ? "registered" : "not registered"}`] : []),
  ];
  const base = {
    id: `client.sync.${profile}`,
    expected: [
      "sync session active with exactly zero conflicts",
      ...(autostart ? ["client sync daemon registered for login autostart"] : []),
    ],
    observed,
    recovery: "automatic" as const,
  };
  if (evidence.conflicts === null) {
    return { ...base, status: "unknown", reason: "sync_conflicts_unknown" };
  }
  if (evidence.conflicts > 0) {
    return { ...base, status: "blocked", reason: "sync_conflicts" };
  }
  if (/paused/i.test(evidence.state)) return { ...base, status: "degraded", reason: "sync_paused" };
  if (/disconnected|offline|error|halted/i.test(evidence.state)) {
    return { ...base, status: "failed", reason: "sync_disconnected" };
  }
  // A session that is syncing right now but whose daemon nothing supervises is not
  // healthy: it stops at the next reboot and reports nothing while it is stopped.
  if (autostart && !autostart.registered) {
    return { ...base, status: "degraded", reason: "sync_autostart_unregistered" };
  }
  return { ...base, status: "healthy" };
}

async function syncStatusWithTimeout(engine: SyncEngine, timeoutMs = 8_000): Promise<SyncStatus[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      engine.status(),
      new Promise<SyncStatus[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sync status timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectSyncHealth(
  cfg: Config,
  profile: string,
  injectedEngine?: SyncEngine,
): Promise<LocalHealthResult | null> {
  if (!syncDiskEnabled(cfg, profile)) return null;
  const engine = injectedEngine ?? engineFor(syncEngineFor(cfg, profile));
  let statuses: SyncStatus[];
  try {
    statuses = await syncStatusWithTimeout(engine);
  } catch {
    statuses = [];
  }
  const name = `devbox-${profile}`;
  const evidence = statuses.find((candidate) => candidate.name === name);
  if (!evidence) {
    return {
      id: `client.sync.${profile}`,
      status: "unknown",
      expected: [`sync session ${name} with exactly zero conflicts`],
      observed: [`session ${name} not present in engine evidence`, "conflicts unknown"],
      reason: "sync_session_missing",
      recovery: "automatic",
    };
  }
  return syncHealthFromStatus(profile, evidence, engine.autostart?.() ?? null);
}

export type SyncRecoveryDecision =
  | { action: "up" | "resume" | "autostart" | "skip"; reason: string }
  | { action: "refuse"; reason: string };

export function decideSyncRecovery(
  evidence: SyncStatus,
  autostart: SyncAutostart | null = null,
): SyncRecoveryDecision {
  if (evidence.conflicts === null) return { action: "refuse", reason: "sync_conflicts_unknown" };
  if (evidence.conflicts > 0) return { action: "refuse", reason: "sync_conflicts" };
  if (/paused/i.test(evidence.state)) return { action: "resume", reason: "sync_paused" };
  if (/disconnected|offline|error|halted/i.test(evidence.state)) {
    return { action: "up", reason: "sync_disconnected" };
  }
  // Session evidence is clean, so the only thing left to fix is the supervisor. Ordered
  // last on purpose: registering it restarts the daemon, which is the wrong move while
  // a session is mid-conflict or mid-reconnect.
  if (autostart && !autostart.registered) {
    return { action: "autostart", reason: "sync_autostart_unregistered" };
  }
  return { action: "skip", reason: "already_healthy" };
}

export interface SyncRecoveryActions {
  up: (session: string) => Promise<void>;
  resume: (session: string) => Promise<void>;
  autostart: (session: string) => Promise<void>;
}

export async function recoverSync(
  evidence: SyncStatus,
  actions: SyncRecoveryActions,
  autostart: SyncAutostart | null = null,
): Promise<{ status: "recovered" | "skipped" | "blocked" | "failed"; reason: string }> {
  const decision = decideSyncRecovery(evidence, autostart);
  if (decision.action === "refuse") return { status: "blocked", reason: decision.reason };
  if (decision.action === "skip") return { status: "skipped", reason: decision.reason };
  try {
    await actions[decision.action](evidence.name);
    return {
      status: "recovered",
      reason: decision.action === "resume"
        ? "sync_resumed"
        : decision.action === "autostart"
          ? "sync_autostart_registered"
          : "sync_started",
    };
  } catch {
    return { status: "failed", reason: "sync_action_failed" };
  }
}

export async function recoverSyncLive(
  cfg: Config,
  profile: string,
  expectedReason: string,
  engine: SyncEngine = engineFor(syncEngineFor(cfg, profile)),
): Promise<{ status: "acted" | "blocked" | "failed"; reason: string }> {
  let statuses: SyncStatus[];
  try {
    statuses = await syncStatusWithTimeout(engine);
  } catch {
    return { status: "blocked", reason: "sync_evidence_unknown" };
  }
  const evidence = statuses.find((candidate) => candidate.name === `devbox-${profile}`);
  if (!evidence) return { status: "blocked", reason: "sync_session_missing" };
  const autostart = engine.autostart?.() ?? null;
  const health = syncHealthFromStatus(profile, evidence, autostart);
  if (health.reason !== expectedReason || (health.status !== "failed" && health.status !== "degraded")) {
    return { status: "blocked", reason: "sync_evidence_changed" };
  }
  const result = await recoverSync(evidence, {
    // A disconnected named session already exists; resume asks the engine to reconnect
    // without deleting or recreating it. The "up" decision is semantic, not a recreate.
    up: async () => engine.resume(profile),
    resume: async () => engine.resume(profile),
    // Report failure from the re-probe, not from the call: installing the supervisor is
    // several best-effort steps that never throw.
    autostart: async () => {
      engine.ensureAutostart?.();
      if (!engine.autostart?.()?.registered) throw new Error("autostart not registered");
    },
  }, autostart);
  if (result.status === "recovered") return { status: "acted", reason: result.reason };
  if (result.status === "failed") return { status: "failed", reason: result.reason };
  return { status: "blocked", reason: result.reason };
}

/**
 * Root-anchored ignore patterns for the app configs that live inside the disk.
 *
 * A registry entry's `excludes` only guard the initial seed — after linking, the app
 * writes straight into the store, so anything machine-local (FileZilla's transfer queue
 * and lock marker) would propagate on the next edit unless the session ignores it too.
 */
export function appConfigIgnores(cfg: Config, profile: string): string[] {
  return appConfigsFor(cfg, profile).flatMap((e) =>
    e.excludes.map((pattern) => `/${STORE_ROOT}/${e.label}/${pattern}`));
}

export function planSync(cfg: Config, profile: string): SyncPlan {
  if (!syncDiskEnabled(cfg, profile)) die(`sync disk is not enabled for "${profile}" (set sync_disk: true)`);
  const localRoot = syncDiskRoot(profile);
  for (const m of lazyMountsFor(cfg, profile))
    if (pathsOverlap(normalizePath(m.path), localRoot))
      die(`lazy mount "${m.label}" overlaps the sync disk ${localRoot} — a folder is either mounted or synced`);
  return {
    localRoot,
    remoteRoot: `/home/${profile}/sync`,
    host: hostFor(cfg, profile),
    engine: syncEngineFor(cfg, profile),
    ignores: [...DEFAULT_IGNORES, ...appConfigIgnores(cfg, profile)],
  };
}

const isDry = () => !!process.env.DEVBOX_DRYRUN;
const out = (s: string) => process.stdout.write(s + "\n");

const README = `# devbox sync disk

Anything in this folder is continuously TWO-WAY synced to the box at /home/<profile>/sync and
stays available there even when this client is closed.

- Edits flow both ways. Conflicts are surfaced (run \`devbox sync status\`), never auto-merged.
- These are ignored (never synced): .git, node_modules, dist, build, .next, target.
- This is for trusted code you work on — not a place to receive untrusted output.
- Deleting here deletes on the box too. Git is your real history/undo.
`;

export async function runSyncUp(cfg: Config, profile: string): Promise<void> {
  const plan = planSync(cfg, profile);
  if (isDry()) return void out(`  ── would sync ${plan.localRoot} <-> ${plan.host}:${plan.remoteRoot} via ${plan.engine}`);
  if (plan.engine === "mutagen" && !Bun.which("mutagen"))
    die("mutagen not found — install it: brew install mutagen-io/mutagen/mutagen");
  mkdirSync(plan.localRoot, { recursive: true });
  const readme = join(plan.localRoot, "README.md");
  if (!existsSync(readme)) writeFileSync(readme, README);
  await engineFor(plan.engine).up({ profile, host: plan.host, localRoot: plan.localRoot, remoteRoot: plan.remoteRoot, ignores: plan.ignores });
  out(`  ✓ syncing ${plan.localRoot} <-> ${plan.host}:${plan.remoteRoot} (${plan.engine})`);
}

export async function runSyncDown(cfg: Config, profile: string): Promise<void> {
  const plan = planSync(cfg, profile);
  if (isDry()) return void out(`  ── would stop sync for ${profile} (${plan.engine})`);
  await engineFor(plan.engine).down(profile);
  out(`  ✓ stopped sync for ${profile}`);
}

export async function runSyncPause(cfg: Config, profile: string, resume: boolean): Promise<void> {
  const plan = planSync(cfg, profile);
  if (isDry()) return void out(`  ── would ${resume ? "resume" : "pause"} sync for ${profile}`);
  const e = engineFor(plan.engine);
  await (resume ? e.resume(profile) : e.pause(profile));
  out(`  ✓ ${resume ? "resumed" : "paused"} ${profile}`);
}

/** Status across ALL configured engines (so a mixed Mutagen+Syncthing setup shows both). */
export async function runSyncStatus(cfg: Config): Promise<void> {
  const seen = new Set<EngineId>();
  let any = false;
  for (const p of cfg.profiles) {
    const id = syncEngineFor(cfg, p.user);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const s of await engineFor(id).status()) {
      any = true;
      const conflicts = s.conflicts === null
        ? "  ? conflict count unavailable"
        : s.conflicts > 0 ? `  ⚠ ${s.conflicts} conflict(s)` : "";
      out(`  [${id}] ${s.name}  ${s.state}${conflicts}`);
    }
  }
  if (!any) out("devbox: no active sync sessions");
}
