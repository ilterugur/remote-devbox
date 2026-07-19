#!/usr/bin/env bash
# Managed by remote-devbox. systemd ExecStart for agent-rc-<id>.service when
# self-heal is enabled (Type=simple). The wrapper (ExecStartPre) spawns the
# detached tmux server; this monitor then BLOCKS while that tmux session is
# alive and exits non-zero the moment it disappears — so systemd's
# Restart=on-failure brings the whole unit back after an OOM/kill/crash.
#
# Why a monitor instead of Type=oneshot+RemainAfterExit: a oneshot unit goes to
# "failed (oom-kill)" and STAYS down when the cgroup is OOM-killed. A blocking
# main process lets systemd track liveness and auto-restart on any death.
set -uo pipefail

ID="${1:?instance id required}"
SOCKET="agent-rc-${ID}"

# Wait for the session the wrapper just spawned to appear (avoid a startup race
# where we'd exit before tmux finished creating it).
for _ in $(seq 1 30); do
  tmux -L "${SOCKET}" has-session -t "${SOCKET}" 2>/dev/null && break
  sleep 1
done

# Block while the session lives.
while tmux -L "${SOCKET}" has-session -t "${SOCKET}" 2>/dev/null; do
  sleep 5
done

echo "[agent-rc-monitor] tmux session '${SOCKET}' gone — exiting non-zero for systemd restart" >&2
exit 1
