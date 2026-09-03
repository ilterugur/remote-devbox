import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emailFromIdentityKey,
  ompDbPaths,
  parkedAccountEmail,
  pinOmpAnthropic,
} from "./omp-pin";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-pin-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(path: string, rows: Array<{ id: number; email: string; disabled?: string | null; data?: string }>) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
    INSERT INTO auth_change_revision (id, revision) VALUES (1, 10);
  `);
  const ins = db.query(
    `INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key)
     VALUES (?, 'anthropic', 'oauth', ?, ?, ?)`,
  );
  for (const row of rows) {
    ins.run(row.id, row.data ?? `token-${row.id}`, row.disabled ?? null, `email:${row.email}|org:org-${row.id}`);
  }
  db.run(
    `INSERT INTO auth_credentials (id, provider, credential_type, data, identity_key)
     VALUES (99, 'openai-codex', 'oauth', 'codex-secret', 'email:other@x.com|org:x')`,
  );
  db.close();
}

function snapshot(path: string) {
  const db = new Database(path, { readonly: true });
  const creds = db
    .query(
      `SELECT id, provider, credential_type, data, disabled_cause, identity_key
       FROM auth_credentials ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    provider: string;
    credential_type: string;
    data: string;
    disabled_cause: string | null;
    identity_key: string | null;
  }>;
  const rev = (db.query("SELECT revision FROM auth_change_revision WHERE id = 1").get() as { revision: number }).revision;
  db.close();
  return { creds, rev };
}

describe("emailFromIdentityKey", () => {
  test("reads the email= segment", () => {
    expect(emailFromIdentityKey("email:a@x.com|org:abc")).toBe("a@x.com");
    expect(emailFromIdentityKey("EMAIL:A@X.COM|org:abc")).toBe("a@x.com");
    expect(emailFromIdentityKey(null)).toBe(null);
  });
});

describe("parkedAccountEmail", () => {
  test("reads oauthAccount.emailAddress from the vault identity", () => {
    const vault = join(scratch(), "vault");
    mkdirSync(join(vault, "sipahi"), { recursive: true });
    writeFileSync(
      join(vault, "sipahi", "identity.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "sipahi@vertiplatform.com" } }),
    );
    expect(parkedAccountEmail("sipahi", vault)).toBe("sipahi@vertiplatform.com");
    expect(parkedAccountEmail("missing", vault)).toBe(null);
  });
});

describe("ompDbPaths", () => {
  test("finds omp-* agent.db under a home, plus PI_CODING_AGENT_DIR", () => {
    const home = scratch();
    mkdirSync(join(home, ".agent-profiles", "omp-main"), { recursive: true });
    mkdirSync(join(home, ".agent-profiles", "claude-main"), { recursive: true });
    writeFileSync(join(home, ".agent-profiles", "omp-main", "agent.db"), "");
    writeFileSync(join(home, ".agent-profiles", "claude-main", "agent.db"), "");
    const extra = join(scratch(), "extra");
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, "agent.db"), "");
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = extra;
    try {
      expect(ompDbPaths(home)).toEqual([join(extra, "agent.db"), join(home, ".agent-profiles", "omp-main", "agent.db")]);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});

describe("pinOmpAnthropic", () => {
  test("enables the matching email, disables the others, never touches data", () => {
    const path = join(scratch(), "agent.db");
    makeDb(path, [
      { id: 1, email: "ugur@vertiplatform.com", data: "ugur-token" },
      { id: 2, email: "sipahi@vertiplatform.com", disabled: "stale", data: "sipahi-token" },
    ]);
    const result = pinOmpAnthropic(path, "Sipahi@VertiPlatform.com");
    expect(result).toEqual({ kind: "pinned", email: "sipahi@vertiplatform.com", enabled: 1, disabled: 1 });
    const snap = snapshot(path);
    expect(snap.rev).toBe(11);
    const ugur = snap.creds.find((r) => r.id === 1)!;
    const sipahi = snap.creds.find((r) => r.id === 2)!;
    const codex = snap.creds.find((r) => r.id === 99)!;
    expect(ugur.data).toBe("ugur-token");
    expect(sipahi.data).toBe("sipahi-token");
    expect(codex.data).toBe("codex-secret");
    expect(codex.disabled_cause).toBe(null);
    expect(sipahi.disabled_cause).toBe(null);
    expect(ugur.disabled_cause).toBe("devbox-account: pinned away from sipahi@vertiplatform.com");
  });

  test("is a no-op when already pinned, without bumping revision", () => {
    const path = join(scratch(), "agent.db");
    makeDb(path, [
      { id: 1, email: "ugur@x.com", disabled: "devbox-account: pinned away from sipahi@x.com" },
      { id: 2, email: "sipahi@x.com" },
    ]);
    expect(pinOmpAnthropic(path, "sipahi@x.com")).toEqual({ kind: "already", email: "sipahi@x.com" });
    expect(snapshot(path).rev).toBe(10);
  });

  test("does not mutate when the email is not in omp", () => {
    const path = join(scratch(), "agent.db");
    makeDb(path, [{ id: 1, email: "ugur@x.com", data: "keep-me" }]);
    expect(pinOmpAnthropic(path, "sipahi@x.com")).toEqual({ kind: "no-match", emails: ["ugur@x.com"] });
    const snap = snapshot(path);
    expect(snap.rev).toBe(10);
    expect(snap.creds.find((r) => r.id === 1)!.data).toBe("keep-me");
    expect(snap.creds.find((r) => r.id === 1)!.disabled_cause).toBe(null);
  });
});
