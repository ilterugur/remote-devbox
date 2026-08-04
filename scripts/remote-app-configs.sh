#!/bin/sh
# remote-app-configs — box side of `devbox config`. Installed to /usr/local/bin by the
# app_configs role. Every subcommand is idempotent; nothing is ever deleted, only renamed.
#
# usage: remote-app-configs <inspect|seed|link|unlink|ensure> <label> <boxpath> <mode>
#                            <store> <payload-basename> [excludes…]
#
# <payload-basename> is the file/ssh-include payload's name inside <store> (e.g.
# "config" for ssh-include, or the client's basename for a "file" entry). It is computed
# once, client-side, by registry.ts's payloadBasename() and passed in here rather than
# recomputed from <boxpath> — the client and box paths for a "file" entry can legitimately
# have different basenames (e.g. client `~/Library/App/settings.json`, box
# `~/.config/app/config.json`), and each side recomputing its own would link to two
# different files inside the same store. Ignored for "dir" mode, but always required so
# every caller passes one consistent value.
set -eu

cmd=${1:?usage: remote-app-configs <inspect|seed|link|unlink|ensure> …}
label=${2:?label}
boxpath_raw=${3:?box path}
mode=${4:?mode}
store_raw=${5:?store path}
payload_name=${6:?payload basename}
stamp=$(date -u +%Y%m%dT%H%M%SZ)

# Tilde-expand without `eval`: `eval echo "$3"` also word-splits and would execute
# `$(…)`/backticks embedded in a config value, and breaks on paths containing spaces
# (e.g. "~/Library/Application Support/…"). Only a leading "~/" is expanded — that is
# the only form these paths ever take.
case "$boxpath_raw" in
  "~/"*) boxpath="$HOME/${boxpath_raw#\~/}" ;;
  *) boxpath=$boxpath_raw ;;
esac
case "$store_raw" in
  "~/"*) store="$HOME/${store_raw#\~/}" ;;
  *) store=$store_raw ;;
esac

case "$mode" in
  dir|file|ssh-include) ;;
  *) echo "app-configs: unknown mode \"$mode\" — must be one of: dir, file, ssh-include" >&2; exit 2 ;;
esac

payload() {
  case "$mode" in
    dir) echo "$store" ;;
    *) echo "$store/$payload_name" ;;
  esac
}

summarize() {
  case "$mode" in
    ssh-include)
      n=$(grep -c '^[Hh]ost ' "$1" 2>/dev/null) || n=0
      echo "$n hosts"
      ;;
    file)
      # Guard existence explicitly: `wc -c < missing | tr -d ' '` exits 0 (tr succeeds on
      # empty input even though wc failed upstream), so `|| n=0` alone never triggers —
      # this matters for a "linked" file entry whose target is dangling.
      if [ -r "$1" ]; then n=$(wc -c < "$1" | tr -d ' '); else n=0; fi
      echo "$n bytes"
      ;;
    *)
      case "$label" in
        filezilla)
          n=$(grep -c '<Server>' "$1/sitemanager.xml" 2>/dev/null) || n=0
          echo "$n sites"
          ;;
        *)
          echo "$(find "$1" -type f 2>/dev/null | wc -l | tr -d ' ') files"
          ;;
      esac
      ;;
  esac
}

