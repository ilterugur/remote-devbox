/**
 * After `devbox account use`, pin omp's Anthropic OAuth to the parked Claude label's
 * email + orgUuid. Only flips disabled_cause; omp's rows come from `omp login anthropic`.
 * Set DEVBOX_ACCOUNT_OMP_PIN=0 to skip.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import ompPinScript from "../../../scripts/omp-pin-after-use.py" with { type: "text" };

export const OMP_PIN_CAUSE_PREFIX = "devbox-account: pinned away from ";

export type OmpPinResult =
  | { kind: "missing-db" }
  | { kind: "no-table" }
  | { kind: "no-oauth" }
  | { kind: "no-match"; emails: string[]; orgUuid?: string }
  | { kind: "already"; email: string; orgUuid?: string }
  | { kind: "pinned"; email: string; enabled: number; disabled: number; orgUuid?: string };

type OAuthRow = { id: number; identity_key: string | null; disabled_cause: string | null; data: string };

export function emailFromIdentityKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = key.match(/(?:^|\|)email:([^|]+)/i);
  const email = m?.[1]?.trim().toLowerCase();
  return email || null;
}

export function orgFromIdentityKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = key.match(/(?:^|\|)org:([^|]+)/i);
  const org = m?.[1]?.trim().toLowerCase();
  return org || null;
}

type ParkedClaudeIdentity = {
  oauthAccount?: { emailAddress?: string; organizationUuid?: string };
};

function readParkedIdentity(label: string, vault?: string): ParkedClaudeIdentity | null {
  const root = vault && vault.length > 0 ? vault : join(homedir(), ".claude-accounts");
  const path = join(root, label, "identity.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ParkedClaudeIdentity;
  } catch {
    return null;
  }
}

export function parkedAccountEmail(label: string, vault = process.env.DEVBOX_ACCOUNT_VAULT): string | null {
  const identity = readParkedIdentity(label, vault);
  const email = identity?.oauthAccount?.emailAddress?.trim().toLowerCase();
  return email || null;
}

export function parkedAccountOrgUuid(label: string, vault = process.env.DEVBOX_ACCOUNT_VAULT): string | null {
  const identity = readParkedIdentity(label, vault);
  const org = identity?.oauthAccount?.organizationUuid?.trim().toLowerCase();
  return org || null;
}

export function ompDbPaths(home = homedir()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!existsSync(p) || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const extra = process.env.PI_CODING_AGENT_DIR;
  if (extra) add(join(extra, "agent.db"));
  const profiles = join(home, ".agent-profiles");
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles).sort()) {
      if (!name.startsWith("omp-")) continue;
      add(join(profiles, name, "agent.db"));
    }
  }
  return out;
}

function pinCause(email: string): string {
  return `${OMP_PIN_CAUSE_PREFIX}${email}`;
}

export function pinOmpAnthropic(dbPath: string, email: string, orgUuid?: string | null): OmpPinResult {
  const want = email.trim().toLowerCase();
  const wantOrg = orgUuid?.trim().toLowerCase() || null;
  if (!want) return { kind: "no-match", emails: [] };
  if (!existsSync(dbPath)) return { kind: "missing-db" };

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const hasTable = db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='auth_credentials'")
      .get() as { ok: number } | null;
    if (!hasTable) return { kind: "no-table" };

    const rows = db
      .query(
        `SELECT id, identity_key, disabled_cause, data
         FROM auth_credentials
         WHERE provider = 'anthropic' AND credential_type = 'oauth'
         ORDER BY id ASC`,
      )
      .all() as OAuthRow[];
    if (rows.length === 0) return { kind: "no-oauth" };

    const emails = [
      ...new Set(rows.map((r) => emailFromIdentityKey(r.identity_key)).filter((e): e is string => Boolean(e))),
    ];
    let matches = rows.filter((r) => emailFromIdentityKey(r.identity_key) === want);
    if (matches.length === 0) return { kind: "no-match", emails, orgUuid: wantOrg ?? undefined };
    if (wantOrg) {
      const byOrg = matches.filter((r) => orgFromIdentityKey(r.identity_key) === wantOrg);
      if (byOrg.length > 0) matches = byOrg;
      else return { kind: "no-match", emails, orgUuid: wantOrg };
    }

    const matchIds = new Set(matches.map((r) => r.id));
    const others = rows.filter((r) => !matchIds.has(r.id));
    const matchAlreadyOn = matches.every((r) => r.disabled_cause == null);
    const othersAlreadyOff = others.every((r) => r.disabled_cause != null);
    if (matchAlreadyOn && othersAlreadyOff) return { kind: "already", email: want, orgUuid: wantOrg ?? undefined };

    const cause = pinCause(want);
    const before = new Map(rows.map((r) => [r.id, r.data]));
    db.transaction(() => {
      for (const row of matches) {
        db.run("UPDATE auth_credentials SET disabled_cause = NULL, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?", [
          row.id,
        ]);
      }
      for (const row of others) {
        db.run(
          "UPDATE auth_credentials SET disabled_cause = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?",
          [cause, row.id],
        );
      }
      const hasRev = db
        .query("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='auth_change_revision'")
        .get() as { ok: number } | null;
      if (hasRev) {
        db.run("UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1");
      }
    })();

    const after = db
      .query("SELECT id, data FROM auth_credentials WHERE provider = 'anthropic' AND credential_type = 'oauth'")
      .all() as Array<{ id: number; data: string }>;
    for (const row of after) {
      if (before.get(row.id) !== row.data) {
        throw new Error("omp-pin mutated credential data — aborting");
      }
    }

    return {
      kind: "pinned",
      email: want,
      enabled: matches.length,
      disabled: others.length,
      orgUuid: wantOrg ?? undefined,
    };
  } finally {
    db.close();
  }
}

export function describeOmpPin(result: OmpPinResult): string | null {
  switch (result.kind) {
    case "missing-db":
    case "no-table":
      return null;
    case "no-oauth":
      return "omp: no Anthropic OAuth in this profile — /login anthropic inside omp, then use again";
    case "no-match":
      return (
        `omp: no Anthropic OAuth for that email` +
        (result.orgUuid ? ` (org ${result.orgUuid})` : "") +
        (result.emails.length ? ` (have ${result.emails.join(", ")})` : "") +
        " — /login anthropic inside omp, then use again"
      );
    case "already":
      return `omp: anthropic already pinned to ${result.email}`;
    case "pinned":
      return `omp: pinned anthropic to ${result.email}` + (result.disabled ? ` (parked ${result.disabled})` : "");
  }
}

const OMP_PIN_DIGEST = createHash("sha256").update(ompPinScript).digest("hex").slice(0, 16);
const BOX_OMP_PIN = "/usr/local/share/remote-devbox/omp-pin-after-use.py";

export function ompPinScriptPath(): string {
  const path = join(tmpdir(), `omp-pin-after-use-${OMP_PIN_DIGEST}.py`);
  try {
    const st = lstatSync(path);
    if (st.isFile() && st.size === Buffer.byteLength(ompPinScript)) return path;
  } catch {
    // not materialised yet
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, ompPinScript, { mode: 0o700 });
  renameSync(tmp, path);
  return path;
}

/** Local `use`: pin omp-* to the label's org. Failures print; they do not fail the swap. */
export function pinOmpAfterUse(label: string): void {
  if (process.env.DEVBOX_ACCOUNT_OMP_PIN === "0") return;
  const r = spawnSync("python3", [ompPinScriptPath(), label], { stdio: "inherit", env: process.env });
  if (r.error) console.error(`omp: could not pin: ${r.error.message}`);
}

/** Box `use -p`: same pin script installed under /usr/local/share/remote-devbox. */
export function pinOmpAfterRemoteUse(host: string, label: string): void {
  if (process.env.DEVBOX_ACCOUNT_OMP_PIN === "0") return;
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, "python3", BOX_OMP_PIN, label], {
    encoding: "utf8",
  });
  if (r.error) {
    console.error(`omp: could not pin on ${host}: ${r.error.message}`);
    return;
  }
  const err = (r.stderr ?? "").trim();
  const out = (r.stdout ?? "").trim();
  if (err) console.error(err);
  if (out) console.error(out);
  if (r.status !== 0 && !err && !out) {
    console.error(`omp: could not pin on ${host} (exit ${r.status ?? "?"})`);
  }
}
