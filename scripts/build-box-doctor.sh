#!/bin/sh
# build-box-doctor — cross-compile the root health snapshot collector for the box.
#
# usage: scripts/build-box-doctor.sh linux-x64|linux-arm64
# Output is generated under box/doctor/dist/ and is never committed.
set -eu

# The controller may export C.UTF-8 even on macOS, where that locale does not exist.
# Hashing is byte-oriented, so the portable C locale is the deterministic choice.
LC_ALL=C
export LC_ALL

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
doctor="$root/box/doctor"
out="$doctor/dist"
target=${1:-}

case "$target" in
  linux-x64|linux-arm64) ;;
  *) echo "usage: $0 linux-x64|linux-arm64" >&2; exit 2 ;;
esac

command -v bun >/dev/null 2>&1 || {
  echo "build-box-doctor: bun is required on the controller" >&2
  exit 1
}

mkdir -p "$out"
bin="$out/remote-devbox-doctor-$target"
stamp="$bin.stamp"

want=$(
  {
    bun --version
    echo "$target"
    find "$doctor/src" -type f -name '*.ts' ! -name '*.test.ts' -print0 |
      LC_ALL=C sort -z | xargs -0 shasum -a 256
    shasum -a 256 "$doctor/package.json"
  } | shasum -a 256 | cut -d' ' -f1
)

if [ -f "$bin" ] && [ -f "$stamp" ] && [ "$(sed -n '1p' "$stamp")" = "$want" ]; then
  echo "current  $target"
  exit 0
fi

(cd "$doctor" && bun build --compile --minify --target="bun-$target" src/cli.ts --outfile "$bin" >/dev/null)
printf '%s\n' "$want" > "$stamp"
echo "built    $target  ($(wc -c < "$bin" | tr -d ' ') bytes)"
