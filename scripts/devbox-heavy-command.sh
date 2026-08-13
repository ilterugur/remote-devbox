#!/usr/bin/env bash
# Managed by Ansible (remote-devbox).
#
# PATH shim for commands that can consume most of a developer's memory budget.
# Every agent owned by the same Linux user shares one kernel flock, so unrelated
# light commands remain concurrent while build/typecheck/generate/test jobs queue.
set -euo pipefail

gate_dir=$(cd "$(dirname "$0")" && pwd -P)
command_name=$(basename "$0")
script_path=$(readlink -f "${BASH_SOURCE[0]}")

resolve_real_command() {
  local entry candidate candidate_path entry_path
  local old_ifs=$IFS
  IFS=:
  for entry in $PATH; do
    [[ -n "$entry" ]] || entry=.
    entry_path=$(cd "$entry" 2>/dev/null && pwd -P) || continue
    [[ "$entry_path" != "$gate_dir" ]] || continue
    candidate="$entry/$command_name"
    [[ -x "$candidate" && ! -d "$candidate" ]] || continue
    candidate_path=$(readlink -f "$candidate" 2>/dev/null || true)
    [[ -n "$candidate_path" && "$candidate_path" != "$script_path" ]] || continue
    printf '%s\n' "$candidate"
    IFS=$old_ifs
    return 0
  done
  IFS=$old_ifs
  return 1
}

process_start_time() {
  local stat_line remaining
  IFS= read -r stat_line < "/proc/$1/stat" || return 1
  remaining=${stat_line##*) }
  set -- $remaining
  [[ $# -ge 20 ]] || return 1
  printf '%s\n' "${20}"
}

category_enabled() {
  [[ ",${DEVBOX_HEAVY_JOB_CATEGORIES-build,typecheck,generate,test}," == *",$1,"* ]]
}

is_heavy_token() {
  case "$1" in
    build | build:* | *:build | *:build:*) category_enabled build ;;
    typecheck | typecheck:* | *:typecheck | *:typecheck:*) category_enabled typecheck ;;
    generate | generate:* | *:generate | *:generate:*) category_enabled generate ;;
    test | test:* | *:test | *:test:*) category_enabled test ;;
    *) return 1 ;;
  esac
}

is_heavy_path() {
  case "${1##*/}" in
    generate-declarations.ts) category_enabled generate ;;
    typecheck-partitions.ts | tsc | tsc.js) category_enabled typecheck ;;
    *) return 1 ;;
  esac
}

is_heavy_command() {
  local arg
  case "$command_name" in
    tsc)
      category_enabled typecheck
      ;;
    bun | npm | pnpm | yarn)
      for arg in "$@"; do
        is_heavy_token "$arg" && return 0
        is_heavy_path "$arg" && return 0
      done
      ;;
    bunx | npx)
      for arg in "$@"; do
        case "${arg##*/}" in
          tsc) category_enabled typecheck && return 0 ;;
          turbo | next) category_enabled build && return 0 ;;
          prisma) category_enabled generate && return 0 ;;
        esac
        is_heavy_token "$arg" && return 0
        is_heavy_path "$arg" && return 0
      done
      ;;
    node)
      for arg in "$@"; do
        case "$arg" in
          */typescript/bin/tsc | */typescript/lib/tsc.js) category_enabled typecheck && return 0 ;;
          */next/dist/bin/next | */turbo/bin/turbo) category_enabled build && return 0 ;;
          */prisma/build/index.js) category_enabled generate && return 0 ;;
        esac
        is_heavy_path "$arg" && return 0
      done
      ;;
    turbo)
      for arg in "$@"; do
        is_heavy_token "$arg" && return 0
      done
      ;;
    next)
      category_enabled build && [[ " ${*} " == *" build "* ]] && return 0
      ;;
    prisma)
      category_enabled generate && [[ " ${*} " == *" generate "* ]] && return 0
      ;;
  esac
  return 1
}

real_command=$(resolve_real_command) || {
  echo "devbox: cannot resolve the real '$command_name' outside $gate_dir" >&2
  exit 127
}

if ! is_heavy_command "$@"; then
  exec "$real_command" "$@"
fi

runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
lock_dir="$runtime_dir/agent-devbox"
lock_path="$lock_dir/heavy-job.lock"
umask 077
mkdir -p "$lock_dir"

