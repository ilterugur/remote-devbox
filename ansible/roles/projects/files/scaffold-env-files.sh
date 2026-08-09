#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s PROJECT_ROOT\n' "${0##*/}" >&2
  exit 64
fi

project_root=$1
if ! cd -- "$project_root"; then
  printf 'cannot enter project root: %s\n' "$project_root" >&2
  exit 66
fi

while IFS= read -r -d '' source; do
  target=${source%.example}
  [[ -e "$target" || -L "$target" ]] || cp -- "$source" "$target"
done < <(find . \
  \( -type d \( \
    -name node_modules -o \
    -name .git -o \
    -name .worktrees -o \
    -name .turbo -o \
    -name .next -o \
    -name dist -o \
    -name build -o \
    -name coverage \
  \) -prune \) -o \
  \( -type f -name .env.example -print0 \) 2>/dev/null)
