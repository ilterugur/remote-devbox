#!/usr/bin/env bash
# Run as root on the box:  sudo claude-devbox-dev <profile-user> <project> [command...]
# Starts a project's dev server in a persistent tmux session AS THAT PROFILE USER,
# so it survives a closed client. Preview it via Tailscale Serve / VS Code forward.
#
#   sudo claude-devbox-dev work app                 # mise exec -- bun run dev
#   sudo claude-devbox-dev work app "bun run dev:web"
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

user="${1:?usage: claude-devbox-dev <user> <project> [command...]}"
proj="${2:?usage: claude-devbox-dev <user> <project> [command...]}"
shift 2 || true
cmd="${*:-mise exec -- bun install && mise exec -- bun run dev}"

dir="/home/${user}/projects/${proj}"
[ -d "${dir}" ] || { echo "no such project: ${dir}" >&2; exit 1; }

session="dev-${proj}"
if sudo -u "${user}" tmux has-session -t "${session}" 2>/dev/null; then
  echo "Already running. Attach:  sudo -u ${user} tmux attach -t ${session}"
  exit 0
fi

sudo -u "${user}" -H bash -lc "cd '${dir}' && tmux new-session -d -s '${session}' '${cmd}'"
echo "Started '${session}' for ${user} in ${dir}"
echo "  command: ${cmd}"
echo "  attach:  sudo -u ${user} tmux attach -t ${session}"
