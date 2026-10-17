#!/usr/bin/env bash
# Behaviour test for scripts/devbox-account-user.sh (the box-side, no-sudo wrapper).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAP="$HERE/devbox-account-user.sh"
[ -x "$WRAP" ] || chmod +x "$WRAP"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check() { [ "$2" = "$3" ] && ok "$1" || no "$1" "expected [$2] got [$3]"; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT/home"
mkdir -p "$HOME/.agent-profiles/claude-main" \
  "$HOME/.agent-profiles/claude-personal" \
  "$HOME/.local/share/remote-devbox"

# A stub engine that prints the env the wrapper exported, then the remaining argv.
STUB="$HOME/.local/share/remote-devbox/devbox-account.sh"
cat >"$STUB" <<'EOF'
#!/usr/bin/env bash
printf 'CFG=%s\n' "${CLAUDE_CONFIG_DIR:-}"
printf 'VAULT=%s\n' "${DEVBOX_ACCOUNT_VAULT:-}"
printf 'STORE=%s\n' "${DEVBOX_ACCOUNT_STORE:-}"
printf 'PIN=%s\n' "${DEVBOX_ACCOUNT_OMP_PIN:-}"
printf 'PIN_SCRIPT=%s\n' "${DEVBOX_OMP_PIN_SCRIPT:-}"
printf 'ARGV=%s\n' "$*"
EOF
chmod +x "$STUB"
export DEVBOX_ACCOUNT_ENGINE="$STUB"
PIN="$HOME/.local/share/remote-devbox/omp-pin-after-use.py"
echo '# pin stub' >"$PIN"
export DEVBOX_OMP_PIN_SCRIPT="$PIN"

echo "== wrapper points at this user's profile tree and pins omp"
out="$("$WRAP" use team --force)"
check "config dir" "$HOME/.agent-profiles/claude-main" "$(printf '%s\n' "$out" | sed -n 's/^CFG=//p')"
check "per-profile vault" "$HOME/.claude-accounts/claude-main" "$(printf '%s\n' "$out" | sed -n 's/^VAULT=//p')"
check "file store" "file" "$(printf '%s\n' "$out" | sed -n 's/^STORE=//p')"
check "omp pin on" "1" "$(printf '%s\n' "$out" | sed -n 's/^PIN=//p')"
check "pin script next to engine" "$PIN" "$(printf '%s\n' "$out" | sed -n 's/^PIN_SCRIPT=//p')"
check "strips --agent-profile and keeps engine flags" "use team --force" "$(printf '%s\n' "$out" | sed -n 's/^ARGV=//p')"

echo "== --agent-profile selects another Claude tree"
out="$("$WRAP" --agent-profile claude-personal ls --json)"
check "personal config dir" "$HOME/.agent-profiles/claude-personal" "$(printf '%s\n' "$out" | sed -n 's/^CFG=//p')"
check "personal vault" "$HOME/.claude-accounts/claude-personal" "$(printf '%s\n' "$out" | sed -n 's/^VAULT=//p')"
check "personal argv" "ls --json" "$(printf '%s\n' "$out" | sed -n 's/^ARGV=//p')"

echo "== missing profile is a usage error, not a swap of the default tree"
out="$("$WRAP" --agent-profile does-not-exist ls 2>&1)"; rc=$?
check "missing profile rc" 1 "$rc"
case "$out" in *"does-not-exist"*) ok "names the missing profile" ;; *) no "names the missing profile" "$out" ;; esac

echo "== migrates a legacy ~/.claude-accounts vault into claude-main"
legacy="$HOME/.claude-accounts"
mkdir -p "$legacy/team" "$legacy/ugur" "$legacy/.backups/old" "$legacy/claude-personal"
printf '{"version":1,"active":"team","accounts":{"team":{}}}\n' >"$legacy/accounts.json"
echo '{}' >"$legacy/team/identity.json"
echo '{}' >"$legacy/ugur/credentials.json"
echo '{}' >"$legacy/.backups/old/identity.json"
echo 'keep' >"$legacy/claude-personal/accounts.json"
"$WRAP" ls >/dev/null
check "legacy registry moved" "team" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["active"])' "$legacy/claude-main/accounts.json")"
[ -d "$legacy/claude-main/team" ] && ok "team label moved" || no "team label moved" ""
[ -d "$legacy/claude-main/ugur" ] && ok "ugur label moved" || no "ugur label moved" ""
[ -d "$legacy/claude-main/.backups/old" ] && ok "backups moved" || no "backups moved" ""
[ -f "$legacy/accounts.json" ] && no "legacy registry gone" "still there" || ok "legacy registry gone"
[ -f "$legacy/claude-personal/accounts.json" ] && ok "other profile vault left" || no "other profile vault left" ""
# Second run must not redo the move.
"$WRAP" ls >/dev/null
check "second run keeps registry" "team" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["active"])' "$legacy/claude-main/accounts.json")"

echo "== DEVBOX_ACCOUNT_OMP_PIN=0 is honoured"
out="$(DEVBOX_ACCOUNT_OMP_PIN=0 "$WRAP" status)"
check "pin opt-out" "0" "$(printf '%s\n' "$out" | sed -n 's/^PIN=//p')"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
