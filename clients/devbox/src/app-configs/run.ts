/**
 * run.ts — `devbox config`: link the configured app configs into the sync disk.
 *
 * Client-side filesystem work happens here; box-side work goes through the installed
 * `remote-app-configs` helper so the two sides never drift. Honors DEVBOX_DRYRUN=1.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appConfigsFor, die, hostFor, shQuote, syncDiskEnabled, syncEngineFor, type Config } from "../config";
import { normalizePath, syncDiskRoot } from "../bridge";
import { engineFor } from "../sync/engine";
import { planAppConfigLink, planAppConfigUnlink, type SideState } from "./plan";
import { payloadRelPath, storeRelPath, type ResolvedEntry } from "./registry";

const isDry = () => !!process.env.DEVBOX_DRYRUN;
const out = (s: string) => process.stdout.write(s + "\n");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");

const MARK_START = "# >>> devbox app-configs";
const MARK_END = "# <<< devbox app-configs";

/** Client-side payload path for an entry (absolute). */
export const clientPayload = (profile: string, e: ResolvedEntry): string =>
  join(syncDiskRoot(profile), e.mode === "dir" ? storeRelPath(e) : payloadRelPath(e));

/** Box-side path to the entry's slot inside the sync disk (as seen over ssh). */
const boxStorePath = (profile: string, e: ResolvedEntry): string => `/home/${profile}/sync/${storeRelPath(e)}`;

export function inspectClient(profile: string, e: ResolvedEntry): SideState {
  const p = normalizePath(e.client);
  if (e.mode === "ssh-include") {
    if (!existsSync(p)) return { kind: "absent", summary: "" };
    const body = readFileSync(p, "utf8");
    if (body.includes(MARK_START)) return { kind: "linked", summary: "" };
    const hosts = (body.match(/^[Hh]ost /gm) ?? []).length;
    return hosts ? { kind: "content", summary: `${hosts} hosts` } : { kind: "empty", summary: "" };
  }
  // lstat (not existsSync) so a *dangling* symlink is still seen as a link: existsSync
  // follows the link and would report "absent" for a broken/foreign symlink, which is
  // exactly the silent-data-loss case (the app would just write a fresh empty config).
  let st;
  try { st = lstatSync(p); } catch { return { kind: "absent", summary: "" }; }
  if (st.isSymbolicLink()) {
    return readlinkSync(p) === clientPayload(profile, e)
      ? { kind: "linked", summary: "" }
      : { kind: "foreign-link", summary: readlinkSync(p) };
  }
  const names = readdirSync(p);
  if (!names.length) return { kind: "empty", summary: "" };
  return { kind: "content", summary: summarizeClient(e, p) };
}

function summarizeClient(e: ResolvedEntry, p: string): string {
  if (e.label === "filezilla") {
    const xml = join(p, "sitemanager.xml");
    const n = existsSync(xml) ? (readFileSync(xml, "utf8").match(/<Server>/g) ?? []).length : 0;
    return `${n} sites`;
  }
  return `${readdirSync(p).length} files`;
}

/** Thrown by `boxSh` in place of `die()` when DEVBOX_DRYRUN=1: a dry run previews, it
 *  never aborts hard just because the box happens to be unreachable right now. */
class BoxUnreachable extends Error {}

/** Run the installed `remote-app-configs` helper on the box. Outside a dry run, dies on
 *  unreachable/failed ssh rather than letting a transport failure masquerade as "box is
 *  empty" — that misread could talk the planner into overwriting a box side we never
 *  actually saw. Under DEVBOX_DRYRUN=1, or when the caller passes `allowUnreachable`
 *  (status: a diagnostic must degrade gracefully, not crash, whether or not it's a dry
 *  run), it throws BoxUnreachable instead so the caller can report "unreachable" rather
 *  than dying or misreporting "empty". */
const boxSh = (cfg: Config, profile: string, args: string[], opts: { allowUnreachable?: boolean } = {}): string => {
  const host = hostFor(cfg, profile);
  const cmd = ["remote-app-configs", ...args].map(shQuote).join(" ");
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    const msg = `remote-app-configs ${args[0]} failed on ${host}: ${(r.stderr || r.error?.message || "").trim() || "ssh failed"}`;
    if (isDry() || opts.allowUnreachable) throw new BoxUnreachable(msg);
    die(msg);
  }
  return (r.stdout ?? "").trim();
};

