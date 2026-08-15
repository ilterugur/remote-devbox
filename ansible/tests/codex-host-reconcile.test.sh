#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
reconcile="$repo_root/scripts/codex-host-reconcile.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DEVBOX_TEST_SYSTEMCTL_LOG"
case " $* " in
  *" is-active "*) exit "${DEVBOX_TEST_SERVICE_ACTIVE:-1}" ;;
esac
SH

cat >"$fake_bin/fuser" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DEVBOX_TEST_FUSER_LOG"
exit "${DEVBOX_TEST_SOCKET_OWNED:-1}"
SH

chmod +x "$fake_bin/systemctl" "$fake_bin/fuser"

make_socket() {
  python3 - "$1" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.close()
PY
}

run_reconcile() {
  local active=$1
  local owned=$2
  local changed=$3
  local socket=$4
  local case_dir=$5

  mkdir -p "$case_dir"
  : >"$case_dir/systemctl.log"
  : >"$case_dir/fuser.log"

  set +e
  PATH="$fake_bin:$PATH" \
    DEVBOX_TEST_SYSTEMCTL_LOG="$case_dir/systemctl.log" \
    DEVBOX_TEST_FUSER_LOG="$case_dir/fuser.log" \
    DEVBOX_TEST_SERVICE_ACTIVE="$active" \
    DEVBOX_TEST_SOCKET_OWNED="$owned" \
    "$reconcile" dev-a "$socket" "$changed" 15G 16G 1G >"$case_dir/stdout" 2>"$case_dir/stderr"
  RECONCILE_STATUS=$?
  set -e
}

assert_not_contains() {
  local needle=$1
  local file=$2
  if grep -Fq -- "$needle" "$file"; then
    printf 'unexpected %q in %s\n' "$needle" "$file" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_contains() {
  local needle=$1
  local file=$2
  if ! grep -Fq -- "$needle" "$file"; then
    printf 'missing %q in %s\n' "$needle" "$file" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_status() {
  local expected=$1
  local case_dir=$2
  if [ "$RECONCILE_STATUS" -ne "$expected" ]; then
    printf 'expected status %s, got %s\n' "$expected" "$RECONCILE_STATUS" >&2
    cat "$case_dir/stderr" >&2
    exit 1
  fi
}

# A normal apply may update the unit on disk, but it must not interrupt a live host.
active_dir="$test_root/active"
run_reconcile 0 1 true "$test_root/active.sock" "$active_dir"
assert_status 0 "$active_dir"
assert_contains "set-property --runtime codex-code-mode-host.service ManagedOOMPreference=omit MemoryHigh=15G MemoryMax=16G MemorySwapMax=1G" "$active_dir/systemctl.log"
assert_contains "restart deferred" "$active_dir/stdout"
assert_not_contains " restart " "$active_dir/systemctl.log"
assert_not_contains " start " "$active_dir/systemctl.log"
test ! -s "$active_dir/fuser.log"

# An existing socket is an active or unknown session boundary. Reconciliation must
# never unlink it: fuser cannot distinguish "unowned" from every inspection error,
# and a check followed by rm has a race with a new host binding the same path.
for owner_status in 0 1 2; do
  socket="$test_root/existing-$owner_status.sock"
  make_socket "$socket"
  case_dir="$test_root/existing-$owner_status"
  run_reconcile 1 "$owner_status" true "$socket" "$case_dir"
  assert_status 75 "$case_dir"
  test -S "$socket"
  assert_contains "refusing takeover" "$case_dir/stderr"
  assert_not_contains " enable " "$case_dir/systemctl.log"
  assert_not_contains " start " "$case_dir/systemctl.log"
  test ! -s "$case_dir/fuser.log"
done

# A clean first start needs no socket cleanup.
clean_dir="$test_root/clean"
run_reconcile 1 1 false "$test_root/missing.sock" "$clean_dir"
assert_status 0 "$clean_dir"
assert_contains " start codex-code-mode-host.service" "$clean_dir/systemctl.log"
test ! -s "$clean_dir/fuser.log"

printf 'codex host reconcile: PASS\n'