case "$cmd" in
  inspect)
    if [ "$mode" = ssh-include ]; then
      if grep -q '^# >>> devbox app-configs' "$boxpath" 2>/dev/null; then kind=linked
      elif [ -s "$boxpath" ]; then kind=content
      elif [ -e "$boxpath" ]; then kind=empty
      else kind=absent; fi
    elif [ -L "$boxpath" ]; then
      [ "$(readlink "$boxpath")" = "$(payload)" ] && kind=linked || kind=foreign-link
    elif [ ! -e "$boxpath" ]; then kind=absent
    elif [ "$mode" = file ]; then
      # A regular file, not a directory: `ls -A` on it prints the filename itself (never
      # empty), so it always read "content" even for a zero-byte file. `-s` is the
      # correct emptiness test for a plain file.
      if [ -s "$boxpath" ]; then kind=content; else kind=empty; fi
    elif [ -z "$(ls -A "$boxpath" 2>/dev/null)" ]; then kind=empty
    else kind=content; fi
    printf '{"kind":"%s","summary":"%s"}\n' "$kind" "$(summarize "$boxpath" 2>/dev/null || true)"
    ;;
  seed)   # box content becomes the canonical copy
    # Idempotent: once boxpath has been moved aside (or turned into a link) there is
    # nothing left to seed from.
    if [ -e "$boxpath" ] && [ ! -L "$boxpath" ]; then
      mkdir -p "$(dirname "$(payload)")"
      if [ "$mode" = dir ]; then
        mkdir -p "$store"
        shift 6
        # Trailing args are exclude patterns (shell globs, matched against each path
        # component's basename) — e.g. filezilla's queue.sqlite3 / *.lock, which are
        # machine-local and must never enter the shared store. file/ssh-include modes
        # copy a single named payload, so excludes only apply here in dir mode.
        ( cd "$boxpath" && find . -mindepth 1 -print ) 2>/dev/null | while IFS= read -r rel; do
          skip=0
          save_ifs=$IFS; IFS=/
          for comp in $rel; do
            for pat in "$@"; do
              case "$comp" in $pat) skip=1 ;; esac
            done
          done
          IFS=$save_ifs
          [ "$skip" -eq 1 ] && continue
          if [ -d "$boxpath/$rel" ]; then
            mkdir -p "$store/$rel"
          else
            mkdir -p "$store/$(dirname "$rel")"
            cp -a "$boxpath/$rel" "$store/$rel"
          fi
        done
      else
        cp -a "$boxpath" "$(payload)"
      fi
      mv "$boxpath" "$boxpath.pre-devbox-$stamp"
    fi
    ;;
  link)
    mkdir -p "$store"
    if [ "$mode" = ssh-include ]; then
      mkdir -p "$(dirname "$boxpath")"; touch "$boxpath"
      grep -q '^# >>> devbox app-configs' "$boxpath" || {
        printf '# >>> devbox app-configs\nInclude %s\n# <<< devbox app-configs\n%s\n' \
          "$(payload)" "$(cat "$boxpath")" > "$boxpath.new"
        mv "$boxpath.new" "$boxpath"; chmod 600 "$boxpath"
      }
    else
      # Never delete a symlink here, foreign or not — only rename aside. A foreign link
      # is exactly the case where deleting silently drops whatever it pointed at.
      if [ -L "$boxpath" ]; then
        if [ "$(readlink "$boxpath")" != "$(payload)" ]; then
          mv "$boxpath" "$boxpath.pre-devbox-$stamp"
        fi
        # else: already correct — no-op, nothing to rename or recreate.
      elif [ -e "$boxpath" ]; then
        mv "$boxpath" "$boxpath.pre-devbox-$stamp"
      fi
      if [ ! -L "$boxpath" ]; then
        mkdir -p "$(dirname "$boxpath")"; ln -s "$(payload)" "$boxpath"
      fi
    fi
    ;;
  unlink)
    if [ "$mode" = ssh-include ]; then
      # Idempotent: nothing to undo once the managed block is gone.
      grep -q '^# >>> devbox app-configs' "$boxpath" 2>/dev/null || exit 0
      sed '/^# >>> devbox app-configs$/,/^# <<< devbox app-configs$/d' "$boxpath" > "$boxpath.new"
      cat "$(payload)" "$boxpath.new" > "$boxpath" 2>/dev/null || mv "$boxpath.new" "$boxpath"
      rm -f "$boxpath.new"
    else
      [ -L "$boxpath" ] || exit 0
      # A missing payload must not turn into a deleted link with nothing to put back:
      # rm-then-cp deletes the link first, so a failed cp (set -eu) aborts leaving
      # nothing at $boxpath at all. Check first, and copy-then-swap so a failure never
      # touches the existing link.
      [ -e "$(payload)" ] || { echo "app-configs: $label payload is missing on the box — leaving the link in place" >&2; exit 0; }
      cp -a "$(payload)" "$boxpath.new" && mv -f "$boxpath.new" "$boxpath"
    fi
    ;;
  ensure) # playbook path: link only when unambiguous, never destroy
    [ -d "$store" ] || exit 0
    if [ "$mode" = ssh-include ]; then
      grep -q '^# >>> devbox app-configs' "$boxpath" 2>/dev/null && exit 0
      [ -s "$boxpath" ] && { echo "app-configs: $label has box-side content — run 'devbox config link'" >&2; exit 0; }
    else
      [ -L "$boxpath" ] && exit 0
      [ -e "$boxpath" ] && { echo "app-configs: $label has box-side content — run 'devbox config link'" >&2; exit 0; }
    fi
    "$0" link "$label" "$3" "$mode" "$5" "$6"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
