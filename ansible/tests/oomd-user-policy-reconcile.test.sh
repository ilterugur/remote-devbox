#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
reconcile="$repo_root/scripts/oomd-user-policy-reconcile.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DEVBOX_TEST_SYSTEMCTL_LOG"
SH
chmod +x "$fake_bin/systemctl"

run_reconcile() {
  : >"$test_root/systemctl.log"
  PATH="$fake_bin:$PATH" \
    DEVBOX_TEST_SYSTEMCTL_LOG="$test_root/systemctl.log" \
    "$reconcile" "$@"
}

assert_line() {
  local line=$1
  if ! grep -Fxq -- "$line" "$test_root/systemctl.log"; then
    printf 'missing exact command: %s\n' "$line" >&2
    cat "$test_root/systemctl.log" >&2
    exit 1
  fi
}

assert_order() {
  local first=$1
  local second=$2
  test "$(grep -Fn -- "$first" "$test_root/systemctl.log" | cut -d: -f1)" -lt \
    "$(grep -Fn -- "$second" "$test_root/systemctl.log" | cut -d: -f1)"
}

slice_auto='set-property user-1004.slice ManagedOOMSwap=auto ManagedOOMMemoryPressure=auto ManagedOOMMemoryPressureLimit=0% ManagedOOMMemoryPressureDurationSec='
manager_kill='set-property user@1004.service ManagedOOMSwap=auto ManagedOOMMemoryPressure=kill ManagedOOMMemoryPressureLimit=60% ManagedOOMMemoryPressureDurationSec=20s'
manager_auto='set-property user@1004.service ManagedOOMSwap=auto ManagedOOMMemoryPressure=auto ManagedOOMMemoryPressureLimit=0% ManagedOOMMemoryPressureDurationSec='

# Enabling must neutralize the root-owned ancestor before arming pressure monitoring
# on the same-owner user manager where Codex's omit preference is respected.
run_reconcile 1004 true 60% 20
assert_line "$slice_auto"
assert_line "$manager_kill"
assert_order "$slice_auto" "$manager_kill"
test "$(wc -l <"$test_root/systemctl.log" | tr -d ' ')" = 2

# Disabling must clear both possible runtime policy locations.
run_reconcile 1004 false 60% 20
assert_line "$slice_auto"
assert_line "$manager_auto"
assert_order "$slice_auto" "$manager_auto"
test "$(wc -l <"$test_root/systemctl.log" | tr -d ' ')" = 2

# Malformed input must fail before systemctl can mutate either boundary.
: >"$test_root/systemctl.log"
if PATH="$fake_bin:$PATH" DEVBOX_TEST_SYSTEMCTL_LOG="$test_root/systemctl.log" \
  "$reconcile" not-a-uid true 60% 20 >/dev/null 2>&1; then
  echo 'malformed uid unexpectedly succeeded' >&2
  exit 1
fi
test ! -s "$test_root/systemctl.log"

printf 'oomd user policy reconcile: PASS\n'
