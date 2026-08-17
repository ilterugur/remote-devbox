#!/usr/bin/env bash
# Managed by remote-devbox. Runs INSIDE a tmux window (under the RC tmux server)
# to bring ONE interrupted session back: full conversation via --resume, exposed
# to the phone via --remote-control, with a system-framed "you were OOM-killed,
# continue seamlessly" prompt so the agent does not emit robotic acknowledgments
# and continues in the conversation's own language/tone.
#
# All text args are passed as FILES (name, notice) — never inline — because Claude
# prompts contain quotes/apostrophes/em-dashes that break shell quoting otherwise.
#
# Args: <uuid> <permission-mode> <worktree-dir> <name-file> <notice-file> <sys-file> [bridge-file]
set -uo pipefail

UUID="${1:?uuid}"; PERM="${2:?permission-mode}"; WT="${3:?worktree}"
NAMEFILE="${4:?name-file}"; NOTICEFILE="${5:?notice-file}"; SYSFILE="${6:?sys-file}"
BRIDGEFILE="${7:-}"

# Remote Control needs claude.ai OAuth — these make it refuse, so unset them.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
  CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY 2>/dev/null || true

export PATH="${HOME}/.local/bin:${PATH}"
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)" || true

# This is the third entry point that starts an agent, and on a box that restarts or
# OOMs it is the one that starts nearly all of them: a session resumed here inherits
# nothing from agent-rc-run. Source the same shared heavy-job wiring, after the mise
# activation above, or every build a resumed session runs bypasses the slot. The
# profile name reaches us from the RC unit through the tmux server we run under.
_RC_PROFILE="${CLAUDE_RC_AGENT_PROFILE:-}"
if [ -n "${_RC_PROFILE}" ] && [ -r "${HOME}/.agent-profiles/${_RC_PROFILE}/heavy-gate.env" ]; then
  # shellcheck disable=SC1090
  . "${HOME}/.agent-profiles/${_RC_PROFILE}/heavy-gate.env"
fi

cd "${WT}" 2>/dev/null || { echo "[agent-rc-resume] worktree missing: ${WT}" >&2; sleep 10; exit 1; }

NAME="$(cat "${NAMEFILE}")"
NOTICE="$(cat "${NOTICEFILE}")"

# Reattach to the card this conversation already owns instead of minting a new one:
# the CLI's own background-job machinery relaunches through the same variable, and
# reattaching unarchives a card that was archived at shutdown. A stale pointer
# degrades to a fresh card rather than failing, because the stricter
# "refuse to mint fresh" mode stays off.
#
# Deliberately not set: CLAUDE_BRIDGE_REATTACH_OUTBOUND_ONLY, because the session has
# to accept input from the phone; and the SEQ / GROUPING companions, which are
# optional and have no trustworthy value after an OOM.
#
# The pointer is re-validated here rather than trusted from the orchestrator: this is
# a separate process, and the value is about to enter the agent's environment. The
# echoes below are pane-local — this script runs under the tmux server, so they are
# overwritten by the agent's own screen within seconds and are useful only to someone
# attached live. The durable statement of which path ran is the orchestrator's
# journald line, which applies the same pattern before it claims anything.
if [ -n "${BRIDGEFILE}" ] && [ -r "${BRIDGEFILE}" ]; then
  BRIDGE="$(tr -d '\r\n' < "${BRIDGEFILE}")"
  if printf '%s' "${BRIDGE}" | grep -Eq '^session_[A-Za-z0-9_-]{6,128}$'; then
    export CLAUDE_BRIDGE_REATTACH_SESSION="${BRIDGE}"
    echo "[agent-rc-resume] reattaching ${UUID} to ${BRIDGE}" >&2
  else
    echo "[agent-rc-resume] ignoring malformed bridge pointer for ${UUID}" >&2
  fi
else
  echo "[agent-rc-resume] no bridge pointer for ${UUID} — a fresh claude.ai card will be minted" >&2
fi

exec claude --resume "${UUID}" \
  --permission-mode "${PERM}" \
  --remote-control "${NAME}" \
  --append-system-prompt-file "${SYSFILE}" \
  "${NOTICE}"
