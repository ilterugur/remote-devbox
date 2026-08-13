#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
resume=${1:-"$repo_root/scripts/agent-rc-resume.sh"}
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/adapters" "$tmp/home" "$tmp/project"

cat >"$tmp/adapters/claude.sh" <<'EOF'
adapter_resume_scan() {
  printf '%s\n' '[{"uuid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","worktree":"REPLACE_PROJECT","permissionMode":"auto","name":"A"},{"uuid":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","worktree":"REPLACE_PROJECT","permissionMode":"auto","name":"B"}]'
}
adapter_resume_pgrep_pattern() { printf 'claude --resume %s' "$1"; }
EOF
sed -i.bak "s|REPLACE_PROJECT|$tmp/project|g" "$tmp/adapters/claude.sh"

cat >"$tmp/bin/tmux" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" has-session "*) exit 0 ;;
  *" new-window "*) printf 'launch\n' >>"$RC_TEST_LOG"; exit 0 ;;
esac
exit 0
EOF
cat >"$tmp/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *" -f "* ]] && exit 1
printf '2\n'
EOF
cat >"$tmp/bin/free" <<'EOF'
#!/usr/bin/env bash
printf 'Mem: 64000 1000 1000 0 0 63000\n'
EOF
cat >"$tmp/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/bin/"*
touch "$tmp/exec" "$tmp/sys"

export HOME="$tmp/home"
export PATH="$tmp/bin:/usr/bin:/bin"
export CLAUDE_RC_PROJECT_DIR="$tmp/project"
export CLAUDE_RC_NAME=Test
export CLAUDE_RC_AGENT=claude
export RC_RESUME_MAX_CONCURRENT=1
export RC_RESUME_SETTLE_SEC=1
export RC_RESUME_SETTLE_MAX_SEC=2
export RC_TEST_LOG="$tmp/launches"
export AGENT_RC_ADAPTER_DIR="$tmp/adapters"
export AGENT_RC_EXEC="$tmp/exec"
export AGENT_RC_SYSFILE="$tmp/sys"

"$resume" test >"$tmp/out" 2>"$tmp/err"
[[ $(wc -l <"$tmp/launches") -eq 2 ]] || { cat "$tmp/err" >&2; exit 1; }
! grep -q 'settle timeout' "$tmp/err" || { cat "$tmp/err" >&2; exit 1; }
echo "rc resume throttle: PASS"
