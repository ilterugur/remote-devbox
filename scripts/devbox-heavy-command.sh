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
      # The `return 0` is load-bearing: the case only sets a status, and the function
      # ends in `return 1`, so without it every direct tsc fell through as "not heavy".
      category_enabled typecheck && return 0
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

runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
lock_dir="$runtime_dir/agent-devbox"
lock_path="$lock_dir/heavy-job.lock"
scope_marker_path="$lock_dir/heavy-job.scope"
scope_bootstrap_arg=--devbox-heavy-job-scope-bootstrap-v1

current_cgroup_identity() {
  local _hierarchy _controllers cgroup cgroup_inode
  IFS=: read -r _hierarchy _controllers cgroup < /proc/self/cgroup || return 1
  [[ -n "$cgroup" ]] || return 1
  cgroup_inode=$(stat -Lc '%d:%i' "/sys/fs/cgroup$cgroup") || return 1
  printf '%s\t%s\n' "$cgroup" "$cgroup_inode"
}

# systemd-run starts this script inside the bounded scope before the real command. The
# marker survives environment filtering by task runners such as Turbo; its cgroup inode
# prevents a stale file or a reused unit name from granting reentry to unrelated work.
if [[ "$command_name" == "$(basename "$script_path")" &&
      "${1:-}" == "$scope_bootstrap_arg" ]]; then
  shift
  [[ $# -gt 0 ]] || exit 64
  umask 077
  mkdir -p "$lock_dir"
  IFS=$'\t' read -r scope_cgroup scope_inode < <(current_cgroup_identity)
  marker_tmp="${scope_marker_path}.$$"
  cleanup_scope_marker() {
    local marked_cgroup= marked_inode=
    rm -f -- "$marker_tmp"
    if [[ -r "$scope_marker_path" ]]; then
      IFS=$'\t' read -r marked_cgroup marked_inode < "$scope_marker_path" || true
      if [[ "$marked_cgroup" == "$scope_cgroup" && "$marked_inode" == "$scope_inode" ]]; then
        rm -f -- "$scope_marker_path"
      fi
    fi
  }
  trap cleanup_scope_marker EXIT
  printf '%s\t%s\n' "$scope_cgroup" "$scope_inode" >"$marker_tmp"
  mv -f -- "$marker_tmp" "$scope_marker_path"
  set +e
  "$@"
  command_status=$?
  set -e
  exit "$command_status"
fi


real_command=$(resolve_real_command) || {
  echo "devbox: cannot resolve the real '$command_name' outside $gate_dir" >&2
  exit 127
}

real_command_argv=("$real_command")
bun_kill_guard=${DEVBOX_BUN_KILL_GUARD:-}
if [[ "$command_name" == bun && -n "$bun_kill_guard" && -r "$bun_kill_guard" ]]; then
  real_command_argv+=(--preload "$bun_kill_guard")
fi

if ! is_heavy_command "$@"; then
  exec "${real_command_argv[@]}" "$@"
fi

umask 077
mkdir -p "$lock_dir"

# Turbo strict mode deliberately removes arbitrary DEVBOX_* variables. If this process
# is still in the exact bounded scope registered by the lock owner, it is nested work
# from that job and must not wait on its own lock. Different cgroups still serialize.
if [[ -r "$scope_marker_path" ]]; then
  marked_cgroup=
  marked_inode=
  current_cgroup=
  current_inode=
  IFS=$'\t' read -r marked_cgroup marked_inode < "$scope_marker_path" || true
  IFS=$'\t' read -r current_cgroup current_inode < <(current_cgroup_identity) || true
  if [[ -n "$marked_cgroup" &&
        "$marked_cgroup" == "$current_cgroup" &&
        "$marked_inode" == "$current_inode" ]]; then
    exec "${real_command_argv[@]}" "$@"
  fi
fi

# A nested command may legitimately resolve through the shim again. Accept the
# inherited descriptor only when it points at this exact lock and still owns it.
inherited_fd=${DEVBOX_HEAVY_JOB_FD:-}
if [[ "$inherited_fd" =~ ^[0-9]+$ && -e "/proc/$$/fd/$inherited_fd" ]]; then
  inherited_path=$(readlink -f "/proc/$$/fd/$inherited_fd" 2>/dev/null || true)
  if [[ "$inherited_path" == "$lock_path" ]] && /usr/bin/flock -n "$inherited_fd"; then
    exec "${real_command_argv[@]}" "$@"
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
      exec "${real_command_argv[@]}" "$@"
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

# The lock bounds how MANY heavy jobs run at once; it says nothing about how large
# one gets. Measured 2026-08-20: a single tsc reached 14.4G inside an agent host with
# a 15G budget. Nothing died — MemoryHigh throttles rather than kills — so the whole
# cgroup stalled 73% of the time at ~3100 throttle events a second, its sockets were
# refused memory 74k times, and every live session on that host dropped. A scope of
# its own makes the runaway the only casualty.
# An unset budget used to mean "unbounded". That is only ever reached when a process
# tree escaped provisioning: the role templates inject this via Environment=, so a
# daemon started by hand from another user's SSH session hands its whole agent fleet a
# gate with no ceiling. Measured 2026-08-31: three host-wide stalls in ninety minutes,
# each one `bun tsc --noEmit` in a Paseo worktree reaching 25-33G RSS. The gate
# recognised every one as heavy and serialised it, then ran it unbounded. The kernel's
# global OOM killer took unrelated sessions down instead. Default the wall, so an
# unprovisioned caller is contained too; `infinity` stays the explicit opt-out.
memory_max=${DEVBOX_HEAVY_JOB_MEMORY_MAX:-8G}
if [[ "$memory_max" == infinity ]]; then
  memory_max=
fi

# systemd parses 8G; Go does not. Verified 2026-08-31: GOMEMLIMIT=8G aborts every Go
# binary with "fatal error: malformed GOMEMLIMIT", so passing the systemd spelling
# straight through turned this hint into an instant kill for the TypeScript 7 compiler
# it was added to bound. Go wants the IEC spelling.
go_mem_limit() {
  case "$1" in
    *KiB | *MiB | *GiB | *TiB | *B) printf '%s\n' "$1" ;;
    *[Kk]) printf '%sKiB\n' "${1%?}" ;;
    *[Mm]) printf '%sMiB\n' "${1%?}" ;;
    *[Gg]) printf '%sGiB\n' "${1%?}" ;;
    *[Tt]) printf '%sTiB\n' "${1%?}" ;;
    *[0-9]) printf '%sB\n' "$1" ;;
    *) return 1 ;;
  esac
}

