#!/usr/bin/env bash
# Managed by remote-devbox. Manual Claude Code account swap — one config tree, a vault
# of parked credentials beside it.
#
#   devbox-account.sh add <label>     adopt the account that is logged in right now
#   devbox-account.sh use <label>     park the active account, restore <label>
#   devbox-account.sh ls|status       what is parked / what the tree actually holds
#   devbox-account.sh rm <label>      forget a parked account
#   devbox-account.sh gc [--keep N]   prune swap backups
#
# The point of the design: MCP servers, skills, settings, plugins and session history
# stay in ONE config tree, shared by every account. An account is only three things —
# the account-scoped keys of .claude.json, the credential payload, and a registry row —
# so a swap is a credential change and nothing else. There is no copying of the config
# tree, no symlinking (auto-update wipes symlinked skills: claude-code#50052), and no
# automatic switching: picking an account is always a human action.
#
# Env:
#   CLAUDE_CONFIG_DIR            config tree (default ~/.claude, with state at ~/.claude.json)
#   DEVBOX_ACCOUNT_VAULT         vault dir (default ~/.claude-accounts)
#   DEVBOX_ACCOUNT_BACKUP_KEEP   swap backups to retain (default 3)
#   DEVBOX_ACCOUNT_STORE         file | keychain | auto (default auto: keychain on macOS)
#   DEVBOX_ACCOUNT_PGREP         override the "is claude running" probe (testing seam)
set -euo pipefail

ME="devbox-account"
die() { printf '%s: %s\n' "$ME" "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

# CLAUDE_CONFIG_DIR relocates the WHOLE root, including the state file that otherwise
# sits next to the tree as ~/.claude.json. Without this split the box (which always
# exports the profile dir) and the client default would disagree about which file holds
# the identity, and a swap would write a file claude never reads.
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CFG="${CLAUDE_CONFIG_DIR%/}"
  STATE="$CFG/.claude.json"
else
  CFG="$HOME/.claude"
  STATE="$HOME/.claude.json"
fi
VAULT="${DEVBOX_ACCOUNT_VAULT:-$HOME/.claude-accounts}"
REG="$VAULT/accounts.json"
KEEP="${DEVBOX_ACCOUNT_BACKUP_KEEP:-3}"
KC_SERVICE="Claude Code-credentials"

STORE="${DEVBOX_ACCOUNT_STORE:-auto}"
if [ "$STORE" = auto ]; then
  [ "$(uname -s)" = Darwin ] && STORE=keychain || STORE=file
fi
case "$STORE" in file | keychain) ;; *) die "DEVBOX_ACCOUNT_STORE must be file, keychain or auto (got '$STORE')" ;; esac

# ── the .claude.json surgery + registry, in one embedded program ────────────────────
# Bash cannot safely edit a 75 KB JSON document that claude rewrites under it, and every
# other box-side script in this repo already reaches for python3 for exactly this.
PY='
import json, os, sys, time

# Account-scoped keys. `oauthAccount` alone is not enough: the entitlement caches next to
# it are keyed to that account, so leaving them behind hands the previous account model
# access to the next one. Restore is therefore set-or-delete, never merge.
KEYS = ["userID", "oauthAccount", "modelAccessCache", "orgModelDefaultCache",
        "passesEligibilityCache", "s1mAccessCache", "cachedStatsigGates"]