export function inspectBox(cfg: Config, profile: string, e: ResolvedEntry, opts: { allowUnreachable?: boolean } = {}): SideState {
  const raw = boxSh(cfg, profile, ["inspect", e.label, e.box, e.mode, boxStorePath(profile, e)], opts);
  try {
    return JSON.parse(raw) as SideState;
  } catch {
    return { kind: "absent", summary: "" };
  }
}

export async function runConfigLink(cfg: Config, profile: string, opts: { fromClient?: boolean }): Promise<void> {
  const entries = appConfigsFor(cfg, profile);
  if (!entries.length) return void out(`devbox: no app_configs declared for profile "${profile}"`);
  if (!syncDiskEnabled(cfg, profile)) die(`app configs need the sync disk (file_bridge.sync_disk: true for "${profile}")`);
  const disk = syncDiskRoot(profile);
  // A dangling symlink is the real data-loss path: the app just writes a fresh empty
  // config. Refuse rather than link into a disk that is not there.
  if (!existsSync(disk)) die(`sync disk ${disk} does not exist — run \`devbox sync up\` first`);

  for (const e of entries) {
    const client = inspectClient(profile, e);

    let box: SideState;
    try {
      box = inspectBox(cfg, profile, e);
    } catch (err) {
      if (!(isDry() && err instanceof BoxUnreachable)) throw err; // boxSh only throws this under DEVBOX_DRYRUN=1
      out(`  ── ${e.label}: unknown — box unreachable, cannot preview (${(err as Error).message})`);
      continue;
    }
    const storeKind: SideState["kind"] = existsSync(join(disk, storeRelPath(e))) ? "content" : "absent";
    const plan = planAppConfigLink(e, client, box, storeKind);

    // Dry run stops here: read-only inspection above is fine to preview with, but
    // nothing past this point may run under DEVBOX_DRYRUN=1 — in particular, never
    // block on the interactive prompt below, and never resolve "ask" to a guess.
    if (isDry()) {
      out(`  ── ${e.label}: ${plan.decision === "ask" ? "would ask" : plan.decision} (${plan.reason})`);
      continue;
    }

    let decision = plan.decision;
    if (decision === "ask") {
      if (opts.fromClient) decision = "use-client";
      else {
        out(`  ? ${plan.reason}`);
        const answer = (prompt(`    which wins? [client/box/skip]`) ?? "skip").trim().toLowerCase();
        decision = answer.startsWith("c") ? "use-client" : answer.startsWith("b") ? "use-box" : "refuse";
      }
    }

    switch (decision) {
      case "already-linked": out(`  ✓ ${e.label} already linked`); continue;
      case "refuse": out(`  ! ${plan.reason}`); continue;
      case "use-box": boxSh(cfg, profile, ["seed", e.label, e.box, e.mode, boxStorePath(profile, e), ...e.excludes]); break;
      case "use-client": if (client.kind === "content") seedFromClient(profile, e); break;
      case "seed-empty": seedEmpty(profile, e); break;
    }
    linkClient(profile, e);
    boxSh(cfg, profile, ["link", e.label, e.box, e.mode, boxStorePath(profile, e)]);
    out(`  ✓ ${e.label} linked (${decision})`);
  }
}

/** Syncthing marks conflicts as sibling `*.sync-conflict-*` files inside the store;
 *  Mutagen surfaces conflicts through the engine-level SyncStatus instead (checked
 *  separately in runConfigStatus). Missing/non-directory store paths just count 0. */
export function countSyncConflicts(storePath: string): number {
  if (!existsSync(storePath)) return 0;
  return readdirSync(storePath).filter((n) => n.includes(".sync-conflict-")).length;
}

/**
 * `devbox config status` — read-only diagnostic. Never touches the client or the box:
 * only inspects (inspectClient/inspectBox's "inspect" op is a read on the box side too)
 * and reads the sync engine's own status. Surfaces the two silent failure modes:
 *   - the sync session isn't running, so edits stopped propagating even though
 *     everything still looks linked;
 *   - a link whose target is missing in the store, which is the actual data-loss path
 *     (the app would just write a fresh empty config).
 * A box that can't be reached is a normal state to report, not a reason to crash a
 * diagnostic — each entry falls back to `box=unreachable` instead of dying.
 */
