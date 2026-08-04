/**
 * run.ts — `devbox config`: link the configured app configs into the sync disk.
 *
 * Client-side filesystem work happens here; box-side work goes through the installed
 * `remote-app-configs` helper so the two sides never drift. Honors DEVBOX_DRYRUN=1.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appConfigsFor, die, hostFor, shQuote, syncDiskEnabled, type Config } from "../config";
import { normalizePath, syncDiskRoot } from "../bridge";
import { planAppConfigLink, type SideState } from "./plan";
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

/** Run the installed `remote-app-configs` helper on the box. Dies on unreachable/failed
 *  ssh rather than letting a transport failure masquerade as "box is empty" — that
 *  misread could talk the planner into overwriting a box side we never actually saw. */
const boxSh = (cfg: Config, profile: string, args: string[]): string => {
  const host = hostFor(cfg, profile);
  const cmd = ["remote-app-configs", ...args].map(shQuote).join(" ");
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    die(`remote-app-configs ${args[0]} failed on ${host}: ${(r.stderr || r.error?.message || "").trim() || "ssh failed"}`);
  }
  return (r.stdout ?? "").trim();
};

export function inspectBox(cfg: Config, profile: string, e: ResolvedEntry): SideState {
  const raw = boxSh(cfg, profile, ["inspect", e.label, e.box, e.mode, boxStorePath(profile, e)]);
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
    const box = inspectBox(cfg, profile, e);
    const storeKind: SideState["kind"] = existsSync(join(disk, storeRelPath(e))) ? "content" : "absent";
    const plan = planAppConfigLink(e, client, box, storeKind);

    let decision = plan.decision;
    if (decision === "ask") {
      if (opts.fromClient) decision = "use-client";
      else {
        out(`  ? ${plan.reason}`);
        const answer = (prompt(`    which wins? [client/box/skip]`) ?? "skip").trim().toLowerCase();
        decision = answer.startsWith("c") ? "use-client" : answer.startsWith("b") ? "use-box" : "refuse";
      }
    }
    if (isDry()) { out(`  ── ${e.label}: ${decision} (${plan.reason})`); continue; }

    switch (decision) {
      case "already-linked": out(`  ✓ ${e.label} already linked`); continue;
      case "refuse": out(`  ! ${plan.reason}`); continue;
      case "use-box": boxSh(cfg, profile, ["seed", e.label, e.box, e.mode, boxStorePath(profile, e), ...e.excludes]); break;
      case "use-client": if (client.kind === "content") seedFromClient(profile, e); break;
      case "seed-empty": mkdirSync(join(disk, storeRelPath(e)), { recursive: true }); break;
    }
    linkClient(profile, e);
    boxSh(cfg, profile, ["link", e.label, e.box, e.mode, boxStorePath(profile, e)]);
    out(`  ✓ ${e.label} linked (${decision})`);
  }
}

/** Stubs so the CLI wiring typechecks — Tasks 9 and 10 implement these. */
export const runConfigStatus = async (_cfg: Config, _profile: string): Promise<void> => {};
export const runConfigUnlink = async (_cfg: Config, _profile: string, _label?: string): Promise<void> => {};

function seedFromClient(profile: string, e: ResolvedEntry): void {
  const src = normalizePath(e.client);
  const dst = clientPayload(profile, e);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, filter: (p) => !e.excludes.some((x) => matches(p, x)) });
  renameSync(src, `${src}.pre-devbox-${stamp()}`);
}

const matches = (p: string, pattern: string): boolean => {
  const name = p.split("/").pop() ?? "";
  return pattern.includes("*") ? new RegExp("^" + pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(name) : name === pattern;
};

function linkClient(profile: string, e: ResolvedEntry): void {
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
  if (st) { if (st.isSymbolicLink()) rmSync(p); else renameSync(p, `${p}.pre-devbox-${stamp()}`); }
  mkdirSync(dirname(p), { recursive: true });
  // "dir" mode needs the target itself to exist as a directory (the app reads inside
  // it); "file" mode must only ensure the target's *parent* exists — mkdir'ing the
  // target here would plant a directory where the app expects a plain file.
  mkdirSync(e.mode === "dir" ? target : dirname(target), { recursive: true });
  symlinkSync(target, p);
}