# A nested command may legitimately resolve through the shim again. Accept the
# inherited descriptor only when it points at this exact lock and still owns it.
inherited_fd=${DEVBOX_HEAVY_JOB_FD:-}
if [[ "$inherited_fd" =~ ^[0-9]+$ && -e "/proc/$$/fd/$inherited_fd" ]]; then
  inherited_path=$(readlink -f "/proc/$$/fd/$inherited_fd" 2>/dev/null || true)
  if [[ "$inherited_path" == "$lock_path" ]] && /usr/bin/flock -n "$inherited_fd"; then
    exec "$real_command" "$@"
  fi
fi

# Some runtimes intentionally close non-stdio descriptors in spawned children.
# Prove that the recorded owner is still an ancestor, is the same PID generation,
# still has the exact descriptor open, and that a separate descriptor cannot take
# the kernel lock. Only then is this a reentrant child of the active heavy job.
owner_pid=${DEVBOX_HEAVY_JOB_OWNER_PID:-}
owner_start=${DEVBOX_HEAVY_JOB_OWNER_START:-}
owner_fd=${DEVBOX_HEAVY_JOB_OWNER_FD:-}
if [[ "$owner_pid" =~ ^[0-9]+$ && "$owner_start" =~ ^[0-9]+$ && "$owner_fd" =~ ^[0-9]+$ ]]; then
  current_pid=$$
  owner_is_ancestor=false
  while [[ "$current_pid" -gt 1 && -r "/proc/$current_pid/status" ]]; do
    current_pid=$(awk '/^PPid:/{print $2}' "/proc/$current_pid/status")
    if [[ "$current_pid" == "$owner_pid" ]]; then
      owner_is_ancestor=true
      break
    fi
  done

  actual_owner_start=$(process_start_time "$owner_pid" 2>/dev/null || true)
  actual_owner_path=$(readlink -f "/proc/$owner_pid/fd/$owner_fd" 2>/dev/null || true)
  if [[ "$owner_is_ancestor" == true && "$actual_owner_start" == "$owner_start" && \
        "$actual_owner_path" == "$lock_path" ]]; then
    shopt -u varredir_close 2>/dev/null || true
    exec {probe_fd}>>"$lock_path"
    if ! /usr/bin/flock -n "$probe_fd"; then
      exec "$real_command" "$@"
    fi
    /usr/bin/flock -u "$probe_fd"
    exec {probe_fd}>&-
  fi
fi

shopt -u varredir_close 2>/dev/null || true
exec {slot_fd}>>"$lock_path"

if ! /usr/bin/flock -n "$slot_fd"; then
  wait_timeout=${DEVBOX_HEAVY_JOB_WAIT_TIMEOUT_SEC:-1800}
  warn_after=${DEVBOX_HEAVY_JOB_WARN_AFTER_SEC:-5}
  waiter_pid=
  warning_pid=
  stop_warning() {
    [[ -n "$warning_pid" ]] || return 0
    kill -TERM "$warning_pid" 2>/dev/null || true
    wait "$warning_pid" 2>/dev/null || true
    warning_pid=
  }
  stop_waiter() {
    [[ -z "$waiter_pid" ]] || kill -TERM "$waiter_pid" 2>/dev/null || true
    stop_warning
    exit 143
  }
  trap stop_waiter HUP INT TERM
  if (( warn_after == 0 )); then
    echo "devbox: waiting for the shared heavy-job slot ($command_name $*)" >&2
  else
    (sleep "$warn_after"; echo "devbox: waiting for the shared heavy-job slot ($command_name $*)" >&2) &
    warning_pid=$!
  fi
  if (( wait_timeout == 0 )); then
    /usr/bin/flock "$slot_fd" &
  else
    /usr/bin/flock -w "$wait_timeout" "$slot_fd" &
  fi
  waiter_pid=$!
  set +e
  wait "$waiter_pid"
  wait_status=$?
  set -e
  waiter_pid=
  stop_warning
  trap - HUP INT TERM
  if [[ $wait_status -ne 0 ]]; then
    echo "devbox: timed out waiting for the shared heavy-job slot after ${wait_timeout}s ($command_name $*)" >&2
    exit 75
  fi
  echo "devbox: acquired the shared heavy-job slot" >&2
fi

DEVBOX_HEAVY_JOB_OWNER_START=$(process_start_time "$$")
export DEVBOX_HEAVY_JOB_FD=$slot_fd
export DEVBOX_HEAVY_JOB_OWNER_PID=$$
export DEVBOX_HEAVY_JOB_OWNER_START
export DEVBOX_HEAVY_JOB_OWNER_FD=$slot_fd
exec "$real_command" "$@"
