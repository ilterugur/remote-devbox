#!/bin/sh
# remote-app-configs — box side of `devbox config`. Installed to /usr/local/bin by the
# app_configs role. Every subcommand is idempotent; nothing is ever deleted, only renamed.
set -eu

cmd=${1:?usage: remote-app-configs <inspect|seed|link|unlink|ensure> …}
label=${2:?label}
boxpath=$(eval echo "${3:?box path}")
mode=${4:?mode}
store=$(eval echo "${5:?store path}")
stamp=$(date -u +%Y%m%dT%H%M%SZ)

payload() {
  case "$mode" in
    ssh-include) echo "$store/config" ;;
    file) echo "$store/$(basename "$boxpath")" ;;
    *) echo "$store" ;;
  esac
}

summarize() {
  case "$label" in
    filezilla)
      n=$(grep -c '<Server>' "$1/sitemanager.xml" 2>/dev/null) || n=0
      echo "$n sites"
      ;;
    ssh_config)
      n=$(grep -c '^[Hh]ost ' "$1" 2>/dev/null) || n=0
      echo "$n hosts"
      ;;
    *)
      echo "$(find "$1" -type f 2>/dev/null | wc -l | tr -d ' ') files"
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
        shift 5
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
      [ -e "$boxpath" ] && [ ! -L "$boxpath" ] && mv "$boxpath" "$boxpath.pre-devbox-$stamp"
      rm -f "$boxpath"; mkdir -p "$(dirname "$boxpath")"; ln -s "$(payload)" "$boxpath"
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
      rm -f "$boxpath"; cp -a "$(payload)" "$boxpath"
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
    "$0" link "$label" "$3" "$mode" "$5"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
