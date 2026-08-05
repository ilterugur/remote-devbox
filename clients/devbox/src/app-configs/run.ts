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
import { payloadBasename, payloadRelPath, storeRelPath, type ResolvedEntry } from "./registry";

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
  if (e.mode === "file") {
    // A regular file, not a directory: readdirSync(p) below would throw ENOTDIR. Emptiness
    // is byte size, not directory listing.
    return st.size === 0 ? { kind: "empty", summary: "" } : { kind: "content", summary: summarizeClient(e, p) };
  }
  const names = readdirSync(p);
  if (!names.length) return { kind: "empty", summary: "" };
  return { kind: "content", summary: summarizeClient(e, p) };
}

function summarizeClient(e: ResolvedEntry, p: string): string {
  if (e.mode === "file") {
    return `${lstatSync(p).size} bytes`;
  }
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
/**
 * How a box-side command is run. Swappable because the real one is ssh, and a test with
 * a synthetic profile name resolves to an alias that does not exist — which turns into a
 * DNS lookup and a multi-second timeout. That made these tests both slow and dependent
 * on the machine's network, so a red suite stopped meaning "the code is wrong".
 */
export type BoxExec = (host: string, cmd: string) => { status: number; stdout: string; stderr: string };

const sshExec: BoxExec = (host, cmd) => {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr || r.error?.message || "").toString() };
};

let boxExec: BoxExec = sshExec;

/** Test seam. Pass null to restore the real ssh runner. */
export const setBoxExec = (fn: BoxExec | null): void => {
  boxExec = fn ?? sshExec;
};

const boxSh = (cfg: Config, profile: string, args: string[], opts: { allowUnreachable?: boolean } = {}): string => {
  const host = hostFor(cfg, profile);
  const cmd = ["remote-app-configs", ...args].map(shQuote).join(" ");
  const r = boxExec(host, cmd);
  if (r.status !== 0) {
    const msg = `remote-app-configs ${args[0]} failed on ${host}: ${r.stderr.trim() || "ssh failed"}`;
    if (isDry() || opts.allowUnreachable) throw new BoxUnreachable(msg);
    die(msg);
  }
  return r.stdout.trim();
};

export function inspectBox(cfg: Config, profile: string, e: ResolvedEntry, opts: { allowUnreachable?: boolean } = {}): SideState {
  const raw = boxSh(cfg, profile, ["inspect", e.label, e.box, e.mode, boxStorePath(profile, e), payloadBasename(e)], opts);
  try {
    return JSON.parse(raw) as SideState;
  } catch {
    return { kind: "absent", summary: "" };
  }
}

/** Box-side path to the entry's payload file (as seen over ssh) — "dir" mode has no
 *  single payload file, so callers only use this for "file"/"ssh-include". */
const boxPayloadPath = (profile: string, e: ResolvedEntry): string => `${boxStorePath(profile, e)}/${payloadBasename(e)}`;

/** Pull a just-seeded box payload down into the client-side store immediately, via ssh,
 *  instead of leaving `linkClient` to link against a file that only appears once the
 *  sync engine catches up (see the storeKind/use-box comments in runConfigLink). No-op
 *  for "dir" mode, which has no single payload file. */
function pullPayloadToClient(cfg: Config, profile: string, e: ResolvedEntry): void {
  if (e.mode === "dir") return;
  const host = hostFor(cfg, profile);
  const boxPayload = boxPayloadPath(profile, e);
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `cat ${shQuote(boxPayload)}`], { encoding: "utf8" });
  if (r.error || r.status !== 0) die(`could not pull ${e.label} payload from ${host}: ${(r.stderr || r.error?.message || "").trim() || "ssh failed"}`);
  const dst = clientPayload(profile, e);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, r.stdout ?? "");
}

/**
 * Mirror of pullPayloadToClient: push the client-side payload up to the box's own store
 * via ssh, so the box's own `link` (run right after this) does not point at content
 * that only appears once the sync engine catches up. No-op for "dir" mode, which has no
 * single payload file.
 *
 * Unlike pullPayloadToClient, this cannot just trust the `box` SideState computed
 * earlier in the loop: for "ssh-include" that state only reflects whether the box's
 * boxpath already carries the managed Include block, never what its store *payload*
 * actually holds — a box can read as bare (absent/empty/linked) while its own store
 * already has real, never-synced-to-this-client content (e.g. a freshly re-imaged
 * client: `devbox sync up` created `~/devbox/<profile>` but nothing has propagated yet,
 * and `link` never waits for an active sync session). `computeStoreKind` only checks
 * the *client's* local copy, which is always accurate (it's a plain local stat) — the
 * box side has no equivalent, hence `boxPayloadHasContent`, a real-time ssh probe.
 *
 * `allowOverwrite: true` (use-client): the decision to prefer the client was already
 * made deliberately, so an unexpectedly non-empty box payload is renamed aside first —
 * same no-delete discipline as everywhere else — then overwritten.
 * `allowOverwrite: false` (seed-empty): overwriting real content with a zero-byte file
 * is never the right outcome, so this refuses outright and reports instead of guessing.
 * The probe for that case runs *before* `seedEmpty` (see the caller in `runConfigLink`)
 * so the refusal fires with nothing written yet — probing only here, after the empty
 * payload already exists locally, left it sitting in the synced tree even though the
 * process died, and a re-run then saw that leftover file as `storeKind: "content"` and
 * skipped the refusal entirely (`use-client`, "linking to the existing synced copy").
 *
 * Payloads are read/written as utf8 text — correct for the shipped entries (SSH config,
 * JSON-ish settings files); a binary "file"-mode entry would need Buffer handling here.
 */
