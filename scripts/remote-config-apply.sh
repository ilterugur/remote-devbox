#!/usr/bin/env bash
# Run as root on the box:  sudo remote-config-apply [--with-settings] [--source DIR] <user>...
# Copies a curated config tree into each developer's ~/.claude. COPIES real files
# (symlinks get wiped by the agent's auto-update) and NEVER touches per-account
# identity (.credentials.json, .claude.json) or machine/session state.
#
# Each developer has their own curated tree, so the source defaults to
# /opt/remote-shared/<user> — one person's skills are not silently written into
# someone else's account. --source overrides it for every named user.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (writes into each developer's home)." >&2; exit 1; }

with_settings=0
source_override="${CLAUDE_SHARED:-}"
users=()
while [ $# -gt 0 ]; do
  case "$1" in
    --with-settings) with_settings=1 ;;
    --source) shift; source_override="${1:?--source needs a directory}" ;;
    *) users+=("$1") ;;
  esac
  shift
done
if [ ${#users[@]} -eq 0 ]; then
  mapfile -t users < <(for d in /opt/remote-shared/*/; do [ -d "$d" ] && basename "$d"; done)
fi
[ ${#users[@]} -gt 0 ] || { echo "No developers named, and no curated tree under /opt/remote-shared." >&2; exit 1; }

# Identity files excluded inline (always); full machine-state list in one shared
# file used by the client->box push too, so they stay in lock-step.
excludes=( --exclude='.credentials.json' --exclude='.claude.json' )
EXCLUDES_FILE="${CLAUDE_SYNC_EXCLUDES:-/usr/local/share/remote-devbox/sync-excludes.txt}"
if [ -f "${EXCLUDES_FILE}" ]; then
  excludes+=( "--exclude-from=${EXCLUDES_FILE}" )
else
  echo "WARNING: ${EXCLUDES_FILE} not found — only identity files excluded; machine state may leak." >&2
fi
[ "${with_settings}" -eq 0 ] && excludes+=( --exclude='settings.json' )

for u in "${users[@]}"; do
  src="${source_override:-/opt/remote-shared/${u}}"
  if [ ! -d "${src}" ]; then
    echo "no curated config at ${src} — skipping ${u}" >&2
    continue
  fi
  dest="/home/${u}/.claude"
  mkdir -p "${dest}"
  rsync -a "${excludes[@]}" "${src}/" "${dest}/"
  chown -R "${u}:${u}" "${dest}"
  echo "applied ${src} -> ${u}"
done

if [ "${with_settings}" -eq 1 ]; then
  echo "settings.json INCLUDED."
else
  echo "settings.json EXCLUDED (default). See docs/config-sync.md to opt in safely."
fi