export async function runConfigStatus(cfg: Config, profile: string): Promise<void> {
  const entries = appConfigsFor(cfg, profile);
  if (!entries.length) return void out(`devbox: no app_configs declared for profile "${profile}"`);
  const disk = syncDiskRoot(profile);

  // Session naming is exact (`devbox-<profile>`, see sync/mutagen.ts sessionName and
  // sync/syncthing.ts folderId) — not a substring match, which would misfire whenever
  // one profile name happens to be a substring of another (e.g. "eng" inside "engineer").
  const sessions = await engineFor(syncEngineFor(cfg, profile)).status();
  const session = sessions.find((s) => s.name === `devbox-${profile}`);
  if (!session) {
    out(`  ! sync is not running — edits are NOT propagating (devbox sync up)`);
  } else {
    // A session that exists is not necessarily syncing: `devbox sync pause` (Mutagen) or
    // a paused Syncthing folder both leave the session/folder in place but stop
    // propagation just as thoroughly as it being torn down — worded distinctly so a user
    // can tell "never started" apart from "started, then paused".
    if (/pause|disconnect/i.test(session.state)) out(`  ! sync is paused (${session.state}) — edits are NOT propagating (devbox sync resume)`);
    if (session.conflicts > 0) out(`  ! ${session.conflicts} conflict(s) reported by the sync engine — resolve before continuing`);
  }

  for (const e of entries) {
    const client = inspectClient(profile, e);

    let boxKind: string;
    try {
      boxKind = inspectBox(cfg, profile, e, { allowUnreachable: true }).kind;
    } catch (err) {
      if (!(err instanceof BoxUnreachable)) throw err; // boxSh only throws this for dry-run/allowUnreachable
      boxKind = "unreachable";
    }

    // The store *directory* (storeRelPath) only IS the link target for "dir" mode; for
    // "file"/"ssh-include" the real target is a specific file inside it (clientPayload,
    // same path linkClient's symlink/Include line points at). Checking the directory
    // instead of the payload path is exactly how a missing ssh_config payload went
    // undetected: the directory existed, so "store=ok" printed even though the included
    // file was gone.
    const storeDir = join(disk, storeRelPath(e));
    const target = clientPayload(profile, e);
    const targetOk = existsSync(target);
    const conflicts = countSyncConflicts(storeDir);

    out(`  ${e.label}: client=${client.kind} box=${boxKind} store=${targetOk ? "ok" : "MISSING"}` +
        (conflicts ? ` ⚠ ${conflicts} conflict file(s)` : ""));
    if (client.kind === "linked" && !targetOk) {
      out(`    ! the link has no target — the app will write a fresh empty config`);
    }
  }
}

/**
 * Client-side inverse of `linkClient` — the fs-only half of unlink, so it is testable
 * the same way `linkClient` is (no ssh in sight). Only mutates when the store payload
 * actually exists: an absent payload means leaving the link in place rather than
 * deleting it and finding nothing to put back (the missing-payload window the shell
 * script was faulted for — never make it worse from this side either).
 */
