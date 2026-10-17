#!/usr/bin/env bash
# Managed by remote-devbox. Manual Codex account swap — one CODEX_HOME tree, a vault
# of parked auth.json files beside it.
set -euo pipefail

ME="devbox-codex-account"
die() { printf '%s: %s\n' "$ME" "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

CFG="${CODEX_HOME:-$HOME/.codex}"
CFG="${CFG%/}"
AUTH="$CFG/auth.json"
VAULT="${DEVBOX_CODEX_ACCOUNT_VAULT:-$HOME/.codex-accounts}"
REG="$VAULT/accounts.json"
KEEP="${DEVBOX_CODEX_ACCOUNT_BACKUP_KEEP:-3}"

PY='
import base64, json, os, sys, time

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

def jwt_claims(id_token):
    if not id_token or not isinstance(id_token, str):
        return {}
    parts = id_token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}

def info(auth_path):
    data = load(auth_path)
    tokens = data.get("tokens") or {}
    claims = jwt_claims(tokens.get("id_token"))
    nested = claims.get("https://api.openai.com/auth") or {}
    if not isinstance(nested, dict):
        nested = {}
    email = (claims.get("email") or "").strip()
    account_id = tokens.get("account_id") or nested.get("chatgpt_account_id") or ""
    plan = nested.get("chatgpt_plan_type") or ""
    return {"email": email, "account_id": account_id, "plan": plan, "auth_mode": data.get("auth_mode") or ""}

def registry(path):
    reg = load(path, {})
    reg.setdefault("version", 1)
    reg.setdefault("active", None)
    reg.setdefault("accounts", {})
    return reg

def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

op = sys.argv[1]

if op == "meta-extract":
    auth, out = sys.argv[2], sys.argv[3]
    data = load(auth)
    if not (data.get("tokens") or data.get("auth_mode")):
        sys.exit("no credential in %s" % auth)
    meta = info(auth)
    if not meta.get("account_id") and not meta.get("email"):
        sys.exit("could not read account identity from %s" % auth)
    save(out, meta)
    print(json.dumps(meta))
elif op == "meta-info":
    print(json.dumps(info(sys.argv[2])))
elif op == "reg-upsert":
    path, label, meta, active = sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sys.argv[5]
    reg = registry(path)
    row = reg["accounts"].get(label, {})
    row.update(meta)
    row.setdefault("addedAt", now())
    reg["accounts"][label] = row
    if active == "1":
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
elif op == "render":
    path, tree_json, cred_state, mode, as_json = sys.argv[2:7]
    reg = registry(path)
    tree_info = json.loads(tree_json) if tree_json != "-" else None
    doc = {"active": reg["active"], "credential": cred_state, "tree": tree_info,
           "accounts": [dict(label=label, **{k: v for k, v in row.items()}) for label, row in sorted(reg["accounts"].items())]}
    if as_json == "1":
        print(json.dumps(doc, indent=2))
        sys.exit(0)
    if mode == "ls":
        if not doc["accounts"]:
            print("no accounts parked yet")
        for row in doc["accounts"]:
            mark = "*" if row["label"] == doc["active"] else " "
            print("%s %-14s %-32s %-12s %s" % (mark, row["label"], row.get("email", ""), row.get("plan", ""), row.get("lastUsedAt", "")))
    else:
        print("active      : %s" % (doc["active"] or "(none tracked)"))
        if tree_info and (tree_info.get("email") or tree_info.get("account_id")):
            extra = ("  [%s]" % tree_info["plan"]) if tree_info.get("plan") else ""
            print("tree        : %s%s" % (tree_info.get("email") or tree_info.get("account_id"), extra))
        else:
            print("tree        : nothing logged in")
        print("credential  : %s" % doc["credential"])
        print("parked      : %s" % (", ".join(r["label"] for r in doc["accounts"]) or "none"))
else:
    sys.exit("unknown op %r" % op)
