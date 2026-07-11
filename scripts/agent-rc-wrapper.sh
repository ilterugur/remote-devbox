#!/usr/bin/env bash
# Managed by claude-devbox. Entry point for agent-rc-<id>.service.
# Opens a dedicated tmux server (-L <id>) running the self-healing loop, so each
# profile's env (CLAUDE_CONFIG_DIR etc., set by the systemd unit) stays isolated.
set -euo pipefail

ID="${1:?instance id required}"
SOCKET="agent-rc-${ID}"

# Idempotent: a restart must not spawn a duplicate session.
if tmux -L "${SOCKET}" has-session -t "${SOCKET}" 2>/dev/null; then
  exit 0
fi

# New tmux server inherits THIS process's env (the systemd unit Environment=...)
# and passes it to the loop. Tolerate a duplicate from a racing restart.
tmux -L "${SOCKET}" new-session -d -s "${SOCKET}" /usr/local/bin/agent-rc-run 2>/dev/null || true
exit 0
