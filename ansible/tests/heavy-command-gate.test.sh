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

reset_counter
timeout 3 bun run build:nested
[[ $(cat "$tmp/active") == 0 ]] || fail "nested heavy command leaked active state"

set +e
bun run build:fail
failure_status=$?
set -e
[[ $failure_status -eq 42 ]] || fail "child exit status was not preserved"
timeout 3 bun run build

echo "heavy command gate: PASS"
