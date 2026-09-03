/**
 * After a local Claude Code `use`, pin omp to the same Anthropic *identity*.
 *
 * This never copies a Claude Code OAuth token into omp (Anthropic forbids driving a
 * subscription token from another tool). It only flips `disabled_cause` on rows omp
 * already holds from its own `/login anthropic`, so round-robin cannot pick a
 * different email than the one you just named.
 *
 * Set DEVBOX_ACCOUNT_OMP_PIN=0 to skip.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OMP_PIN_CAUSE_PREFIX = "devbox-account: pinned away from ";

export type OmpPinResult =
  | { kind: "missing-db" }
  | { kind: "no-table" }
  | { kind: "no-oauth" }
  | { kind: "no-match"; emails: string[] }
  | { kind: "already"; email: string }
  | { kind: "pinned"; email: string; enabled: number; disabled: number };

type OAuthRow = { id: number; identity_key: string | null; disabled_cause: string | null; data: string };

export function emailFromIdentityKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = key.match(/(?:^|\|)email:([^|]+)/i);
  const email = m?.[1]?.trim().toLowerCase();
  return email || null;
}

export function parkedAccountEmail(label: string, vault = process.env.DEVBOX_ACCOUNT_VAULT): string | null {
  const root = vault && vault.length > 0 ? vault : join(homedir(), ".claude-accounts");
  const path = join(root, label, "identity.json");
  if (!existsSync(path)) return null;
  try {
    const identity = JSON.parse(readFileSync(path, "utf8")) as {
      oauthAccount?: { emailAddress?: string };
    };
    const email = identity.oauthAccount?.emailAddress?.trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
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

export function pinOmpAnthropic(dbPath: string, email: string): OmpPinResult {
  const want = email.trim().toLowerCase();
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
    const matches = rows.filter((r) => emailFromIdentityKey(r.identity_key) === want);
    if (matches.length === 0) return { kind: "no-match", emails };

    const others = rows.filter((r) => emailFromIdentityKey(r.identity_key) !== want);
    const matchAlreadyOn = matches.every((r) => r.disabled_cause == null);
    const othersAlreadyOff = others.every((r) => r.disabled_cause != null);
    if (matchAlreadyOn && othersAlreadyOff) return { kind: "already", email: want };

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

    return { kind: "pinned", email: want, enabled: matches.length, disabled: others.length };
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
        (result.emails.length ? ` (have ${result.emails.join(", ")})` : "") +
        " — /login anthropic inside omp, then use again"
      );
    case "already":
      return `omp: anthropic already pinned to ${result.email}`;
    case "pinned":
      return `omp: pinned anthropic to ${result.email}` + (result.disabled ? ` (parked ${result.disabled})` : "");
  }
}

/** Local `use` only. Never copies tokens. Failures print; they do not fail the swap. */
export function pinOmpAfterUse(label: string): void {
  if (process.env.DEVBOX_ACCOUNT_OMP_PIN === "0") return;
  const email = parkedAccountEmail(label);
  if (!email) {
    console.error("omp: parked identity has no email — skip pin");
    return;
  }
  const dbs = ompDbPaths();
  if (dbs.length === 0) return;
  for (const db of dbs) {
    try {
      const line = describeOmpPin(pinOmpAnthropic(db, email));
      if (line) console.error(line);
    } catch (err) {
      console.error(`omp: could not pin ${db}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Same pin, on the box, after `devbox account use -p`. Reads the parked identity
 * from the developer's vault there and only flips `disabled_cause` in omp-* agent.db.
 * stdin is the python below so we never interpolate the label into a remote shell.
 */
const REMOTE_PIN_PY = String.raw`
import glob, json, os, sqlite3, sys

label = sys.argv[1]
vault = os.environ.get("DEVBOX_ACCOUNT_VAULT") or os.path.expanduser("~/.claude-accounts")
ident_path = os.path.join(vault, label, "identity.json")
try:
    ident = json.load(open(ident_path))
except Exception:
    print("omp: parked identity has no email — skip pin", file=sys.stderr)
    sys.exit(0)
email = ((ident.get("oauthAccount") or {}).get("emailAddress") or "").strip().lower()
if not email:
    print("omp: parked identity has no email — skip pin", file=sys.stderr)
    sys.exit(0)

def email_of(key):
    if not key:
        return None
    key = key.lower()
    for part in key.split("|"):
        if part.startswith("email:"):
            return part[6:]
    return None

cause = "devbox-account: pinned away from " + email
paths = sorted(glob.glob(os.path.expanduser("~/.agent-profiles/omp-*/agent.db")))
if not paths:
    sys.exit(0)

for path in paths:
    con = sqlite3.connect(path)
    try:
        con.execute("PRAGMA busy_timeout = 3000")
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_credentials'").fetchone():
            continue
        rows = list(con.execute(
            "SELECT id, identity_key, disabled_cause, data FROM auth_credentials "
            "WHERE provider='anthropic' AND credential_type='oauth' ORDER BY id"
        ))
        if not rows:
            print("omp: no Anthropic OAuth in this profile — /login anthropic inside omp, then use again", file=sys.stderr)
            continue
        emails = []
        seen = set()
        for _id, key, _d, _data in rows:
            e = email_of(key)
            if e and e not in seen:
                seen.add(e)
                emails.append(e)
        matches = [r for r in rows if email_of(r[1]) == email]
        others = [r for r in rows if email_of(r[1]) != email]
        if not matches:
            have = ", ".join(emails)
            extra = (" (have %s)" % have) if have else ""
            print("omp: no Anthropic OAuth for that email%s — /login anthropic inside omp, then use again" % extra, file=sys.stderr)
            continue
        already = all(r[2] is None for r in matches) and all(r[2] is not None for r in others)
        if already:
            print("omp: anthropic already pinned to %s" % email, file=sys.stderr)
            continue
        before = {r[0]: r[3] for r in rows}
        con.execute("BEGIN")
        for r in matches:
            con.execute("UPDATE auth_credentials SET disabled_cause = NULL, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?", (r[0],))
        for r in others:
            con.execute("UPDATE auth_credentials SET disabled_cause = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?", (cause, r[0]))
        if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_change_revision'").fetchone():
            con.execute("UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1")
        con.execute("COMMIT")
        after = list(con.execute("SELECT id, data FROM auth_credentials WHERE provider='anthropic' AND credential_type='oauth'"))
        for _id, data in after:
            if before.get(_id) != data:
                raise SystemExit("omp-pin mutated credential data — aborting")
        parked = len(others)
        extra = " (parked %d)" % parked if parked else ""
        print("omp: pinned anthropic to %s%s" % (email, extra), file=sys.stderr)
    finally:
        con.close()
`

export function pinOmpAfterRemoteUse(host: string, label: string): void {
  if (process.env.DEVBOX_ACCOUNT_OMP_PIN === "0") return;
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, "python3", "-", label], {
    input: REMOTE_PIN_PY,
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
