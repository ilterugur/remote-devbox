#!/usr/bin/env bash
# Managed by remote-devbox. Behaviour test for scripts/devbox-account.sh.
#
#   bash scripts/test_devbox_account.sh
#
# Runs entirely against a synthetic HOME with DEVBOX_ACCOUNT_STORE=file, so it exercises
# the box's real code path and still runs on a macOS client (where a test may not touch
# the operator's login keychain).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$HERE/devbox-account.sh"
[ -x "$ENGINE" ] || { echo "missing $ENGINE"; exit 1; }

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check() { # check <name> <expected> <actual>
  [ "$2" = "$3" ] && ok "$1" || no "$1" "expected [$2] got [$3]"
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home"
export CLAUDE_CONFIG_DIR="$HOME/.agent-profiles/claude-main"
export DEVBOX_ACCOUNT_VAULT="$HOME/.claude-accounts"
export DEVBOX_ACCOUNT_STORE=file
export DEVBOX_ACCOUNT_PGREP=false # "no claude running"
mkdir -p "$CLAUDE_CONFIG_DIR"

STATE="$CLAUDE_CONFIG_DIR/.claude.json"
CRED="$CLAUDE_CONFIG_DIR/.credentials.json"
VAULT="$DEVBOX_ACCOUNT_VAULT"

# A tree with the shared, NON-account state we must never disturb, plus one account.
login() { # login <userID> <email> <uuid> <token> [extra-key-json]
  python3 - "$STATE" "$1" "$2" "$3" "${5:-null}" <<'PY'
import json, sys
path, uid, email, uuid, extra = sys.argv[1:6]
try:
    with open(path) as fh:
        d = json.load(fh)
except FileNotFoundError:
    d = {}
d.update({
    "userID": uid,
    "oauthAccount": {"accountUuid": uuid, "emailAddress": email, "organizationName": "Org " + uid},
    "modelAccessCache": {"cachedFor": uid},
})
d.setdefault("mcpServers", {"shared-mcp": {"command": "x"}})
d.setdefault("projects", {"/work": {"hasTrustDialogAccepted": True}})
if extra != "null":
    d.update(json.loads(extra))
else:
    d.pop("s1mAccessCache", None)
with open(path, "w") as fh:
    json.dump(d, fh, indent=2)
PY
  printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"r-%s","expiresAt":9999999999999}}\n' "$4" "$4" >"$CRED"
  chmod 600 "$CRED"
}

jq_get() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));
k=sys.argv[2].split(".")
for part in k:
    d = d.get(part) if isinstance(d, dict) else None
print("" if d is None else d)' "$1" "$2"; }

echo "== add: adopt what is logged in"
login u-a a@example.com uuid-a tok-a '{"s1mAccessCache":{"for":"a"}}'
out="$("$ENGINE" add work 2>&1)"; rc=$?
check "add exits 0" 0 "$rc"
check "identity parked" "u-a" "$(jq_get "$VAULT/work/identity.json" userID)"
check "credential parked" "tok-a" "$(jq_get "$VAULT/work/credentials.json" claudeAiOauth.accessToken)"
check "registry active" "work" "$(jq_get "$VAULT/accounts.json" active)"
check "registry email" "a@example.com" "$(jq_get "$VAULT/accounts.json" accounts.work.email)"
[ "$(stat -f %Lp "$VAULT/work/credentials.json" 2>/dev/null || stat -c %a "$VAULT/work/credentials.json")" = 600 ] \
  && ok "parked credential is 0600" || no "parked credential is 0600"
case "$out" in *work*) ok "add echoes the listing" ;; *) no "add echoes the listing" "$out" ;; esac

echo "== add: the second account (a real /login happened in between)"
login u-b b@example.com uuid-b tok-b
"$ENGINE" add personal >/dev/null 2>&1
check "second identity parked" "u-b" "$(jq_get "$VAULT/personal/identity.json" userID)"
check "active moved" "personal" "$(jq_get "$VAULT/accounts.json" active)"

echo "== use: swap back restores identity AND credential"
"$ENGINE" use work >/dev/null 2>&1
check "tree userID" "u-a" "$(jq_get "$STATE" userID)"
check "tree email" "a@example.com" "$(jq_get "$STATE" oauthAccount.emailAddress)"
check "tree credential" "tok-a" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
check "registry active" "work" "$(jq_get "$VAULT/accounts.json" active)"
check "shared mcp untouched" "x" "$(jq_get "$STATE" mcpServers.shared-mcp.command)"
check "shared projects untouched" "True" "$(jq_get "$STATE" projects./work.hasTrustDialogAccepted)"
check "entitlement cache follows the account" "u-a" "$(jq_get "$STATE" modelAccessCache.cachedFor)"
check "key present in target is restored" "a" "$(jq_get "$STATE" s1mAccessCache.for)"

