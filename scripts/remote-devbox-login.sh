#!/usr/bin/env bash
# Run as root on the box:  sudo remote-devbox-login [users...]
# One-time interactive claude.ai login per profile (Remote Control needs OAuth;
# tokens/API keys don't work). Detects profiles from /home/*/.claude if no args.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (needs to switch users)." >&2; exit 1; }

users=("$@")
if [ ${#users[@]} -eq 0 ]; then
  mapfile -t users < <(for d in /home/*/.claude; do [ -d "$d" ] && basename "$(dirname "$d")"; done)
fi
[ ${#users[@]} -gt 0 ] || { echo "No profiles found (no /home/*/.claude)." >&2; exit 1; }

echo "Profiles: ${users[*]}"
for u in "${users[@]}"; do
  cfg="/home/${u}/.claude"
  if [ -f "${cfg}/.credentials.json" ] || [ -f "${cfg}/credentials.json" ]; then
    read -r -p "[${u}] already logged in. Re-login? [y/N] " yn
    [[ "${yn:-N}" =~ ^[Yy]$ ]] || { echo "  skipped."; continue; }
  fi
  cat <<EOF
========================================================
 Logging in profile: ${u}
   type  /login  -> choose the 'Claude account' option
   -> press 'c' to copy the URL, sign in on any device, paste the code back
   -> then type  /exit
========================================================
EOF
  # cd into the profile's own HOME first: sudo keeps the caller's cwd (e.g.
  # /home/admin), which the profile user can't enter — that breaks the shell and
  # makes /doctor read the wrong project's settings (EACCES). -H sets HOME.
  sudo -u "${u}" -H bash -lc \
    'cd "$HOME" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN "$HOME/.local/bin/claude"'
done

echo
echo "Done. The always-on servers detect new logins within ~15s."
echo "Check:  systemctl status 'agent-rc-*' --no-pager"