def load(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {} if default is None else default
    except json.JSONDecodeError as exc:
        sys.exit("%s is not valid JSON (%s)" % (path, exc))


def save(path, data, mode=0o600):
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def info(identity):
    acct = identity.get("oauthAccount") or {}
    return {
        "email": acct.get("emailAddress", ""),
        "org": acct.get("organizationName", ""),
        "accountUuid": acct.get("accountUuid", ""),
        "userID": identity.get("userID", ""),
    }


def registry(path):
    reg = load(path, {})
    reg.setdefault("version", 1)
    reg.setdefault("active", None)
    reg.setdefault("accounts", {})
    return reg


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


op = sys.argv[1]

if op == "identity-extract":
    state, out = sys.argv[2], sys.argv[3]
    data = load(state)
    identity = {k: data[k] for k in KEYS if k in data}
    if not identity.get("oauthAccount"):
        sys.exit("no oauthAccount in %s — nothing is logged in there" % state)
    save(out, identity)
    print(json.dumps(info(identity)))

elif op == "identity-apply":
    state, src = sys.argv[2], sys.argv[3]
    identity = load(src)
    data = load(state)
    for k in KEYS:
        if k in identity:
            data[k] = identity[k]
        else:
            data.pop(k, None)
    save(state, data)

elif op == "identity-info":
    print(json.dumps(info(load(sys.argv[2]))))

elif op == "reg-upsert":
    path, label, meta, kc = sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sys.argv[5]
    reg = registry(path)
    row = reg["accounts"].get(label, {})
    row.update(meta)
    row.setdefault("addedAt", now())
    if kc:
        row["keychainAcct"] = kc
    reg["accounts"][label] = row
    reg["active"] = label
    row["lastUsedAt"] = now()
    save(path, reg)

elif op == "reg-activate":
    path, label = sys.argv[2], sys.argv[3]
    reg = registry(path)
    if label not in reg["accounts"]:
        sys.exit("no parked account named %r" % label)
    reg["active"] = label
    reg["accounts"][label]["lastUsedAt"] = now()
    save(path, reg)

elif op == "reg-forget":
    path, label = sys.argv[2], sys.argv[3]
    reg = registry(path)
    reg["accounts"].pop(label, None)
    if reg["active"] == label:
        reg["active"] = None
    save(path, reg)

elif op == "reg-field":
    reg = registry(sys.argv[2])
    field = sys.argv[3]
    if field == "active":
        print(reg["active"] or "")
    elif field == "labels":
        print("\n".join(sorted(reg["accounts"])))
    else:
        sys.exit("unknown registry field %r" % field)

elif op == "reg-keychain-acct":
    reg = registry(sys.argv[2])
    print((reg["accounts"].get(sys.argv[3]) or {}).get("keychainAcct", ""))

elif op == "render":
    # render <reg> <tree-identity-json|-> <cred-state> <store> <mode:ls|status> <json:0|1>
    path, tree, cred, store, mode, as_json = sys.argv[2:8]
    reg = registry(path)
    tree_info = json.loads(tree) if tree != "-" else None
    doc = {
        "active": reg["active"],
        "store": store,
        "credential": cred,
        "tree": tree_info,
        "accounts": [
            dict(label=label, **{k: v for k, v in row.items()})
            for label, row in sorted(reg["accounts"].items())
        ],
    }
    if as_json == "1":
        print(json.dumps(doc, indent=2))
        sys.exit(0)

    if mode == "ls":
        if not doc["accounts"]:
            print("no accounts parked yet — log in, then `add <label>`")
        for row in doc["accounts"]:
            mark = "*" if row["label"] == doc["active"] else " "
            print("%s %-14s %-32s %-24s %s" % (
                mark, row["label"], row.get("email", ""), row.get("org", ""),
                row.get("lastUsedAt", "")))
    else:
        print("active      : %s" % (doc["active"] or "(none tracked)"))
        if tree_info:
            print("tree        : %s%s" % (
                tree_info["email"] or "(no oauthAccount)",
                "  [%s]" % tree_info["org"] if tree_info["org"] else ""))
        else:
            print("tree        : nothing logged in")
        print("credential  : %s (%s store)" % (doc["credential"], doc["store"]))
        print("parked      : %s" % (", ".join(r["label"] for r in doc["accounts"]) or "none"))

    # A tree that holds an account the registry does not point at is the one state where a
    # swap would silently overwrite an untracked login, so say so loudly.
    if tree_info and doc["active"]:
        row = reg["accounts"].get(doc["active"], {})
        if row.get("accountUuid") and tree_info["accountUuid"] and row["accountUuid"] != tree_info["accountUuid"]:
            print("warning: the tree holds %s but the registry says %s — run `add <label>` to adopt it"
                  % (tree_info["email"], doc["active"]), file=sys.stderr)

elif op == "cred-expiry":
    data = load(sys.argv[2])
    exp = (data.get("claudeAiOauth") or {}).get("expiresAt")
    if not isinstance(exp, (int, float)):
        print("present")
    else:
        secs = exp / 1000.0
        print("%s until %s" % ("present" if secs > time.time() else "EXPIRED",
                               time.strftime("%Y-%m-%d %H:%M", time.localtime(secs))))

else:
    sys.exit("unknown op %r" % op)
'
py() { python3 -c "$PY" "$@"; }

# ── credential store ───────────────────────────────────────────────────────────────
# The file the Linux store owns, and the fallback that macOS keeps beside the keychain.
cred_file() {
  if [ -f "$CFG/.credentials.json" ]; then say "$CFG/.credentials.json"
  elif [ -f "$CFG/credentials.json" ]; then say "$CFG/credentials.json"
  else say ""
  fi
}

# 0 when the tree holds a credential.
store_has() {
  if [ "$STORE" = keychain ]; then
    security find-generic-password -s "$KC_SERVICE" >/dev/null 2>&1
  else
    [ -n "$(cred_file)" ]
  fi
}

# Copy the active credential to $1 (mode 0600). Never echoes the payload.
store_save() {
  local out="$1" src
  umask 077
  if [ "$STORE" = keychain ]; then
    security find-generic-password -s "$KC_SERVICE" -w >"$out.tmp" 2>/dev/null \
      || die "could not read the '$KC_SERVICE' keychain item — run this from your own login session (an agent/ssh shell cannot reach the keychain)"
    mv "$out.tmp" "$out"
  else
    src="$(cred_file)"
    [ -n "$src" ] || die "no credential file under $CFG — nothing is logged in"
    cp "$src" "$out.tmp" && mv "$out.tmp" "$out"
  fi
  chmod 600 "$out"
}

# Install $1 as the active credential. $2 is the keychain account attribute (macOS).
store_load() {
  local src="$1" acct="${2:-}"
  umask 077
  if [ "$STORE" = keychain ]; then
    [ -n "$acct" ] || acct="${USER:-$(id -un)}"
    # -w takes the payload on argv, which is visible to this user's own `ps` for the
    # lifetime of the call. `security` offers no stdin path for a non-tty caller, and the
    # alternative (a temp file) is worse: it survives a crash. Same-user exposure only.
    security add-generic-password -U -s "$KC_SERVICE" -a "$acct" -w "$(cat "$src")" \
      || die "could not write the '$KC_SERVICE' keychain item"
  else
    cp "$src" "$CFG/.credentials.json.tmp"
    chmod 600 "$CFG/.credentials.json.tmp"
    mv "$CFG/.credentials.json.tmp" "$CFG/.credentials.json"
    # The legacy path would shadow nothing, but leaving a second, older copy behind is
    # how a dead token comes back from the grave.
    rm -f "$CFG/credentials.json"
  fi
}

# The keychain item's account attribute, so a restore reproduces it exactly.
store_acct() {
  [ "$STORE" = keychain ] || { say ""; return 0; }
  security find-generic-password -s "$KC_SERVICE" 2>/dev/null \
    | sed -n 's/^[[:space:]]*"acct"<blob>="\(.*\)"$/\1/p' | head -1
}

# ── guards ─────────────────────────────────────────────────────────────────────────
claude_running() {
  if [ -n "${DEVBOX_ACCOUNT_PGREP:-}" ]; then
    # shellcheck disable=SC2086
    $DEVBOX_ACCOUNT_PGREP >/dev/null 2>&1
  else
    pgrep -x claude >/dev/null 2>&1
  fi
}

lock() {
  mkdir -p "$VAULT"
  chmod 700 "$VAULT"
  mkdir "$VAULT/.lock" 2>/dev/null \
    || die "another swap is in progress ($VAULT/.lock) — remove it if that is stale"
  trap 'rmdir "$VAULT/.lock" 2>/dev/null || true' EXIT
}

# ── backups: the parked triple only, count-based retention ─────────────────────────
snapshot() {
  local label="$1" dir
  dir="$VAULT/.backups/$(date +%s)-$label"
  mkdir -p "$dir"
  chmod 700 "$VAULT/.backups" "$dir"
  [ -f "$VAULT/$label/identity.json" ] && cp "$VAULT/$label/identity.json" "$dir/"
  [ -f "$VAULT/$label/credentials.json" ] && cp "$VAULT/$label/credentials.json" "$dir/"
  prune
}

# Kilobytes each — the tree itself (projects/, sessions/, session-env/) is never copied,
# which is what keeps this from growing without bound.
prune() {
  local keep="$KEEP" n=0 dir
  [ -d "$VAULT/.backups" ] || return 0
  case "$keep" in '' | *[!0-9]*) die "DEVBOX_ACCOUNT_BACKUP_KEEP must be a whole number (got '$KEEP')" ;; esac
  # Newest first by name: the epoch prefix sorts lexicographically for the next ~250 years.
  for dir in $(ls -1 "$VAULT/.backups" 2>/dev/null | sort -r); do
    n=$((n + 1))
    [ "$n" -gt "$keep" ] && rm -rf "$VAULT/.backups/$dir"
  done
  return 0
}