echo "== use: and forward again"
"$ENGINE" use personal >/dev/null 2>&1
check "tree userID" "u-b" "$(jq_get "$STATE" userID)"
check "tree credential" "tok-b" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
check "key absent in target is deleted" "" "$(jq_get "$STATE" s1mAccessCache.for)"
check "parked work credential survived" "tok-a" "$(jq_get "$VAULT/work/credentials.json" claudeAiOauth.accessToken)"

echo "== ls / status"
out="$("$ENGINE" ls)"
case "$out" in *"* personal"*) ok "ls marks the active account" ;; *) no "ls marks the active account" "$out" ;; esac
out="$("$ENGINE" status --json)"
check "status json active" "personal" "$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"])')"
check "status json store" "file" "$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["store"])')"

echo "== guard: claude running blocks the swap"
before="$(cat "$STATE")"
DEVBOX_ACCOUNT_PGREP=true "$ENGINE" use work >/dev/null 2>&1; rc=$?
check "refused" 1 "$rc"
check "tree untouched" "$before" "$(cat "$STATE")"
DEVBOX_ACCOUNT_PGREP=true "$ENGINE" use work --force >/dev/null 2>&1
check "--force overrides" "u-a" "$(jq_get "$STATE" userID)"
"$ENGINE" use personal >/dev/null 2>&1

echo "== guard: no-op use while claude is running is allowed"
DEVBOX_ACCOUNT_PGREP=true "$ENGINE" use personal >/dev/null 2>&1; rc=$?
check "no-op allowed" 0 "$rc"

echo "== guard: unknown label changes nothing"
before="$(cat "$STATE")"
"$ENGINE" use nope >/dev/null 2>&1; rc=$?
check "refused" 1 "$rc"
check "tree untouched" "$before" "$(cat "$STATE")"

echo "== guard: an untracked login is never overwritten"
mv "$VAULT/accounts.json" "$VAULT/accounts.json.keep"
python3 - "$VAULT/accounts.json.keep" "$VAULT/accounts.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
reg["active"] = None
json.dump(reg, open(sys.argv[2], "w"), indent=2)
PY
err="$("$ENGINE" use work 2>&1)"; rc=$?
check "refused" 1 "$rc"
case "$err" in *"not tracked"*) ok "explains how to adopt it" ;; *) no "explains how to adopt it" "$err" ;; esac
mv "$VAULT/accounts.json.keep" "$VAULT/accounts.json"

echo "== rm: refuses the active account, forgets an inactive one"
"$ENGINE" use personal >/dev/null 2>&1
"$ENGINE" rm personal >/dev/null 2>&1; rc=$?
check "active is protected" 1 "$rc"
"$ENGINE" rm work >/dev/null 2>&1
check "forgotten" "" "$(jq_get "$VAULT/accounts.json" accounts.work.email)"
[ -d "$VAULT/work" ] && no "vault dir removed" || ok "vault dir removed"
login u-a a@example.com uuid-a tok-a
"$ENGINE" add work >/dev/null 2>&1

echo "== backups: only the parked triple, newest 3 kept"
for i in 1 2 3 4 5 6; do
  target=work; [ $((i % 2)) -eq 0 ] && target=personal
  "$ENGINE" use "$target" >/dev/null 2>&1
  sleep 1.05
done
n="$(ls -1 "$VAULT/.backups" | wc -l | tr -d ' ')"
check "retention" 3 "$n"
files="$(find "$VAULT/.backups" -type f | sed 's#.*/##' | sort -u | tr '\n' ' ')"
check "snapshot contents" "credentials.json identity.json " "$files"
bytes="$(find "$VAULT/.backups" -type f -exec cat {} + | wc -c | tr -d ' ')"
[ "$bytes" -lt 20000 ] && ok "snapshots stay in the kilobytes ($bytes B)" || no "snapshots stay small" "$bytes B"
DEVBOX_ACCOUNT_BACKUP_KEEP=1 "$ENGINE" gc >/dev/null 2>&1
check "gc honours --keep" 1 "$(ls -1 "$VAULT/.backups" | wc -l | tr -d ' ')"
"$ENGINE" gc --keep 0 >/dev/null 2>&1
check "gc --keep 0 clears" 0 "$(ls -1 "$VAULT/.backups" | wc -l | tr -d ' ')"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
