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

# Always force file store: on macOS the engine defaults to keychain, which hangs or
# touches the operator keychain if a test is run under bash -x without the exports below.
engine() {
  env DEVBOX_ACCOUNT_STORE=file \
    DEVBOX_ACCOUNT_VAULT="$DEVBOX_ACCOUNT_VAULT" \
    CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
    HOME="$HOME" \
    DEVBOX_ACCOUNT_PGREP="${DEVBOX_ACCOUNT_PGREP:-false}" \
    ${DEVBOX_OMP_PIN_SCRIPT:+DEVBOX_OMP_PIN_SCRIPT="$DEVBOX_OMP_PIN_SCRIPT"} \
    "$ENGINE" "$@"
}

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
# The pin script also scans PI_CODING_AGENT_DIR. Run from inside omp, that is the
# operator's live agent.db: the synthetic accounts below were landing in it.
unset PI_CODING_AGENT_DIR
# The org check asks Anthropic which org a token bills. Point it at a fixture file instead;
# absent, the check cannot run and only warns, which is what every section but the
# org-check one wants.
export DEVBOX_ACCOUNT_PROFILE_URL="file://$ROOT/profile.json"
profile() { printf '{"organization":{"uuid":"%s","name":"%s"}}\n' "$1" "$2" >"$ROOT/profile.json"; }
mkdir -p "$CLAUDE_CONFIG_DIR"

STATE="$CLAUDE_CONFIG_DIR/.claude.json"
CRED="$CLAUDE_CONFIG_DIR/.credentials.json"
VAULT="$DEVBOX_ACCOUNT_VAULT"