# The TypeScript 7 compiler is a statically linked Go binary, so --max-old-space-size
# cannot reach it; GOMEMLIMIT is the knob that makes its GC work instead of balloon.
# Bun reads neither, which is why the scope below is the wall and this is only a hint:
# the runaways measured above were all `bun tsc`, and nothing short of the cgroup
# stopped them.
if [[ -n "$memory_max" ]]; then
  if go_hint=$(go_mem_limit "$memory_max"); then
    export GOMEMLIMIT="${GOMEMLIMIT:-$go_hint}"
  fi
fi

# Fail open, and decide that BEFORE running anything. systemd-run exits 1 when it
# cannot reach a user manager — indistinguishable from a command that legitimately
# exited 1 — so the exit status can never be used to detect "the scope did not start".
# The caller's status has to survive untouched: the suite pins a child exit of 42, and
# an agent reads a build's status to decide what to do next.
# `systemd-run --user` reaches the manager over its local transport — the private socket
# below — and ignores DBUS_SESSION_BUS_ADDRESS entirely (verified: with only the session
# bus linked it still fails "user scope bus via local transport"). Test the exact socket
# it connects to, and keep the test strict on purpose: a false negative only costs an
# unscoped run, while a false positive would hand systemd-run's own exit 1 back to the
# caller as if the command had failed.
scope_available() {
  [[ -n "$memory_max" ]] || return 1
  command -v systemd-run >/dev/null 2>&1 || return 1
  # The runtime directory must be KNOWN, not guessed. Defaulting it to /run/user/$(id -u)
  # inverted this function: measured 2026-09-05, with XDG_RUNTIME_DIR unset and the
  # logged-in user's /run/user/1004/systemd/private present, the check passed and
  # systemd-run then aborted with "$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not
  # defined" — so a build launched from a stripped environment (a task runner that
  # filters env, cron, `sudo` without the variable) did not run unscoped, it did not run
  # at all. systemd-run --user reaches the manager over that socket AND needs the
  # variable to find it, so the only safe test is that both are actually there.
  [[ -n "${XDG_RUNTIME_DIR:-}" && -S "${XDG_RUNTIME_DIR}/systemd/private" ]]
}

if scope_available; then
  exec systemd-run --user --scope --quiet --collect \
    -p "MemoryMax=$memory_max" \
    -p "MemorySwapMax=0" \
    -p "OOMPolicy=continue" \
    -- "$script_path" "$scope_bootstrap_arg" "${real_command_argv[@]}" "$@"
fi

exec "${real_command_argv[@]}" "$@"