# ── verbs ──────────────────────────────────────────────────────────────────────────
tree_identity() {
  local tmp
  tmp="$(mktemp)"
  if py identity-extract "$STATE" "$tmp" 2>/dev/null; then rm -f "$tmp"; else rm -f "$tmp"; say "-"; fi
}

cmd_add() {
  local label="$1" dir meta acct
  [ -n "$label" ] || die "usage: $ME add <label>"
  case "$label" in *[!a-zA-Z0-9._-]*) die "label may only contain letters, digits, '.', '_' and '-'" ;; esac
  store_has || die "nothing is logged in under $CFG — log in first (\`claude\` then /login), then adopt it"
  lock
  dir="$VAULT/$label"
  mkdir -p "$dir"
  chmod 700 "$dir"
  meta="$(py identity-extract "$STATE" "$dir/identity.json")"
  store_save "$dir/credentials.json"
  acct="$(store_acct)"
  py reg-upsert "$REG" "$label" "$meta" "$acct"
  chmod 600 "$REG"
  say "adopted the current login as '$label'."
  cmd_ls
}

cmd_use() {
  local label="$1" force="$2" active dir
  [ -n "$label" ] || die "usage: $ME use <label>"
  dir="$VAULT/$label"
  [ -d "$dir" ] || die "no parked account named '$label' — \`$ME ls\` shows what there is"
  [ -f "$dir/identity.json" ] || die "'$label' has no identity.json — re-adopt it with \`$ME add $label\`"
  [ -f "$dir/credentials.json" ] || die "'$label' has no parked credential — re-adopt it with \`$ME add $label\`"
  active="$(py reg-field "$REG" active)"
  if [ "$active" = "$label" ] && store_has; then
    say "'$label' is already active."
    return 0
  fi

  if [ "$force" != 1 ] && claude_running; then
    die "claude is running — it rewrites .claude.json under us and concurrent writes corrupt it (claude-code#28992). Quit it, or pass --force."
  fi

  lock
  if [ "$active" = "$label" ]; then
    say "'$label' is already active but the tree has no credential — restoring it."
  fi

  # Park what is there BEFORE touching anything, and refuse rather than destroy a login
  # the registry does not know about.
  if store_has; then
    [ -n "$active" ] || die "the current login is not tracked — \`$ME add <label>\` it first so this swap cannot lose it"
    mkdir -p "$VAULT/$active"
    chmod 700 "$VAULT/$active"
    py identity-extract "$STATE" "$VAULT/$active/identity.json" >/dev/null
    store_save "$VAULT/$active/credentials.json"
    snapshot "$active"
  fi

  py identity-apply "$STATE" "$dir/identity.json"
  store_load "$dir/credentials.json" "$(py reg-keychain-acct "$REG" "$label")"
  py reg-activate "$REG" "$label"
  say "now using '$label'."
  cmd_status
}