# A tree with the shared, NON-account state we must never disturb, plus one account.
login() { # login <userID> <email> <uuid> <token> [extra-key-json] [oauthAccount-overrides-json]
  python3 - "$STATE" "$1" "$2" "$3" "${5:-null}" "${6:-null}" <<'PY'
import json, sys
path, uid, email, uuid, extra, oauth_extra = sys.argv[1:7]
try:
    with open(path) as fh:
        d = json.load(fh)
except FileNotFoundError:
    d = {}
oauth = {"accountUuid": uuid, "emailAddress": email, "organizationName": "Org " + uid}
if oauth_extra != "null":
    oauth.update(json.loads(oauth_extra))
d.update({
    "userID": uid,
    "oauthAccount": oauth,
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
out="$(engine add work 2>&1)"; rc=$?
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
engine add personal >/dev/null 2>&1
check "second identity parked" "u-b" "$(jq_get "$VAULT/personal/identity.json" userID)"
check "active moved" "personal" "$(jq_get "$VAULT/accounts.json" active)"

echo "== use: swap back restores identity AND credential"
engine use work >/dev/null 2>&1
check "tree userID" "u-a" "$(jq_get "$STATE" userID)"
check "tree email" "a@example.com" "$(jq_get "$STATE" oauthAccount.emailAddress)"
check "tree credential" "tok-a" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
check "registry active" "work" "$(jq_get "$VAULT/accounts.json" active)"
check "shared mcp untouched" "x" "$(jq_get "$STATE" mcpServers.shared-mcp.command)"
check "shared projects untouched" "True" "$(jq_get "$STATE" projects./work.hasTrustDialogAccepted)"
check "entitlement cache follows the account" "u-a" "$(jq_get "$STATE" modelAccessCache.cachedFor)"
check "key present in target is restored" "a" "$(jq_get "$STATE" s1mAccessCache.for)"

echo "== team workspace: same email + accountUuid, different organization"
login u-shared me@example.com uuid-shared tok-max null \
  '{"organizationUuid":"org-personal","organizationType":"claude_max","organizationName":"Personal Org"}'
engine add max >/dev/null 2>&1
login u-shared me@example.com uuid-shared tok-team null \
  '{"organizationUuid":"org-team","organizationType":"claude_team","organizationName":"Acme Team"}'
engine add team >/dev/null 2>&1
check "team org parked" "org-team" "$(jq_get "$VAULT/team/identity.json" oauthAccount.organizationUuid)"
check "team orgType parked" "claude_team" "$(jq_get "$VAULT/team/identity.json" oauthAccount.organizationType)"
engine use max >/dev/null 2>&1
check "swap to max org" "org-personal" "$(jq_get "$STATE" oauthAccount.organizationUuid)"
check "max credential" "tok-max" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
engine use team >/dev/null 2>&1
check "swap to team org" "org-team" "$(jq_get "$STATE" oauthAccount.organizationUuid)"
check "team credential" "tok-team" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
check "same accountUuid across orgs" "uuid-shared" "$(jq_get "$STATE" oauthAccount.accountUuid)"

echo "== use: and forward again"
engine use personal >/dev/null 2>&1
check "tree userID" "u-b" "$(jq_get "$STATE" userID)"
check "tree credential" "tok-b" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
check "key absent in target is deleted" "" "$(jq_get "$STATE" s1mAccessCache.for)"
check "parked work credential survived" "tok-a" "$(jq_get "$VAULT/work/credentials.json" claudeAiOauth.accessToken)"

echo "== ls / status"
out="$(engine ls)"
case "$out" in *"* personal"*) ok "ls marks the active account" ;; *) no "ls marks the active account" "$out" ;; esac
out="$(engine status --json)"
check "status json active" "personal" "$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["active"])')"
check "status json store" "file" "$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["store"])')"

echo "== guard: claude running blocks the swap"
before="$(cat "$STATE")"
DEVBOX_ACCOUNT_PGREP=true engine use work >/dev/null 2>&1; rc=$?
check "refused" 1 "$rc"
check "tree untouched" "$before" "$(cat "$STATE")"
DEVBOX_ACCOUNT_PGREP=true engine use work --force >/dev/null 2>&1
check "--force overrides" "u-a" "$(jq_get "$STATE" userID)"
engine use personal >/dev/null 2>&1

echo "== guard: no-op use while claude is running is allowed"
DEVBOX_ACCOUNT_PGREP=true engine use personal >/dev/null 2>&1; rc=$?
check "no-op allowed" 0 "$rc"

echo "== heal: registry active but tree drift restores vault without clobbering it"
engine use team >/dev/null 2>&1
team_vault_org="$(jq_get "$VAULT/team/identity.json" oauthAccount.organizationUuid)"
python3 - "$STATE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
acct = data.setdefault("oauthAccount", {})
acct["organizationUuid"] = "uuid-team-drift"
acct["organizationName"] = "Drifted Org"
acct["organizationType"] = "claude_team"
json.dump(data, open(sys.argv[1], "w"), indent=2)
PY
engine use team >/dev/null 2>&1
check "tree realigned to vault org" "$team_vault_org" "$(jq_get "$STATE" oauthAccount.organizationUuid)"
check "vault org untouched" "$team_vault_org" "$(jq_get "$VAULT/team/identity.json" oauthAccount.organizationUuid)"
engine use personal >/dev/null 2>&1

echo "== no-op use still runs omp pin when tree matches vault"
PIN_LOG="$ROOT/pin.log"
: >"$PIN_LOG"
FAKE_PIN="$ROOT/fake-omp-pin.py"
cat >"$FAKE_PIN" <<EOF
#!/usr/bin/env python3
import sys
open("$PIN_LOG", "a", encoding="utf-8").write(sys.argv[1] + "\n")
EOF
chmod +x "$FAKE_PIN"
DEVBOX_OMP_PIN_SCRIPT="$FAKE_PIN" engine use personal >/dev/null 2>&1
check "omp pin on no-op use" "personal" "$(tail -1 "$PIN_LOG")"

echo "== guard: --force while claude is 'running' warns about org snap-back"
DEVBOX_ACCOUNT_PGREP=true out="$(engine use personal --force 2>&1)"
case "$out" in
  *"snap back"*) ok "warns that a live Claude rewrites the org" ;;
  *) no "warns that a live Claude rewrites the org" "$out" ;;
esac
DEVBOX_ACCOUNT_PGREP=false out="$(engine use work 2>&1)"
case "$out" in
  *"snap back"*) no "quiet when nothing is running" "$out" ;;
  *) ok "quiet when nothing is running" ;;
esac

echo "== vault: CLAUDE_CONFIG_DIR scopes vault and forces file store"
usage_out="$(env -u DEVBOX_ACCOUNT_VAULT -u DEVBOX_ACCOUNT_STORE HOME="$HOME" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" DEVBOX_ACCOUNT_PGREP=false "$ENGINE" 2>&1)" || true
case "$usage_out" in
  *"vault: $HOME/.claude-accounts/claude-main"*) ok "scoped vault is ~/.claude-accounts/<profile>" ;;
  *) no "scoped vault is ~/.claude-accounts/<profile>" "$usage_out" ;;
esac
case "$usage_out" in
  *"store: file"*) ok "relocated tree uses file store" ;;
  *) no "relocated tree uses file store" "$usage_out" ;;
