#!/usr/bin/env bash
# Managed by claude-devbox. Runs INSIDE tmux as the profile user. Keeps the agent's
# always-on session alive and self-heals once the profile is logged in. Agent-neutral:
# all agent specifics come from the sourced adapter.

export PATH="${HOME}/.local/bin:${PATH}"
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)" || true
command -v node >/dev/null 2>&1 || \
  echo "[agent-rc] WARNING: toolchain (node) not on PATH — check 'mise ls' for $(whoami)" >&2

AGENT="${CLAUDE_RC_AGENT:-claude}"
ADAPTER="/usr/local/share/agent-devbox/adapters/${AGENT}.sh"
[ -r "${ADAPTER}" ] || { echo "[agent-rc] adapter ${ADAPTER} missing" >&2; sleep 15; exit 1; }
# shellcheck disable=SC1090
. "${ADAPTER}"

CFG="${CLAUDE_CONFIG_DIR:-$HOME/${AGENT_CFG_DEFAULT}}"
DIR="${CLAUDE_RC_PROJECT_DIR:?CLAUDE_RC_PROJECT_DIR not set}"
NAME="${CLAUDE_RC_NAME:-${AGENT}}"
SPAWN="${CLAUDE_RC_SPAWN:-worktree}"
CAPACITY="${CLAUDE_RC_CAPACITY:-4}"

while true; do
  if adapter_creds_ok "${CFG}"; then
    if cd "${DIR}" 2>/dev/null; then
      adapter_launch "${DIR}" "${NAME}" "${SPAWN}" "${CAPACITY}" || true
      echo "[agent-rc] ${AGENT} session exited; restarting in 5s..." >&2
      sleep 5
    else
      echo "[agent-rc] project dir ${DIR} missing (clone failed? add the profile's SSH key to GitHub and re-run the playbook); retrying in 15s..." >&2
      sleep 15
    fi
  else
    echo "[agent-rc] ${CFG} not logged in — run: sudo claude-devbox-login; polling in 15s..." >&2
    sleep 15
  fi
done
