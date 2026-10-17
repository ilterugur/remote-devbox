#!/usr/bin/env bash
# Managed by Ansible (remote-devbox).
#
# PATH shim for commands that can consume most of a developer's memory budget.
# Every agent owned by the same Linux user shares a small pool of kernel flocks (the
# per-user count in /etc/agent-devbox/heavy-gate-slots, default 1), so unrelated light
# commands remain concurrent while build/typecheck/generate/test jobs queue for a slot.
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

heavy_category=

mark_heavy() {
  category_enabled "$1" || return 1
  heavy_category=$1
}

classify_heavy_token() {
  case "$1" in
    build | build:* | *:build | *:build:*) mark_heavy build ;;
    typecheck | typecheck:* | *:typecheck | *:typecheck:*) mark_heavy typecheck ;;
    generate | generate:* | *:generate | *:generate:*) mark_heavy generate ;;
    test | test:* | *:test | *:test:*) mark_heavy test ;;
    *) return 1 ;;
  esac
}

classify_heavy_path() {
  case "${1##*/}" in
    generate-declarations.ts) mark_heavy generate ;;
    typecheck-partitions.ts | tsc | tsc.js) mark_heavy typecheck ;;
    *) return 1 ;;
  esac
}

classify_heavy_command() {
  local arg
  case "$command_name" in
    tsc)
      mark_heavy typecheck && return 0
      ;;
    bun | npm | pnpm | yarn)
      for arg in "$@"; do
        classify_heavy_token "$arg" && return 0
        classify_heavy_path "$arg" && return 0
      done
      ;;
    bunx | npx)
      for arg in "$@"; do
        case "${arg##*/}" in
          tsc) mark_heavy typecheck && return 0 ;;
          turbo | next) mark_heavy build && return 0 ;;
          prisma) mark_heavy generate && return 0 ;;
        esac
        classify_heavy_token "$arg" && return 0
        classify_heavy_path "$arg" && return 0
      done
      ;;
    node)
      for arg in "$@"; do
        case "$arg" in
          */typescript/bin/tsc | */typescript/lib/tsc.js) mark_heavy typecheck && return 0 ;;
          */next/dist/bin/next | */turbo/bin/turbo) mark_heavy build && return 0 ;;
          */prisma/build/index.js) mark_heavy generate && return 0 ;;
        esac
        classify_heavy_path "$arg" && return 0
      done
      ;;
    turbo)
      for arg in "$@"; do
        classify_heavy_token "$arg" && return 0
      done
      ;;
    next)
      [[ " ${*} " == *" build "* ]] && mark_heavy build && return 0
      ;;
    prisma)
      [[ " ${*} " == *" generate "* ]] && mark_heavy generate && return 0
      ;;
    cargo)
      # The first positional argument is the subcommand. Skip a `+toolchain` and the
      # global options that take a separate value; `cargo run` stays light because it
      # is how dev servers start, and a server must never hold a slot for hours.
      local skip_next=false
      for arg in "$@"; do
        if [[ "$skip_next" == true ]]; then
          skip_next=false
          continue
        fi
        case "$arg" in
          -C | -Z | --config | --color | --manifest-path) skip_next=true ;;
          -* | +*) ;;
          build | b | install | doc | bench) mark_heavy build && return 0; return 1 ;;
          test | t | nextest) mark_heavy test && return 0; return 1 ;;
          check | c | clippy) mark_heavy typecheck && return 0; return 1 ;;
          *) return 1 ;;
        esac
      done
      ;;
  esac
  return 1
}

runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
lock_dir="$runtime_dir/agent-devbox"
scope_bootstrap_arg=--devbox-heavy-job-scope-bootstrap-v1
# Every gated scope lands in this user slice. Ansible writes it as a unit whose
# MemoryMax is the developer's total_memory_max: the wall shared by all concurrent heavy
# jobs, while each scope keeps its own per-job MemoryMax. Without the unit file systemd
# creates the slice on demand with no limit, which is the old one-wall-per-job behaviour.
# An underscore, not a dash: systemd reads `a-b.slice` as a child of `a.slice`, which would
# hide this slice's CPUWeight behind an unweighted parent instead of setting it against the
# agent fleet's app.slice.
heavy_slice=devbox_heavy.slice

# The slot count is read from a root-owned file at every invocation rather than from the
# environment, so changing it reaches an already-running agent fleet: a daemon keeps the
# environment it started with until it restarts, and restarting it drops every session.
# One `user count` pair per line; an unlisted user or a missing file means one slot.
slots=1
slots_file=${DEVBOX_HEAVY_GATE_SLOTS_FILE:-/etc/agent-devbox/heavy-gate-slots}
if [[ -r "$slots_file" ]]; then
  slots_user=${USER:-$(id -un)}
  while read -r listed_user listed_slots || [[ -n "${listed_user:-}" ]]; do
    if [[ "$listed_user" == "$slots_user" ]]; then
      slots=$listed_slots
      break
    fi
  done < "$slots_file"
fi
[[ "$slots" =~ ^[1-9][0-9]*$ ]] || slots=1

canonical_lock_dir() {
  umask 077
  mkdir -p "$lock_dir"
  lock_dir=$(cd "$lock_dir" && pwd -P)
}

# Slot 0 keeps the historical name, so a script an agent wrapped in a hand-written
# `flock .../heavy-job.lock` still occupies a slot instead of running beside the pool.
slot_lock_path() {
  if (( $1 == 0 )); then
    printf '%s/heavy-job.lock\n' "$lock_dir"
  else
    printf '%s/heavy-job.%s.lock\n' "$lock_dir" "$1"
  fi
}