esac
scoped_ls="$(env -u DEVBOX_ACCOUNT_VAULT HOME="$HOME" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" DEVBOX_ACCOUNT_PGREP=false DEVBOX_ACCOUNT_STORE=file "$ENGINE" ls 2>&1)" || true
case "$scoped_ls" in
  *"work"*|*"personal"*) no "scoped vault is independent of ~/.claude-accounts" "$scoped_ls" ;;
  *) ok "scoped vault is independent of ~/.claude-accounts" ;;
esac

echo "== guard: unknown label changes nothing"
before="$(cat "$STATE")"
engine use nope >/dev/null 2>&1; rc=$?
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
err="$(engine use work 2>&1)"; rc=$?
check "refused" 1 "$rc"
case "$err" in *"not tracked"*) ok "explains how to adopt it" ;; *) no "explains how to adopt it" "$err" ;; esac
mv "$VAULT/accounts.json.keep" "$VAULT/accounts.json"

echo "== rm: refuses the active account, forgets an inactive one"
engine use personal >/dev/null 2>&1
engine rm personal >/dev/null 2>&1; rc=$?
check "active is protected" 1 "$rc"
engine rm work >/dev/null 2>&1
check "forgotten" "" "$(jq_get "$VAULT/accounts.json" accounts.work.email)"
[ -d "$VAULT/work" ] && no "vault dir removed" || ok "vault dir removed"
login u-a a@example.com uuid-a tok-a
engine add work >/dev/null 2>&1

echo "== backups: only the parked triple, newest 3 kept"
for i in 1 2 3 4 5 6; do
  target=work; [ $((i % 2)) -eq 0 ] && target=personal
  engine use "$target" >/dev/null 2>&1
  sleep 1.05
done
n="$(ls -1 "$VAULT/.backups" | wc -l | tr -d ' ')"
check "retention" 3 "$n"
files="$(find "$VAULT/.backups" -type f | sed 's#.*/##' | sort -u | tr '\n' ' ')"
check "snapshot contents" "credentials.json identity.json " "$files"
bytes="$(find "$VAULT/.backups" -type f -exec cat {} + | wc -c | tr -d ' ')"
[ "$bytes" -lt 20000 ] && ok "snapshots stay in the kilobytes ($bytes B)" || no "snapshots stay small" "$bytes B"
DEVBOX_ACCOUNT_BACKUP_KEEP=1 engine gc >/dev/null 2>&1
check "gc honours --keep" 1 "$(ls -1 "$VAULT/.backups" | wc -l | tr -d ' ')"
engine gc --keep 0 >/dev/null 2>&1
check "gc --keep 0 clears" 0 "$(ls -1 "$VAULT/.backups" | wc -l | tr -d ' ')"

echo "== org check: a token billing another org is never parked under this identity"
login u-o o@example.com uuid-o tok-o null \
  '{"organizationUuid":"org-max","organizationType":"claude_max","organizationName":"Max Org"}'
profile org-team "Team Org"
out="$(engine add omax 2>&1)"; rc=$?
check "mismatched add refused" 1 "$rc"
case "$out" in *"Team Org"*) ok "names the org the token bills" ;; *) no "names the org the token bills" "$out" ;; esac
[ -e "$VAULT/omax" ] && no "nothing parked on refusal" "$(ls -a "$VAULT/omax")" || ok "nothing parked on refusal"
check "registry untouched on refusal" "" "$(jq_get "$VAULT/accounts.json" accounts.omax.email)"
profile org-max "Max Org"
engine add omax >/dev/null 2>&1; rc=$?
check "matching add adopted" 0 "$rc"
check "matching token parked" "tok-o" "$(jq_get "$VAULT/omax/credentials.json" claudeAiOauth.accessToken)"

echo "== org check: a swap does not re-park a mismatched pair over the label"
# A live session left a Team token under omax's personal identity.
printf '{"claudeAiOauth":{"accessToken":"tok-o-team","refreshToken":"r","expiresAt":9999999999999}}\n' >"$CRED"
profile org-team "Team Org"
out="$(engine use personal 2>&1)"; rc=$?
check "swap still proceeds" 0 "$rc"
check "swap landed" "tok-b" "$(jq_get "$CRED" claudeAiOauth.accessToken)"
check "label keeps its verified token" "tok-o" "$(jq_get "$VAULT/omax/credentials.json" claudeAiOauth.accessToken)"
stash="$(ls -1d "$VAULT"/.backups/*-omax-mismatch 2>/dev/null | head -1)"
check "mismatched token kept aside" "tok-o-team" "$(jq_get "$stash/credentials.json" claudeAiOauth.accessToken)"
case "$out" in *"not re-parking omax"*) ok "warns about the skipped park" ;; *) no "warns about the skipped park" "$out" ;; esac
rm -f "$ROOT/profile.json"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
