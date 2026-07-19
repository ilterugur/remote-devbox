#!/usr/bin/env bash
# Run as root on the box:  sudo claude-config-apply [--with-settings] [users...]
# Fans /opt/claude-shared (the curated portable config) into each profile's
# ~/.claude. COPIES real files (symlinks get wiped by Claude auto-update) and
# NEVER touches per-account identity (.credentials.json, .claude.json) or
# machine/session state. Detects profiles from /home/*/.claude if no users given.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (writes into each profile home)." >&2; exit 1; }

SHARED="${CLAUDE_SHARED:-/opt/claude-shared}"
[ -d "${SHARED}" ] || { echo "No shared config at ${SHARED} — run the playbook / bundle-local-config.sh first." >&2; exit 1; }

with_settings=0
users=()
for a in "$@"; do
  case "$a" in
    --with-settings) with_settings=1 ;;
    *) users+=("$a") ;;
  esac
done
if [ ${#users[@]} -eq 0 ]; then
  mapfile -t users < <(for d in /home/*/.claude; do [ -d "$d" ] && basename "$(dirname "$d")"; done)
fi
[ ${#users[@]} -gt 0 ] || { echo "No profiles found." >&2; exit 1; }

# Identity files excluded inline (always); full machine-state list in one shared
# file used by the client->box push too, so they stay in lock-step.
excludes=( --exclude='.credentials.json' --exclude='.claude.json' )
EXCLUDES_FILE="${CLAUDE_SYNC_EXCLUDES:-/usr/local/share/claude-devbox/sync-excludes.txt}"
if [ -f "${EXCLUDES_FILE}" ]; then
  excludes+=( "--exclude-from=${EXCLUDES_FILE}" )
else
  echo "WARNING: ${EXCLUDES_FILE} not found — only identity files excluded; machine state may leak." >&2
fi
[ "${with_settings}" -eq 0 ] && excludes+=( --exclude='settings.json' )

for u in "${users[@]}"; do
  dest="/home/${u}/.claude"
  mkdir -p "${dest}"
  rsync -a "${excludes[@]}" "${SHARED}/" "${dest}/"
  chown -R "${u}:${u}" "${dest}"
  echo "applied shared config -> ${u}"
done

if [ "${with_settings}" -eq 1 ]; then
  echo "settings.json INCLUDED."
else
  echo "settings.json EXCLUDED (default). See docs/config-sync.md to opt in safely."
fi