current_cgroup_identity() {
  local _hierarchy _controllers cgroup cgroup_inode
  IFS=: read -r _hierarchy _controllers cgroup < /proc/self/cgroup || return 1
  [[ -n "$cgroup" ]] || return 1
  cgroup_inode=$(stat -Lc '%d-%i' "/sys/fs/cgroup$cgroup") || return 1
  printf '%s\t%s\n' "$cgroup" "$cgroup_inode"
}

# One marker per live scope, named by its cgroup inode and holding its path. Several
# scopes now run at once, so a single shared marker would let the last writer win.
scope_marker_path() {
  printf '%s/heavy-job.scope.%s\n' "$lock_dir" "$1"
}

# systemd-run starts this script inside the bounded scope before the real command. The
# marker survives environment filtering by task runners such as Turbo; its cgroup inode
# prevents a stale file or a reused unit name from granting reentry to unrelated work.
if [[ "$command_name" == "$(basename "$script_path")" &&
      "${1:-}" == "$scope_bootstrap_arg" ]]; then
  shift
  [[ $# -gt 0 ]] || exit 64
  canonical_lock_dir
  IFS=$'\t' read -r scope_cgroup scope_inode < <(current_cgroup_identity)
  marker=$(scope_marker_path "$scope_inode")
  trap 'rm -f -- "$marker" "$marker.$$"' EXIT
  printf '%s\n' "$scope_cgroup" >"$marker.$$"
  mv -f -- "$marker.$$" "$marker"
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

if ! classify_heavy_command "$@"; then
  exec "${real_command_argv[@]}" "$@"
fi

canonical_lock_dir

# Turbo strict mode deliberately removes arbitrary DEVBOX_* variables. If this process
# is still inside a bounded scope the gate registered, it is nested work from that job
# and must not wait for a slot of its own. Different cgroups still queue.
if IFS=$'\t' read -r current_cgroup current_inode < <(current_cgroup_identity); then
  marker=$(scope_marker_path "$current_inode")
  if [[ -r "$marker" && "$(<"$marker")" == "$current_cgroup" ]]; then
    exec "${real_command_argv[@]}" "$@"
  fi
fi

# A slot held by this process or one of its ancestors means this command is part of
# that job: a descriptor inherited from the gate, a runtime that closed it in a child
# while the parent still holds it, or a script wrapped in a hand-written `flock` on a
# slot file. Taking a second slot would deadlock at slots=1 and double-count otherwise,
# so the command runs under the held one — still inside a scope of its own below.
# The probe proves the descriptor's lock is really held; an fd left open on a free slot
# file grants nothing.
slot_held_by_ancestor() {
  local pid=$$ key value target probe_fd
  while [[ "$pid" -gt 1 && -d "/proc/$pid" ]]; do
    while IFS= read -r target; do
      [[ -n "$target" ]] || continue
      exec {probe_fd}>>"$target"
      if /usr/bin/flock -n "$probe_fd"; then
        /usr/bin/flock -u "$probe_fd"
        exec {probe_fd}>&-
      else
        exec {probe_fd}>&-
        return 0
      fi
    done < <(find "/proc/$pid/fd" -maxdepth 1 \( -lname "$lock_dir/heavy-job.lock" -o \
               -lname "$lock_dir/heavy-job.[0-9]*.lock" \) -printf '%l\n' 2>/dev/null)
    value=
    while IFS=$':\t ' read -r key value; do
      [[ "$key" == PPid ]] && break
    done < "/proc/$pid/status" 2>/dev/null || true
    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    pid=$value
  done
  return 1
}

shopt -u varredir_close 2>/dev/null || true
slot_fd=
try_take_slot() {
  local index path fd
  for ((index = 0; index < slots; index++)); do
    path=$(slot_lock_path "$index")
    exec {fd}>>"$path"
    if /usr/bin/flock -n "$fd"; then
      slot_fd=$fd
      return 0
    fi
    exec {fd}>&-
  done
  return 1
}

# Waiting polls the pool instead of blocking on one file: with several slots there is no
# single descriptor to sleep on, and a second's latency is nothing next to a build.
if ! slot_held_by_ancestor && ! try_take_slot; then
  wait_timeout=${DEVBOX_HEAVY_JOB_WAIT_TIMEOUT_SEC:-1800}
  warn_after=${DEVBOX_HEAVY_JOB_WARN_AFTER_SEC:-5}
  waiting_message="devbox: waiting for the shared heavy-job slot ($command_name $*)"
  trap 'exit 143' HUP INT TERM
  wait_started=$SECONDS
  warned=false
  if (( warn_after == 0 )); then
    echo "$waiting_message" >&2
    warned=true
  fi
  until try_take_slot; do
    waited=$((SECONDS - wait_started))
    if (( wait_timeout > 0 && waited >= wait_timeout )); then
      echo "devbox: timed out waiting for the shared heavy-job slot after ${wait_timeout}s ($command_name $*)" >&2
      exit 75
    fi
    if [[ "$warned" == false ]] && (( waited >= warn_after )); then
      echo "$waiting_message" >&2
      warned=true
    fi
    sleep 1
  done
  trap - HUP INT TERM
  echo "devbox: acquired the shared heavy-job slot" >&2
fi

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
category_limit_var="DEVBOX_HEAVY_JOB_MEMORY_MAX_${heavy_category^^}"
memory_max=${!category_limit_var:-$memory_max}
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
  exec systemd-run --user --scope --quiet --collect --slice="$heavy_slice" \
    -p "MemoryMax=$memory_max" \
    -p "MemorySwapMax=0" \
    -p "OOMPolicy=continue" \
    -- "$script_path" "$scope_bootstrap_arg" "${real_command_argv[@]}" "$@"
fi

exec "${real_command_argv[@]}" "$@"
