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

# Block while the session lives. Every sixth tick (~30s) also snapshot the bridge
# identity of this unit's sessions: it exists only in a pid-keyed state file while
# the process runs, and the resume path needs it AFTER that process is gone. A
# session id never changes mid-session, so this cadence loses nothing.
SNAPSHOT=/usr/local/bin/agent-rc-bridge-snapshot
tick=0
while tmux -L "${SOCKET}" has-session -t "${SOCKET}" 2>/dev/null; do
  if [ $((tick % 6)) -eq 0 ] && [ -x "${SNAPSHOT}" ]; then
    "${SNAPSHOT}" "${ID}" >/dev/null 2>&1 || true
  fi
  tick=$((tick + 1))
  sleep 5
done

echo "[agent-rc-monitor] tmux session '${SOCKET}' gone — exiting non-zero for systemd restart" >&2
exit 1