export type PushConflictAction = "write" | "rename-then-write" | "refuse";

/**
 * Pure decision for pushPayloadToBox's conflict handling, factored out so it is
 * directly testable without ssh (the ssh round-trips themselves are not unit-tested —
 * see pushPayloadToBox's doc comment for the full rationale):
 *   - no existing box content: always safe to write.
 *   - existing box content + allowOverwrite (use-client, a deliberate choice already
 *     made): rename the box's copy aside first, then write.
 *   - existing box content + !allowOverwrite (seed-empty): refuse outright rather than
 *     destroy content the planner never saw.
 */
export function resolvePushConflict(boxHasContent: boolean, allowOverwrite: boolean): PushConflictAction {
  if (!boxHasContent) return "write";
  return allowOverwrite ? "rename-then-write" : "refuse";
}

const sshRunFor = (cfg: Config, profile: string) => {
  const host = hostFor(cfg, profile);
  return { host, run: (cmd: string, input?: string) => spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], { input, encoding: "utf8" }) };
};

/** ssh-probe: does the box's own payload currently hold non-empty content? Split out of
 *  pushPayloadToBox so the "seed-empty" caller can check — and refuse — *before* it
 *  writes anything locally (see the caller for why the order matters). */
function boxPayloadHasContent(cfg: Config, profile: string, e: ResolvedEntry): boolean {
  const { host, run } = sshRunFor(cfg, profile);
  const boxPayload = boxPayloadPath(profile, e);
  const check = run(`[ -s ${shQuote(boxPayload)} ] && echo yes || echo no`);
  if (check.error || check.status !== 0) die(`could not check ${e.label}'s box payload on ${host}: ${(check.stderr || check.error?.message || "").trim() || "ssh failed"}`);
  return check.stdout.trim() === "yes";
}

const refuseBoxOverwrite = (e: ResolvedEntry, boxPayload: string): never =>
  die(
    `${e.label}: the box already has content at ${boxPayload} that was never seen locally — ` +
    `refusing to overwrite it with an empty payload. Re-run \`devbox config link\` once the box ` +
    `side has synced so the decision accounts for it.`,
  );

/**
 * Pushes the client-side payload up to the box's own store via ssh, given a
 * `boxHasContent` verdict the caller already obtained (via `boxPayloadHasContent`) —
 * the caller decides *when* to probe (see the "seed-empty" ordering note in
 * `runConfigLink`); this function only decides what to do once it knows the answer.
 */
function pushPayloadToBox(cfg: Config, profile: string, e: ResolvedEntry, opts: { allowOverwrite: boolean; boxHasContent: boolean }): void {
  if (e.mode === "dir") return;
  const { run } = sshRunFor(cfg, profile);
  const host = hostFor(cfg, profile);
  const boxPayload = boxPayloadPath(profile, e);

  switch (resolvePushConflict(opts.boxHasContent, opts.allowOverwrite)) {
    case "refuse":
      refuseBoxOverwrite(e, boxPayload); // never returns
      break; // unreachable — kept for readability
    case "rename-then-write": {
      const aside = `${boxPayload}.pre-devbox-${stamp()}`;
      const rename = run(`mv ${shQuote(boxPayload)} ${shQuote(aside)}`);
      if (rename.error || rename.status !== 0) die(`could not rename aside ${e.label}'s existing box payload on ${host}: ${(rename.stderr || rename.error?.message || "").trim() || "ssh failed"}`);
      break;
    }
    case "write":
      break;
  }

  const body = readFileSync(clientPayload(profile, e), "utf8");
  const r = run(`mkdir -p ${shQuote(dirname(boxPayload))} && cat > ${shQuote(boxPayload)}`, body);
  if (r.error || r.status !== 0) die(`could not push ${e.label} payload to ${host}: ${(r.stderr || r.error?.message || "").trim() || "ssh failed"}`);
}

/**
 * Whether the store already holds the entry's canonical copy — clientPayload, not the
 * store *directory*. For "dir" mode the two are the same path, but for "file"/
 * "ssh-include" the directory can exist (partial propagation, or an aborted earlier
 * run) while the payload file inside it is still missing. Checking the directory read
 * that as "content", so `link` would resolve `bare && bare` to "use-client" and write an
 * Include/symlink pointing at nothing — exactly what `runConfigStatus` (which already
 * used clientPayload) would then report MISSING right after `link` just "created" it.
 * Exported so this agreement with `runConfigStatus` is directly testable without ssh.
 */