export function unlinkClient(profile: string, e: ResolvedEntry): { restored: boolean; reason?: string } {
  const p = normalizePath(e.client);
  const target = clientPayload(profile, e);
  if (e.mode === "ssh-include") {
    // Exact inverse of linkClient: that write is `MARK_START..MARK_END\n` + the
    // pre-link body, with the real Host entries left in the store payload file
    // (included via the block's `Include` line, never copied back into this file until
    // now). Regex tolerates the block already being absent (a no-op unlink re-run).
    const body = existsSync(p) ? readFileSync(p, "utf8") : "";
    const stripped = body.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`), "");
    if (!existsSync(target)) {
      writeFileSync(p, stripped, { mode: 0o600 });
      return { restored: false, reason: "store payload is missing — Include block removed, but its host entries could not be recovered" };
    }
    writeFileSync(p, readFileSync(target, "utf8") + stripped, { mode: 0o600 });
    return { restored: true };
  }
  if (!existsSync(target)) {
    return { restored: false, reason: "store payload is missing — cannot restore, leaving the link in place" };
  }
  rmSync(p); // only removes the symlink entry — the real data stays untouched in the store
  cpSync(target, p, { recursive: true });
  return { restored: true };
}

/**
 * `devbox config unlink` — the clean exit: after this runs, the client must be left
 * with a working real file/directory in place of the link, on both modes, with nothing
 * lost. Box-side restore is delegated to the installed `remote-app-configs` helper
 * (Task 7) so the two sides never drift; the synced copies under `.app-configs/` are
 * left behind on purpose (the user deletes them by hand once they're sure).
 */
export async function runConfigUnlink(cfg: Config, profile: string, label?: string): Promise<void> {
  const all = appConfigsFor(cfg, profile);
  if (!all.length) return void out(`devbox: no app_configs declared for profile "${profile}"`);
  if (label && !all.some((e) => e.label === label)) {
    return void die(`unknown app config "${label}" for profile "${profile}" — known: ${all.map((e) => e.label).join(", ")}`);
  }
  const entries = all.filter((e) => !label || e.label === label);

  for (const e of entries) {
    const client = inspectClient(profile, e);
    const plan = planAppConfigUnlink(e, client);

    if (isDry()) {
      out(`  ── ${e.label}: ${plan.action} (${plan.reason})`);
      continue;
    }

    if (plan.action === "restore") {
      const r = unlinkClient(profile, e);
      if (!r.restored) out(`  ! ${e.label}: ${r.reason}`);
    }
    out(`  ✓ ${e.label}: ${plan.action}${plan.action === "skip" ? ` (${plan.reason})` : ""}`);
    boxSh(cfg, profile, ["unlink", e.label, e.box, e.mode, boxStorePath(profile, e)]);
  }
  out(`  · the synced copies are left in ${join(syncDiskRoot(profile), ".app-configs")} — delete them by hand when you are sure`);
}

/** Create an empty store when neither side has content. For "dir" mode the target
 *  itself is the store directory, so mkdir is enough. For "file"/"ssh-include" the
 *  target is a specific file *inside* the store directory (clientPayload/payloadRelPath)
 *  — creating only the directory would leave `linkClient`'s Include/symlink pointing at
 *  a file that doesn't exist, which OpenSSH treats as a hard error for a literal (non-glob)
 *  Include path. So a real (empty) file has to exist at the payload path too. */
export function seedEmpty(profile: string, e: ResolvedEntry): void {
  const target = clientPayload(profile, e);
  if (e.mode === "dir") {
    mkdirSync(target, { recursive: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "");
}

export function seedFromClient(profile: string, e: ResolvedEntry): void {
  const src = normalizePath(e.client);
  const dst = clientPayload(profile, e);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, filter: (p) => !e.excludes.some((x) => matches(p, x)) });
  renameSync(src, `${src}.pre-devbox-${stamp()}`);
}

export const matches = (p: string, pattern: string): boolean => {
  const name = p.split("/").pop() ?? "";
  return pattern.includes("*") ? new RegExp("^" + pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(name) : name === pattern;
};

export function linkClient(profile: string, e: ResolvedEntry): void {
  const target = clientPayload(profile, e);
  const p = normalizePath(e.client);
  if (e.mode === "ssh-include") {
    const body = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (body.includes(MARK_START)) return;
    writeFileSync(p, `${MARK_START}\nInclude ${target}\n${MARK_END}\n${body}`, { mode: 0o600 });
    return;
  }
  // lstat, not existsSync: a dangling symlink still occupies `p` and would make
  // symlinkSync below fail with EEXIST if left in place.
  let st;
  try { st = lstatSync(p); } catch { st = null; }
  if (st) {
    if (st.isSymbolicLink() && readlinkSync(p) === target) return; // already correct — leave it alone, nothing to do
    renameSync(p, `${p}.pre-devbox-${stamp()}`); // never delete — anything occupying p (real content, or a foreign/stale link) is moved aside
  }
  mkdirSync(dirname(p), { recursive: true });
  // "dir" mode needs the target itself to exist as a directory (the app reads inside
  // it); "file" mode must only ensure the target's *parent* exists — mkdir'ing the
  // target here would plant a directory where the app expects a plain file.
  mkdirSync(e.mode === "dir" ? target : dirname(target), { recursive: true });
  symlinkSync(target, p);
}
