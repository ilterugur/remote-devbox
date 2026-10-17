#!/usr/bin/env python3
"""After devbox account use: pin omp's Anthropic OAuth to the parked label's email + org.

Only flips disabled_cause; never writes credential data. omp owns its tokens: a row
exists only because `omp login anthropic` (or /login anthropic) put it there, keyed by
the org the token was actually issued for. Copying Claude Code's vault token in was
wrong twice over: the vault's identity.json can name one org while its token belongs
to another (same-email personal Max + Team), and a refresh token held by two clients
dies on the first rotation.
"""
import json
import os
import sqlite3
import sys


def email_of(key):
    if not key:
        return None
    key = key.lower()
    for part in key.split("|"):
        if part.startswith("email:"):
            return part[6:]
    return None


def org_of(key):
    if not key:
        return None
    key = key.lower()
    for part in key.split("|"):
        if part.startswith("org:"):
            return part[4:]
    return None


def omp_db_paths(home=None):
    """Match clients/devbox/src/omp-pin.ts ompDbPaths: PI_CODING_AGENT_DIR + omp-*/agent.db."""
    home = home or os.path.expanduser("~")
    seen = set()
    out = []

    def add(path):
        if path in seen or not os.path.isfile(path):
            return
        seen.add(path)
        out.append(path)

    extra = os.environ.get("PI_CODING_AGENT_DIR")
    if extra:
        add(os.path.join(extra, "agent.db"))
    profiles = os.path.join(home, ".agent-profiles")
    if os.path.isdir(profiles):
        for name in sorted(os.listdir(profiles)):
            if name.startswith("omp-"):
                add(os.path.join(profiles, name, "agent.db"))
    return out


def pin_label(label, vault):
    ident_path = os.path.join(vault, label, "identity.json")
    try:
        ident = json.load(open(ident_path))
    except OSError:
        print("omp: parked identity has no email — skip pin", file=sys.stderr)
        return
    acct = ident.get("oauthAccount") or {}
    email = (acct.get("emailAddress") or "").strip().lower()
    org_uuid = (acct.get("organizationUuid") or "").strip().lower()
    if not email:
        print("omp: parked identity has no email — skip pin", file=sys.stderr)
        return

    cause = "devbox-account: pinned away from " + email
    paths = omp_db_paths()
    if not paths:
        return

    for path in paths:
        con = sqlite3.connect(path)
        try:
            con.execute("PRAGMA busy_timeout = 3000")
            if not con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_credentials'"
            ).fetchone():
                continue
            rows = list(
                con.execute(
                    "SELECT id, identity_key, disabled_cause, data FROM auth_credentials "
                    "WHERE provider='anthropic' AND credential_type='oauth' ORDER BY id"
                )
            )
            if not rows:
                print(
                    "omp: no Anthropic OAuth in this profile — run `omp login anthropic`, then use again",
                    file=sys.stderr,
                )
                continue
            emails = []
            seen = set()
            for _id, key, _d, _data in rows:
                e = email_of(key)
                if e and e not in seen:
                    seen.add(e)
                    emails.append(e)
            matches = [r for r in rows if email_of(r[1]) == email]
            if org_uuid:
                by_org = [r for r in matches if org_of(r[1]) == org_uuid]
                if by_org:
                    matches = by_org
                elif matches:
                    have = ", ".join(emails)
                    extra = (" (have %s)" % have) if have else ""
                    print(
                        "omp: no Anthropic OAuth for that email (org %s)%s — run `omp login anthropic`, "
                        "pick that org on the consent screen, then use again" % (org_uuid, extra),
                        file=sys.stderr,
                    )
                    continue
            match_ids = {r[0] for r in matches}
            others = [r for r in rows if r[0] not in match_ids]
            if not matches:
                have = ", ".join(emails)
                extra = (" (have %s)" % have) if have else ""
                print(
                    "omp: no Anthropic OAuth for that email%s — run `omp login anthropic`, then use again" % extra,
                    file=sys.stderr,
                )
                continue
            already = all(r[2] is None for r in matches) and all(r[2] is not None for r in others)
            if already:
                print("omp: anthropic already pinned to %s" % email, file=sys.stderr)
                continue
            before = {r[0]: r[3] for r in rows}
            con.execute("BEGIN")
            for r in matches:
                con.execute(
                    "UPDATE auth_credentials SET disabled_cause = NULL, "
                    "updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?",
                    (r[0],),
                )
            for r in others:
                con.execute(
                    "UPDATE auth_credentials SET disabled_cause = ?, "
                    "updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?",
                    (cause, r[0]),
                )
            if con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_change_revision'"
            ).fetchone():
                con.execute("UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1")
            con.execute("COMMIT")
            after = list(
                con.execute(
                    "SELECT id, data FROM auth_credentials "
                    "WHERE provider='anthropic' AND credential_type='oauth'"
                )
            )
            for _id, data in after:
                if before.get(_id) != data:
                    raise SystemExit("omp-pin mutated credential data — aborting")
            parked = len(others)
            extra = " (parked %d)" % parked if parked else ""
            print("omp: pinned anthropic to %s%s" % (email, extra), file=sys.stderr)
        finally:
            con.close()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: omp-pin-after-use.py <vault-label>", file=sys.stderr)
        return 2
    label = sys.argv[1]
    vault = os.environ.get("DEVBOX_ACCOUNT_VAULT") or os.path.expanduser("~/.claude-accounts")
    pin_label(label, vault)
    return 0


if __name__ == "__main__":
    sys.exit(main())
