#!/usr/bin/env bash
# Managed by remote-devbox. Runs INSIDE tmux as the profile user. Keeps the agent's
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

# An interactive session gets its memory wiring from the profile launcher, which this
# service does not go through — it execs the agent binary directly. Source the same
# file here, or a Remote Control session runs with memory silently switched off.
PROFILE="${CLAUDE_RC_AGENT_PROFILE:-}"
if [ -n "${PROFILE}" ] && [ -r "${HOME}/.agent-profiles/${PROFILE}/memory.env" ]; then
  # shellcheck disable=SC1090
  . "${HOME}/.agent-profiles/${PROFILE}/memory.env"
fi

# Same story for the shared heavy build/typecheck/generate/test slot, and this one is
# the path that matters: an always-on session runs the repo's builds, so leaving it
# ungated lets several agents start a multi-gigabyte tsc at the same moment and take
# the host into swap. Sourced AFTER the mise activation above — behind mise's shims the
# gate never sees a command. No file means this profile opted out.
if [ -n "${PROFILE}" ] && [ -r "${HOME}/.agent-profiles/${PROFILE}/heavy-gate.env" ]; then
  # shellcheck disable=SC1090
  . "${HOME}/.agent-profiles/${PROFILE}/heavy-gate.env"
fi
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
    echo "[agent-rc] ${CFG} not logged in — run: sudo remote-devbox-login; polling in 15s..." >&2
    sleep 15
  fi
done
