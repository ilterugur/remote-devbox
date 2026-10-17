#!/usr/bin/env bash
# Developer-facing Claude account swap on the box. No sudo.
#
#   devbox-account ls
#   devbox-account status
#   devbox-account use team          # Claude Code + omp, this user's default profile
#   devbox-account use ugur
#   devbox-account use team --agent-profile claude-personal
#
# Parks and restores the credential on this user's Claude profile tree, then pins omp
# to the same email + org. Remote Control restart still needs the operator
# (`sudo remote-devbox-account`); this command never asks for root.
set -euo pipefail

ME="devbox-account"
die() { printf '%s: %s\n' "$ME" "$*" >&2; exit 1; }

PROFILE="${DEVBOX_AGENT_PROFILE:-claude-main}"
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-profile)
      shift
      PROFILE="${1:-}"
      [ -n "$PROFILE" ] || die "--agent-profile needs a name"
      ;;
    --agent-profile=*)
      PROFILE="${1#--agent-profile=}"
      [ -n "$PROFILE" ] || die "--agent-profile needs a name"
      ;;
    *)
      PASS+=("$1")
      ;;
  esac
  shift
done

case "$PROFILE" in
  *[!a-zA-Z0-9._-]*) die "agent profile may only contain letters, digits, '.', '_' and '-'" ;;
  "") die "agent profile is empty" ;;
esac

# One-time: labels used to live in ~/.claude-accounts. Per-profile vaults keep Team
# RC on claude-main from sharing `active` with claude-personal. Move the legacy
# registry into claude-main the first time this command runs.
migrate_legacy_vault() {
  local src="$HOME/.claude-accounts"
  local dest="$HOME/.claude-accounts/claude-main"
  [ "$PROFILE" = "claude-main" ] || return 0
  [ -f "$src/accounts.json" ] || return 0
  [ -f "$dest/accounts.json" ] && return 0
  mkdir -p "$dest"
  chmod 700 "$dest"
  mv "$src/accounts.json" "$dest/accounts.json"
  [ -d "$src/.backups" ] && mv "$src/.backups" "$dest/.backups"
  rmdir "$src/.lock" 2>/dev/null || true
  local d base
  for d in "$src"/*; do
    [ -d "$d" ] || continue
    base="$(basename "$d")"
    case "$base" in claude-* | codex-* | omp-*) continue ;; esac
    if [ -f "$d/identity.json" ] || [ -f "$d/credentials.json" ]; then
      mv "$d" "$dest/"
    fi
  done
}

migrate_legacy_vault

pick_engine() {
  if [ -n "${DEVBOX_ACCOUNT_ENGINE:-}" ]; then
    printf '%s\n' "$DEVBOX_ACCOUNT_ENGINE"
    return 0
  fi
  local user_e="$HOME/.local/share/remote-devbox/devbox-account.sh"
  local sys_e="/usr/local/share/remote-devbox/devbox-account.sh"
  if [ -f "$sys_e" ] && grep -q 'verify-org' "$sys_e" 2>/dev/null; then
    printf '%s\n' "$sys_e"
    return 0
  fi
  if [ -f "$user_e" ]; then
    printf '%s\n' "$user_e"
    return 0
  fi
  if [ -f "$sys_e" ]; then
    printf '%s\n' "$sys_e"
    return 0
  fi
  return 1
}

ENGINE="$(pick_engine)" || die "account engine is not installed — copy scripts/devbox-account.sh to $HOME/.local/share/remote-devbox/ or re-run the playbook"
[ -f "$ENGINE" ] || die "account engine not found at $ENGINE"

pick_pin() {
  if [ -n "${DEVBOX_OMP_PIN_SCRIPT:-}" ] && [ -f "${DEVBOX_OMP_PIN_SCRIPT}" ]; then
    printf '%s\n' "$DEVBOX_OMP_PIN_SCRIPT"
    return 0
  fi
  local dir candidate
  dir="$(cd "$(dirname "$ENGINE")" && pwd -P)"
  for candidate in \
    "$dir/omp-pin-after-use.py" \
    "$HOME/.local/share/remote-devbox/omp-pin-after-use.py" \
    /usr/local/share/remote-devbox/omp-pin-after-use.py; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

PIN="$(pick_pin || true)"

CFG="$HOME/.agent-profiles/$PROFILE"
[ -d "$CFG" ] || die "no agent profile '$PROFILE' under $HOME/.agent-profiles — \`ls $HOME/.agent-profiles\` shows what there is"

export CLAUDE_CONFIG_DIR="$CFG"
export DEVBOX_ACCOUNT_VAULT="$HOME/.claude-accounts/$PROFILE"
export DEVBOX_ACCOUNT_STORE=file
# Developer swap means Claude Code and omp bill the same org. Opt out with 0.
export DEVBOX_ACCOUNT_OMP_PIN="${DEVBOX_ACCOUNT_OMP_PIN:-1}"
if [ -n "$PIN" ]; then
  export DEVBOX_OMP_PIN_SCRIPT="$PIN"
fi

if [ ${#PASS[@]} -eq 0 ]; then
  exec "$ENGINE"
else
  exec "$ENGINE" "${PASS[@]}"
fi
