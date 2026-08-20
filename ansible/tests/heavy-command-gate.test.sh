#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
gate=${1:-"$repo_root/scripts/devbox-heavy-command.sh"}

fail() {
  echo "heavy command gate: FAIL: $*" >&2
  exit 1
}

[[ -x "$gate" ]] || fail "missing executable $gate"

if ! command -v flock >/dev/null 2>&1; then
  echo "heavy command gate: SKIP (flock is unavailable on this platform)"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/gate-bin" "$tmp/real-bin" "$tmp/runtime"
chmod 700 "$tmp/runtime"

for command_name in bun node; do
  ln -s "$gate" "$tmp/gate-bin/$command_name"
done

cat >"$tmp/real-bin/fake-command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

state_dir=${DEVBOX_GATE_TEST_STATE:?}
exec 8>>"$state_dir/counter.lock"
flock 8
active=$(cat "$state_dir/active" 2>/dev/null || echo 0)
active=$((active + 1))
printf '%s\n' "$active" >"$state_dir/active"
maximum=$(cat "$state_dir/maximum" 2>/dev/null || echo 0)
if (( active > maximum )); then
  printf '%s\n' "$active" >"$state_dir/maximum"
fi
flock -u 8

if [[ " $* " == *" build:nested "* ]]; then
  # Node/Bun subprocess launchers can close non-stdio descriptors. The parent still
  # owns the slot, so a nested shim must validate that ancestor instead of deadlocking.
  (
    inherited_fd=${DEVBOX_HEAVY_JOB_FD:?}
    eval "exec ${inherited_fd}>&-"
    bun ./scripts/generate-declarations.ts
  )
else
  sleep "${DEVBOX_GATE_TEST_SLEEP:-0.35}"
fi

flock 8
active=$(cat "$state_dir/active")
printf '%s\n' "$((active - 1))" >"$state_dir/active"
flock -u 8

[[ " $* " != *" build:fail "* ]] || exit 42
EOF
chmod 755 "$tmp/real-bin/fake-command"
ln -s fake-command "$tmp/real-bin/bun"
ln -s fake-command "$tmp/real-bin/node"

export PATH="$tmp/gate-bin:$tmp/real-bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="$tmp/runtime"
export DEVBOX_GATE_TEST_STATE="$tmp"

reset_counter() {
  printf '0\n' >"$tmp/active"
  printf '0\n' >"$tmp/maximum"
}

reset_counter
export DEVBOX_HEAVY_JOB_WARN_AFTER_SEC=0
bun run build >"$tmp/heavy-a.out" 2>"$tmp/heavy-a.err" &
heavy_a=$!
node node_modules/typescript/bin/tsc >"$tmp/heavy-b.out" 2>"$tmp/heavy-b.err" &
heavy_b=$!
wait "$heavy_a"
wait "$heavy_b"
[[ $(cat "$tmp/maximum") == 1 ]] || fail "heavy commands overlapped"
grep -q "waiting for the shared heavy-job slot" "$tmp/heavy-a.err" "$tmp/heavy-b.err" \
  || fail "queued command did not explain why it was waiting"

reset_counter
export DEVBOX_HEAVY_JOB_CATEGORIES=build,typecheck,generate
bun run test &
category_a=$!
bun run test &
category_b=$!
wait "$category_a"
wait "$category_b"
[[ $(cat "$tmp/maximum") == 2 ]] || fail "disabled test category was serialized"
unset DEVBOX_HEAVY_JOB_CATEGORIES

reset_counter
export DEVBOX_HEAVY_JOB_CATEGORIES=
bun run build &
empty_categories_a=$!
bun run build &
empty_categories_b=$!
wait "$empty_categories_a"
wait "$empty_categories_b"
[[ $(cat "$tmp/maximum") == 2 ]] || fail "an explicitly empty category set fell back to all categories"
unset DEVBOX_HEAVY_JOB_CATEGORIES

reset_counter
export DEVBOX_GATE_TEST_SLEEP=2
bun run build &
timeout_holder=$!
for _ in $(seq 1 50); do
  [[ $(cat "$tmp/active") == 1 ]] && break
  sleep 0.02
done
[[ $(cat "$tmp/active") == 1 ]] || fail "timeout holder did not acquire the slot"
set +e
DEVBOX_HEAVY_JOB_WAIT_TIMEOUT_SEC=1 DEVBOX_HEAVY_JOB_WARN_AFTER_SEC=0 \
  bun run build >"$tmp/timeout.out" 2>"$tmp/timeout.err"
timeout_status=$?
set -e
[[ $timeout_status -eq 75 ]] || fail "wait timeout did not exit 75 (got $timeout_status)"
grep -q "timed out waiting for the shared heavy-job slot" "$tmp/timeout.err" \
  || fail "wait timeout did not explain the failure"
wait "$timeout_holder"
unset DEVBOX_GATE_TEST_SLEEP

reset_counter
bun --version &
light_a=$!
node --version &
light_b=$!
wait "$light_a"
wait "$light_b"
[[ $(cat "$tmp/maximum") == 2 ]] || fail "light commands were serialized"

# A direct `tsc` is the heaviest thing an agent runs and the only one mise does not
# shadow on PATH, so it is the one command that always reached the gate. It was also
# the one the gate declined: its case arm set a status the function then discarded by
# ending in `return 1`, so every direct tsc ran unqueued.
reset_counter
ln -s fake-command "$tmp/real-bin/tsc"
ln -s "$gate" "$tmp/gate-bin/tsc"
export DEVBOX_GATE_TEST_SLEEP=0.35
tsc --noEmit &
serial_a=$!
tsc --noEmit &
serial_b=$!
wait "$serial_a"
wait "$serial_b"
unset DEVBOX_GATE_TEST_SLEEP
[[ $(cat "$tmp/maximum") == 1 ]] || fail "two direct tsc runs overlapped"

