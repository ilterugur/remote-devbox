#!/usr/bin/env bash
# Run on your CLIENT. Convenience wrapper around ssh into the box.
#   export DEVBOX_HOST=admin@mybox        # your operator_user @ box (Tailscale name)
#
# Usage:
#   connect.sh                          # shell on the box
#   connect.sh status                   # remote-control services + states
#   connect.sh login [users...]         # one-time /login per profile
#   connect.sh attach <user> <project>  # attach that profile's agent-rc session
#   connect.sh mosh <user> [session]    # roaming-resilient terminal AS a profile,
#                                       #   into a persistent tmux session (run `claude`
#                                       #   inside). Survives network drops; reconnect
#                                       #   resumes. Needs mosh on this client + on the
#                                       #   box (mosh_enabled), and Tailscale up.
#   connect.sh devup <user> <project> [cmd]   # start a project's dev server
#   connect.sh serve <port>             # tailscale-serve a dev port for preview
set -euo pipefail

HOST="${DEVBOX_HOST:-}"
[ -n "${HOST}" ] || { echo "Set DEVBOX_HOST, e.g.: export DEVBOX_HOST=admin@mybox" >&2; exit 1; }

cmd="${1:-ssh}"
shift || true

case "${cmd}" in
  ssh)    exec ssh -t "${HOST}" ;;
  status) exec ssh -t "${HOST}" "systemctl status 'agent-rc-*' --no-pager || true" ;;
  login)  exec ssh -t "${HOST}" "sudo remote-devbox-login $*" ;;
  attach) u="${1:?usage: connect.sh attach <user> <project>}"; p="${2:?project required}"
          exec ssh -t "${HOST}" "sudo -u ${u} tmux -L agent-rc-claude-${u}-${p} attach -t agent-rc-claude-${u}-${p}" ;;
  mosh)   u="${1:?usage: connect.sh mosh <user> [session]}"; sess="${2:-main}"
          command -v mosh >/dev/null || { echo "mosh not installed on this client (brew install mosh)" >&2; exit 1; }
          exec mosh "${u}@${HOST#*@}" -- tmux new -A -s "${sess}" ;;
  devup)  u="${1:?usage: connect.sh devup <user> <project> [cmd]}"; p="${2:?project required}"; shift 2 || true
          exec ssh -t "${HOST}" "sudo remote-devbox-dev ${u} ${p} $*" ;;
  serve)  port="${1:?usage: connect.sh serve <port>}"
          exec ssh -t "${HOST}" "tailscale serve ${port}" ;;
  *) echo "unknown command: ${cmd}  (ssh|status|login|attach|mosh|devup|serve)" >&2; exit 1 ;;
esac