export function computeStoreKind(profile: string, e: ResolvedEntry): SideState["kind"] {
  return existsSync(clientPayload(profile, e)) ? "content" : "absent";
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
    const storeKind = computeStoreKind(profile, e);
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
      case "use-box":
        // Seeds the box's own store from box content. For non-"dir" modes the client's
        // local store copy does not exist yet — it only appears once the sync engine
        // catches up, which `link` never waits for (it only requires the sync disk to
        // exist, not an active session). Pull the just-seeded payload down over ssh
        // immediately rather than leaving `linkClient` to link against nothing.
        boxSh(cfg, profile, ["seed", e.label, e.box, e.mode, boxStorePath(profile, e), payloadBasename(e), ...e.excludes]);
        pullPayloadToClient(cfg, profile, e);
        break;
      case "use-client":
        if (client.kind === "content") {
          seedFromClient(profile, e);
          // Mirror of the use-box case: the box's own store does not have this payload
          // yet either, and boxSh(["link", …]) below does not wait for sync to carry it
          // over — push it up now so the box's own link has something real to point at.
          // allowOverwrite: the client was already chosen deliberately, so an
          // unexpectedly non-empty box payload gets renamed aside, not refused.
          pushPayloadToBox(cfg, profile, e, { allowOverwrite: true, boxHasContent: e.mode === "dir" ? false : boxPayloadHasContent(cfg, profile, e) });
        }
        break;
      case "seed-empty": {
        // Probe the box BEFORE writing anything locally — see seedEmptyGuarded's doc
        // comment for why the order matters.
        const boxHasContent = e.mode === "dir" ? false : boxPayloadHasContent(cfg, profile, e);
        seedEmptyGuarded(profile, e, boxHasContent);
        pushPayloadToBox(cfg, profile, e, { allowOverwrite: false, boxHasContent });
        break;
      }
    }
    linkClient(profile, e);
    boxSh(cfg, profile, ["link", e.label, e.box, e.mode, boxStorePath(profile, e), payloadBasename(e)]);
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
      return { restored: false, reason: "store payload is missing — its host entries could not be recovered" };
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
      // A failed restore must never be followed by a ✓ line — that marker is a claim
      // that the client was left in a working state, which is exactly what did not
      // happen here (the link is still in place, nothing to show for it).
      if (r.restored) out(`  ✓ ${e.label}: restore`);
      else out(`  ! ${e.label}: ${r.reason}`);
    } else {
      out(`  ✓ ${e.label}: skip (${plan.reason})`);
    }
    boxSh(cfg, profile, ["unlink", e.label, e.box, e.mode, boxStorePath(profile, e), payloadBasename(e)]);
  }
  out(`  · the synced copies are left in ${join(syncDiskRoot(profile), ".app-configs")} — delete them by hand when you are sure`);
}

/** Create an empty store when neither side has content. For "dir" mode the target
 *  itself is the store directory, so mkdir is enough. For "file"/"ssh-include" the
 *  target is a specific file *inside* the store directory (clientPayload/payloadRelPath)
 *  — creating only the directory would leave `linkClient`'s Include/symlink pointing at
 *  a file that doesn't exist. That is not a hard error for OpenSSH — `ssh -F cfg -G host`
 *  with `Include /nonexistent` exits 0 — which is worse, not better: the shared host
 *  entries just silently vanish from that side instead of failing loudly. Creating a
 *  real (empty) file at the payload path avoids that silent loss. */
export function seedEmpty(profile: string, e: ResolvedEntry): void {
  const target = clientPayload(profile, e);
  if (e.mode === "dir") {
    mkdirSync(target, { recursive: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "");
}

/**
 * The "seed-empty" decision's write step, factored out from `runConfigLink` so the
 * ordering fix is directly unit-testable without ssh: given whether the box already has
 * content (a value the caller obtains via `boxPayloadHasContent`, before calling this),
 * either refuses outright — writing nothing — or calls `seedEmpty`.
 *
 * The order is the whole fix: probing (and possibly refusing) must happen *before*
 * `seedEmpty` runs, not after. The original shape called `seedEmpty` unconditionally and
 * only let `pushPayloadToBox` refuse afterwards — by then the 0-byte payload was already
 * sitting in the synced tree, `die()` didn't undo it, and a re-run saw that leftover file
 * as `storeKind: "content"` and resolved to "use-client" instead of re-escalating, so the
 * promised second refusal never happened.
 */
export function seedEmptyGuarded(profile: string, e: ResolvedEntry, boxHasContent: boolean): void {
  // "dir" mode has no single payload to conflict over — mirrors pushPayloadToBox's own
  // no-op for "dir". Never refuse here regardless of what the caller passes; the caller
  // in runConfigLink always probes `false` for "dir" for the same reason, but this stays
  // safe even if that discipline ever slips.
  if (e.mode !== "dir" && resolvePushConflict(boxHasContent, false) === "refuse") {
    refuseBoxOverwrite(e, boxPayloadPath(profile, e));
  }
  seedEmpty(profile, e);
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
