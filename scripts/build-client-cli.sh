#!/bin/sh
# build-client-cli — compile the `devbox` CLI for the platforms a laptop might run.
#
# usage: scripts/build-client-cli.sh <target> [<target>…]
#        targets are bun's, minus the "bun-" prefix: darwin-arm64, darwin-x64,
#        linux-x64, linux-arm64.
#
# Output goes to clients/devbox/dist/devbox-<target> (gitignored). The box_cli role
# uploads whatever is there; nothing here talks to a box.
#
# ── Why a stamp instead of comparing the binary ────────────────────────────────
# `bun build --compile` is not reproducible: two builds of identical source differ in
# ~600KB of bytes. So the binary's own checksum cannot answer "is this current" — it
# always says no, and Ansible would re-upload 60-90MB on every run forever.
#
# The fingerprint is therefore taken over the INPUTS (sources, manifest, lockfile, bun
# version, target). Same inputs, no rebuild; the bytes on disk stay put and Ansible's
# checksum comparison finds nothing to send.
set -eu

# The controller may export C.UTF-8 even on macOS, where that locale does not exist.
# Fingerprints are byte-oriented, so the portable C locale is deterministic and keeps
# shasum/Perl from aborting before a cached artifact can be reused.
LC_ALL=C
export LC_ALL

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cli="$here/clients/devbox"
out="$cli/dist"

[ $# -gt 0 ] || { echo "usage: $0 <target> [<target>…]" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || {
  echo "build-client-cli: bun is not installed — it is what compiles the CLI" >&2
  exit 1
}

# Deps must be present to bundle: ink reaches for react-devtools-core through
# import.meta.resolve, and a compiled binary resolves that eagerly at startup. Marking it
# --external does not help — the binary then dies on its first line with "Cannot find
# package". It is a devDependency so the bundle can contain it and never run it.
[ -d "$cli/node_modules" ] || (cd "$cli" && bun install --frozen-lockfile >/dev/null)

mkdir -p "$out"

# Sorted so the digest does not depend on readdir order, and -print0/-0 so a path with a
# space cannot split into two.
fingerprint() {
  {
    bun --version
    echo "$1"
    find "$cli/src" -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.ts' -print0 |
      LC_ALL=C sort -z | xargs -0 shasum -a 256
    shasum -a 256 "$cli/package.json" "$cli/bun.lock" 2>/dev/null || true
  } | shasum -a 256 | cut -d' ' -f1
}

# A compiled binary can bundle cleanly and still be unable to start, or start and route
# every subcommand to the wrong place. Both have happened here — one because a dependency
# ink resolves at runtime was marked external, one because argv was assumed to differ
# between `bun run` and a standalone binary when it does not. Neither is visible to a
# typecheck or a unit test, and both are obvious the moment the thing is executed. So it
# is executed, for whichever target this machine can actually run.
host="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/^x86_64$/x64/' -e 's/^aarch64$/arm64/')"
smoke() {
  [ "$1" = "$host" ] || return 0
  "$2" --version >/dev/null || { echo "build-client-cli: $1 binary cannot start" >&2; exit 1; }
  # A subcommand, not just --version: argv routing is what --version does not exercise.
  "$2" phases >/dev/null || { echo "build-client-cli: $1 binary cannot run a subcommand" >&2; exit 1; }
}

for target in "$@"; do
  case "$target" in
    darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;;
    *) echo "build-client-cli: unknown target '$target'" >&2; exit 2 ;;
  esac

  bin="$out/devbox-$target"
  stamp="$bin.stamp"
  want=$(fingerprint "$target")

  if [ -f "$bin" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    echo "current  $target"
    continue
  fi

  (cd "$cli" && bun build --compile --minify --target="bun-$target" src/devbox.ts \
    --outfile "$bin" >/dev/null)
  smoke "$target" "$bin"
  printf '%s\n' "$want" > "$stamp"
  echo "built    $target  ($(wc -c < "$bin" | tr -d ' ') bytes)"
done
