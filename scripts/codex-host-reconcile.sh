#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: codex-host-reconcile <user> <socket> <unit-changed:true|false>" >&2
  exit 64
fi

user=$1
socket=$2
unit_changed=$3
service=codex-code-mode-host.service

case "$unit_changed" in
  true | false) ;;
  *)
    echo "unit-changed must be true or false" >&2
    exit 64
    ;;
esac

if systemctl --user --machine="$user"@ is-active --quiet "$service"; then
  systemctl --user --machine="$user"@ enable "$service"
  if [ "$unit_changed" = true ]; then
    echo "codex host $user: unit updated; restart deferred until a maintenance window"
  fi
  exit 0
fi

if [ -S "$socket" ]; then
  echo "codex host $user: refusing takeover; existing socket $socket requires explicit maintenance" >&2
  exit 75
fi

systemctl --user --machine="$user"@ enable "$service"
systemctl --user --machine="$user"@ start "$service"