reset_counter
timeout 3 bun run build:nested
[[ $(cat "$tmp/active") == 0 ]] || fail "nested heavy command leaked active state"

set +e
bun run build:fail
failure_status=$?
set -e
[[ $failure_status -eq 42 ]] || fail "child exit status was not preserved"
timeout 3 bun run build

# The lock bounds how many heavy jobs run; it never bounded how large one gets. These
# cover the ceiling that does: a scope of the job's own, so a runaway compiler dies
# alone instead of throttling the agent host that serves every session.
reset_counter
cat >"$tmp/real-bin/scope-probe" <<'EOF'
#!/usr/bin/env bash
own_cgroup=$(cut -d: -f3 /proc/self/cgroup)
printf '%s\n' "$own_cgroup"
printf 'GOMEMLIMIT=%s\n' "${GOMEMLIMIT-unset}"
# Read the ceiling from inside, while the scope is still alive: --collect removes the
# unit the moment this process exits, so the caller cannot read it afterwards.
printf 'MEMMAX=%s\n' "$(cat "/sys/fs/cgroup${own_cgroup}/memory.max" 2>/dev/null || echo unknown)"
[[ " $* " != *" probe:fail "* ]] || exit 42
EOF
chmod 755 "$tmp/real-bin/scope-probe"
ln -s scope-probe "$tmp/real-bin/next"
ln -s "$gate" "$tmp/gate-bin/next"

# The harness points XDG_RUNTIME_DIR at a private directory so the lock stays hermetic,
# which also hides the user bus systemd-run needs. Link the real socket in rather than
# giving the lock back to the box: an ssh session's own cgroup is already a *.scope, so
# the ambient cgroup is captured here to compare against instead of matching on ".scope".
real_runtime=${DEVBOX_GATE_TEST_REAL_RUNTIME:-/run/user/$(id -u)}
mkdir -p "$tmp/runtime/systemd"
for sock in bus systemd/private; do
  [[ -S "$real_runtime/$sock" && ! -e "$tmp/runtime/$sock" ]] &&
    ln -s "$real_runtime/$sock" "$tmp/runtime/$sock"
done
ambient_cgroup=$(cut -d: -f3 /proc/self/cgroup)

if command -v systemd-run >/dev/null 2>&1 &&
   systemd-run --user --scope --quiet --collect /bin/true >/dev/null 2>&1; then
  scope_out=$(DEVBOX_HEAVY_JOB_MEMORY_MAX=1G next build 2>/dev/null)
  scope_cgroup=$(printf '%s\n' "$scope_out" | head -1)
  [[ "$scope_cgroup" != "$ambient_cgroup" ]] \
    || fail "gated job stayed in the ambient cgroup: $scope_cgroup"
  [[ "$scope_cgroup" == *.scope ]] \
    || fail "gated job did not run inside its own scope: $scope_cgroup"
  [[ "$scope_out" == *"GOMEMLIMIT=1G"* ]] \
    || fail "gated job did not receive GOMEMLIMIT: $scope_out"

  # A scope that does not actually carry the ceiling is theatre.
  [[ "$scope_out" == *"MEMMAX=1073741824"* ]] \
    || fail "scope carried no ceiling: $scope_out"

  # systemd-run exits 1 when it cannot reach a user manager, so the status can never be
  # read as "the scope failed to start". The child's own status must arrive intact.
  set +e
  DEVBOX_HEAVY_JOB_MEMORY_MAX=1G next build probe:fail >/dev/null 2>&1
  scoped_failure=$?
  set -e
  [[ $scoped_failure -eq 42 ]] \
    || fail "scoped child exit status was not preserved (got $scoped_failure)"

  # The slot is held by an inherited descriptor. Wrapping the job in a scope must not
  # break the reentrancy that lets a nested heavy command through.
  reset_counter
  DEVBOX_HEAVY_JOB_MEMORY_MAX=1G timeout 5 bun run build:nested
  [[ $(cat "$tmp/active") == 0 ]] || fail "scoped nested heavy command leaked active state"

  echo "heavy command gate: scope containment OK"
else
  echo "heavy command gate: SKIP scope containment (no reachable systemd user manager)"
fi

# Fail open: an unreachable user manager must still run the command, just unscoped.
# A runtime dir the gate can still take its lock in, but with no manager socket in it —
# pointing XDG_RUNTIME_DIR at an unwritable path would break the lock, not the bus.
mkdir -p "$tmp/nobus"
scope_out=$(
  XDG_RUNTIME_DIR="$tmp/nobus" DBUS_SESSION_BUS_ADDRESS= \
    DEVBOX_HEAVY_JOB_MEMORY_MAX=1G next build 2>/dev/null
) || fail "gate did not fail open without a reachable user manager"
[[ "$(printf '%s\n' "$scope_out" | head -1)" == "$ambient_cgroup" ]] \
  || fail "expected an unscoped run without a user manager, got $scope_out"

# No ceiling configured is the untouched path: no scope, and no GOMEMLIMIT invented.
scope_out=$(next build 2>/dev/null) || fail "gate did not run without a ceiling"
[[ "$scope_out" == *"GOMEMLIMIT=unset"* ]] \
  || fail "gate invented a GOMEMLIMIT with no ceiling configured: $scope_out"

echo "heavy command gate: PASS"