'
py() { python3 -c "$PY" "$@"; }
auth_has() { [ -f "$AUTH" ] && py meta-info "$AUTH" >/dev/null 2>&1; }
codex_running() {
  if [ -n "${DEVBOX_CODEX_ACCOUNT_PGREP:-}" ]; then $DEVBOX_CODEX_ACCOUNT_PGREP >/dev/null 2>&1
  else pgrep -u "$(id -u)" -x codex >/dev/null 2>&1 || pgrep -u "$(id -u)" -f 'codex app-server' >/dev/null 2>&1; fi
}
lock() {
  mkdir -p "$VAULT"; chmod 700 "$VAULT"
  mkdir "$VAULT/.lock" 2>/dev/null || die "another swap is in progress"
  trap 'rmdir "$VAULT/.lock" 2>/dev/null || true' EXIT
}
snapshot() {
  local label="$1" dir="$VAULT/.backups/$(date +%s)-$1"
  mkdir -p "$dir"; chmod 700 "$VAULT/.backups" "$dir"
  [ -f "$VAULT/$label/auth.json" ] && cp "$VAULT/$label/auth.json" "$dir/"
  [ -f "$VAULT/$label/meta.json" ] && cp "$VAULT/$label/meta.json" "$dir/"
  prune
}
prune() {
  local keep="$KEEP" n=0 dir
  [ -d "$VAULT/.backups" ] || return 0
  for dir in $(ls -1 "$VAULT/.backups" 2>/dev/null | sort -r); do
    n=$((n + 1)); [ "$n" -gt "$keep" ] && rm -rf "$VAULT/.backups/$dir"
  done
}
tree_identity() { if auth_has; then py meta-info "$AUTH"; else say "-"; fi; }
cmd_add() {
  local label="$1" dir meta
  [ -n "$label" ] || die "usage: $ME add <label>"
  case "$label" in *[!a-zA-Z0-9._-]*) die "bad label" ;; esac
  auth_has || die "nothing logged in — run codex login first"
  lock; dir="$VAULT/$label"; mkdir -p "$dir"; chmod 700 "$dir"
  meta="$(py meta-extract "$AUTH" "$dir/meta.json")"
  cp "$AUTH" "$dir/auth.json.tmp" && mv "$dir/auth.json.tmp" "$dir/auth.json"; chmod 600 "$dir/auth.json"
  py reg-upsert "$REG" "$label" "$meta" 1; chmod 600 "$REG"
  say "adopted the current login as '$label'."; cmd_ls
}
cmd_use() {
  local label="$1" force="$2" active dir
  [ -n "$label" ] || die "usage: $ME use <label>"
  dir="$VAULT/$label"
  [ -d "$dir" ] || die "no parked account named '$label'"
  [ -f "$dir/auth.json" ] || die "'$label' has no parked auth.json"
  active="$(py reg-field "$REG" active)"
  if [ "$active" = "$label" ] && auth_has; then say "'$label' is already active."; return 0; fi
  [ "$force" = 1 ] || ! codex_running || die "codex is running — quit it first, or pass --force"
  lock
  if auth_has; then
    [ -n "$active" ] || die "current login not tracked — add it first"
    mkdir -p "$VAULT/$active"; chmod 700 "$VAULT/$active"
    py meta-extract "$AUTH" "$VAULT/$active/meta.json" >/dev/null
    cp "$AUTH" "$VAULT/$active/auth.json.tmp" && mv "$VAULT/$active/auth.json.tmp" "$VAULT/$active/auth.json"
    chmod 600 "$VAULT/$active/auth.json"; snapshot "$active"
  fi
  mkdir -p "$CFG"; chmod 700 "$CFG"
  cp "$dir/auth.json" "$AUTH.tmp" && mv "$AUTH.tmp" "$AUTH"; chmod 600 "$AUTH"
  py reg-activate "$REG" "$label"; say "now using '$label'."; cmd_status
}
cmd_rm() {
  local label="$1" active
  [ -n "$label" ] || die "usage: $ME rm <label>"
  [ -d "$VAULT/$label" ] || die "no parked account named '$label'"
  active="$(py reg-field "$REG" active)"
  [ "$active" = "$label" ] && die "swap to another account first"
  lock; rm -rf "$VAULT/$label"; py reg-forget "$REG" "$label"
  say "forgot '$label'."
}
cmd_ls() { py render "$REG" "$(tree_identity)" "$(auth_has && echo present || echo absent)" ls "$JSON"; }
cmd_status() { py render "$REG" "$(tree_identity)" "$(auth_has && echo present || echo absent)" status "$JSON"; }
cmd_gc() { mkdir -p "$VAULT"; prune; say "kept the newest $KEEP swap backup(s)."; }
usage() { echo "usage: $ME ls|status|add|use|rm|gc" >&2; exit 1; }
VERB="${1:-}"; [ -n "$VERB" ] || usage; shift || true
LABEL=""; JSON=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;; --force) FORCE=1 ;;
    --keep) shift; KEEP="${1:-}" ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$LABEL" ] && LABEL="$1" || die "unexpected argument: $1" ;;
  esac; shift || true
done
command -v python3 >/dev/null 2>&1 || die "python3 is required"
case "$VERB" in
  ls) cmd_ls ;; status) cmd_status ;; add) cmd_add "$LABEL" ;; use) cmd_use "$LABEL" "$FORCE" ;;
  rm) cmd_rm "$LABEL" ;; gc) cmd_gc ;; *) usage ;;
esac