cmd_rm() {
  local label="$1" active
  [ -n "$label" ] || die "usage: $ME rm <label>"
  [ -d "$VAULT/$label" ] || die "no parked account named '$label'"
  active="$(py reg-field "$REG" active)"
  [ "$active" = "$label" ] && die "'$label' is the active account — swap to another one first"
  lock
  rm -rf "$VAULT/$label"
  py reg-forget "$REG" "$label"
  say "forgot '$label' (its credential is gone from the vault; the account itself is untouched)."
}

cmd_ls() { py render "$REG" "$(tree_identity)" "$(cred_state)" "$STORE" ls "$JSON"; }
cmd_status() { py render "$REG" "$(tree_identity)" "$(cred_state)" "$STORE" status "$JSON"; }

cred_state() {
  local f
  if [ "$STORE" = keychain ]; then
    store_has && say "present" || say "absent"
  else
    f="$(cred_file)"
    [ -n "$f" ] && py cred-expiry "$f" || say "absent"
  fi
}

cmd_gc() {
  mkdir -p "$VAULT"
  prune
  say "kept the newest $KEEP swap backup(s) under $VAULT/.backups."
}

usage() {
  cat >&2 <<USAGE
$ME — manual Claude Code account swap (one config tree, parked credentials)

  $ME ls [--json]           parked accounts, active one marked
  $ME status [--json]       active label, what the tree holds, credential state
  $ME add <label>           adopt the account that is logged in right now
  $ME use <label> [--force] park the active account, restore <label>
  $ME rm <label>            forget a parked account
  $ME gc [--keep N]         prune swap backups (default keep $KEEP)

tree : $CFG (state: $STATE)
vault: $VAULT   store: $STORE
USAGE
  exit 1
}

VERB="${1:-}"
[ -n "$VERB" ] || usage
shift || true
LABEL=""
JSON=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --force) FORCE=1 ;;
    --keep) shift; KEEP="${1:-}" ;;
    --keep=*) KEEP="${1#--keep=}" ;;
    -*) die "unknown flag '$1'" ;;
    *) [ -z "$LABEL" ] && LABEL="$1" || die "unexpected argument '$1'" ;;
  esac
  shift
done

command -v python3 >/dev/null 2>&1 || die "python3 is required"

case "$VERB" in
  ls) cmd_ls ;;
  status) cmd_status ;;
  add) cmd_add "$LABEL" ;;
  use) cmd_use "$LABEL" "$FORCE" ;;
  rm) cmd_rm "$LABEL" ;;
  gc) cmd_gc ;;
  -h | --help | help) usage ;;
  *) die "unknown verb '$VERB' (try --help)" ;;
esac
