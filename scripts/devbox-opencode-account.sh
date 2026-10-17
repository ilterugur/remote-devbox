#!/usr/bin/env bash
# Managed by remote-devbox. Manual OpenCode account swap — one OMP profile tree, a vault
# of parked opencode-* api_key rows beside it.
set -euo pipefail

ME="devbox-opencode-account"
die() { printf '%s: %s\n' "$ME" "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

CFG="${PI_CODING_AGENT_DIR:-$HOME/.agent-profiles/omp-main}"
CFG="${CFG%/}"
DB="$CFG/agent.db"
VAULT="${DEVBOX_OPENCODE_ACCOUNT_VAULT:-$HOME/.opencode-accounts}"
REG="$VAULT/accounts.json"
KEEP="${DEVBOX_OPENCODE_ACCOUNT_BACKUP_KEEP:-3}"

PY='
import json, os, sqlite3, sys, time

PROVIDER_PREFIX = "opencode-"


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


def registry(path):
    reg = load(path, {})
    reg.setdefault("version", 1)
    reg.setdefault("active", None)
    reg.setdefault("accounts", {})
    return reg


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def key_hint(data):
    try:
        key = json.loads(data).get("key") or ""
    except Exception:
        return ""
    key = str(key)
    if not key:
        return ""
    if len(key) <= 12:
        return key
    return key[:6] + "…" + key[-4:]


def connect(db_path):
    if not os.path.isfile(db_path):
        sys.exit("no agent.db at %s — log in to omp first" % db_path)
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA busy_timeout = 3000")
    return con


def has_auth_table(con):
    return bool(con.execute(
        "SELECT 1 FROM sqlite_master WHERE type=? AND name=?", ("table", "auth_credentials")
    ).fetchone())


def read_opencode_rows(con):
    rows = list(con.execute(
        "SELECT id, provider, data FROM auth_credentials "
        "WHERE provider LIKE ? AND credential_type = ? ORDER BY provider",
        (PROVIDER_PREFIX + "%", "api_key"),
    ))
    return [{"id": r[0], "provider": r[1], "data": r[2]} for r in rows]


def rows_have_key(rows):
    for row in rows:
        try:
            if json.loads(row["data"]).get("key"):
                return True
        except Exception:
            pass
    return False


def meta_from_rows(rows):
    hint = ""
    for row in rows:
        if row["provider"] == "opencode-go":
            hint = key_hint(row["data"])
            break
    if not hint:
        for row in rows:
            hint = key_hint(row["data"])
            if hint:
                break
    return {"keyHint": hint, "providers": sorted(r["provider"] for r in rows)}


def write_credentials(path, rows):
    save(path, {"version": 1, "rows": rows})


def apply_rows(con, rows):
    for row in rows:
        provider = row["provider"]
        data = row["data"]
        existing = con.execute(
            "SELECT id FROM auth_credentials WHERE provider = ? AND credential_type = ?",
            (provider, "api_key"),
        ).fetchone()
        if existing:
            con.execute(
                "UPDATE auth_credentials SET data = ?, updated_at = CAST(strftime(\"%s\",\"now\") AS INTEGER) "
                "WHERE id = ?",
                (data, existing[0]),
            )
        else:
            con.execute(
                "INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)",
                (provider, "api_key", data),
            )
    if con.execute("SELECT 1 FROM sqlite_master WHERE type=? AND name=?", ("table", "auth_change_revision")).fetchone():
        con.execute("UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1")


def rows_from_key(api_key):
    data = json.dumps({"key": api_key, "source": "login"}, separators=(",", ":"))
    return [{"id": None, "provider": "opencode-go", "data": data}]


op = sys.argv[1]

if op == "extract":
    db_path, out_cred, out_meta = sys.argv[2], sys.argv[3], sys.argv[4]
    con = connect(db_path)
    try:
        if not has_auth_table(con):
            sys.exit("auth_credentials table missing in %s" % db_path)
        rows = read_opencode_rows(con)
        if not rows_have_key(rows):
            sys.exit("no opencode api_key in %s" % db_path)
        write_credentials(out_cred, rows)
        save(out_meta, meta_from_rows(rows))
        print(json.dumps(meta_from_rows(rows)))
    finally:
        con.close()

elif op == "apply":
    db_path, cred_path = sys.argv[2], sys.argv[3]
    parked = load(cred_path)
    rows = parked.get("rows") or []
    if not rows:
        sys.exit("no rows in %s" % cred_path)
    con = connect(db_path)
    try:
        if not has_auth_table(con):
            sys.exit("auth_credentials table missing in %s" % db_path)
        con.execute("BEGIN")
        apply_rows(con, rows)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()

elif op == "tree-info":
    db_path = sys.argv[2]
    if not os.path.isfile(db_path):
        print("-")
        sys.exit(0)
    con = connect(db_path)
    try:
        if not has_auth_table(con):
            print("-")
            sys.exit(0)
        rows = read_opencode_rows(con)
        if not rows_have_key(rows):
            print("-")
        else:
            print(json.dumps(meta_from_rows(rows)))
    finally:
        con.close()

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
    doc = {
        "active": reg["active"],
        "credential": cred_state,
        "tree": tree_info,
        "accounts": [dict(label=label, **{k: v for k, v in row.items()}) for label, row in sorted(reg["accounts"].items())],
    }
    if as_json == "1":
        print(json.dumps(doc, indent=2))
        sys.exit(0)
    if mode == "ls":
        if not doc["accounts"]:
            print("no accounts parked yet")
        for row in doc["accounts"]:
            mark = "*" if row["label"] == doc["active"] else " "
            hint = row.get("keyHint", "")
            print("%s %-14s %-24s %s" % (mark, row["label"], hint, row.get("lastUsedAt", "")))
    else:
        print("active      : %s" % (doc["active"] or "(none tracked)"))
        if tree_info and tree_info.get("keyHint"):
            extra = ("  [%s]" % ", ".join(tree_info.get("providers") or [])) if tree_info.get("providers") else ""
            print("tree        : %s%s" % (tree_info["keyHint"], extra))
        else:
            print("tree        : nothing logged in")
        print("credential  : %s" % doc["credential"])
        print("parked      : %s" % (", ".join(r["label"] for r in doc["accounts"]) or "none"))

elif op == "rows-from-key":
    out_cred, out_meta, api_key = sys.argv[2], sys.argv[3], sys.argv[4]
    rows = rows_from_key(api_key)
    write_credentials(out_cred, rows)
    save(out_meta, meta_from_rows(rows))
    print(json.dumps(meta_from_rows(rows)))

else:
    sys.exit("unknown op %r" % op)
'
py() { python3 -c "$PY" "$@"; }

db_has() {
  [ -f "$DB" ] && py tree-info "$DB" 2>/dev/null | grep -qv '^-$'
}

omp_running() {
  if [ -n "${DEVBOX_OPENCODE_ACCOUNT_PGREP:-}" ]; then $DEVBOX_OPENCODE_ACCOUNT_PGREP >/dev/null 2>&1
  else pgrep -x omp >/dev/null 2>&1 || pgrep -f 'pi-coding-agent' >/dev/null 2>&1; fi
}
lock() {
  mkdir -p "$VAULT"; chmod 700 "$VAULT"
  mkdir "$VAULT/.lock" 2>/dev/null || die "another swap is in progress"
  trap 'rmdir "$VAULT/.lock" 2>/dev/null || true' EXIT
}
snapshot() {
  local label="$1" dir="$VAULT/.backups/$(date +%s)-$1"
  mkdir -p "$dir"; chmod 700 "$VAULT/.backups" "$dir"
  [ -f "$VAULT/$label/credentials.json" ] && cp "$VAULT/$label/credentials.json" "$dir/"
  [ -f "$VAULT/$label/meta.json" ] && cp "$VAULT/$label/meta.json" "$dir/"
  prune
}
prune() {
  local keep="$KEEP" n=0 dir
  [ -d "$VAULT/.backups" ] || return 0
  for dir in $(ls -1 "$VAULT/.backups" 2>/dev/null | sort -r); do
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then rm -rf "$VAULT/.backups/$dir"; fi
  done
}
tree_identity() { if db_has; then py tree-info "$DB"; else say "-"; fi; }

cmd_add() {
  local label="$1" api_key="${2:-}"
  [ -n "$label" ] || die "usage: $ME add <label> [--key <apikey>]"
  case "$label" in *[!a-zA-Z0-9._-]*) die "bad label" ;; esac
  lock; dir="$VAULT/$label"; mkdir -p "$dir"; chmod 700 "$dir"
  if [ -n "$api_key" ]; then
    meta="$(py rows-from-key "$dir/credentials.json" "$dir/meta.json" "$api_key")"
    mkdir -p "$CFG"; chmod 700 "$CFG"
    py apply "$DB" "$dir/credentials.json"
  else
    db_has || die "nothing logged in — /login opencode-go inside omp first"
    meta="$(py extract "$DB" "$dir/credentials.json" "$dir/meta.json")"
  fi
  chmod 600 "$dir/credentials.json" "$dir/meta.json"
  py reg-upsert "$REG" "$label" "$meta" 1; chmod 600 "$REG"
  say "adopted '$label'."; cmd_ls
}

cmd_use() {
  local label="$1" force="$2" active dir
  [ -n "$label" ] || die "usage: $ME use <label>"
  dir="$VAULT/$label"
  [ -d "$dir" ] || die "no parked account named '$label'"
  [ -f "$dir/credentials.json" ] || die "'$label' has no parked credentials.json"
  active="$(py reg-field "$REG" active)"
  if [ "$active" = "$label" ] && db_has; then
    parked_hint="$(python3 -c 'import json;print(json.load(open("'$dir/meta.json'"))["keyHint"])' 2>/dev/null || true)"
    tree_hint="$(py tree-info "$DB" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("keyHint",""))' 2>/dev/null || true)"
    if [ -n "$parked_hint" ] && [ "$parked_hint" = "$tree_hint" ]; then
      say "'$label' is already active."
      return 0
    fi
  fi
  [ "$force" = 1 ] || ! omp_running || die "omp is running — quit it first, or pass --force"
  lock
  if db_has; then
    [ -n "$active" ] || die "current login not tracked — add it first"
    mkdir -p "$VAULT/$active"; chmod 700 "$VAULT/$active"
    py extract "$DB" "$VAULT/$active/credentials.json" "$VAULT/$active/meta.json" >/dev/null
    chmod 600 "$VAULT/$active/credentials.json" "$VAULT/$active/meta.json"
    snapshot "$active"
  fi
  mkdir -p "$CFG"; chmod 700 "$CFG"
  py apply "$DB" "$dir/credentials.json"
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

cmd_ls() { py render "$REG" "$(tree_identity)" "$(db_has && echo present || echo absent)" ls "$JSON"; }
cmd_status() { py render "$REG" "$(tree_identity)" "$(db_has && echo present || echo absent)" status "$JSON"; }
cmd_gc() { mkdir -p "$VAULT"; prune; say "kept the newest $KEEP swap backup(s)."; }

usage() { echo "usage: $ME ls|status|add|use|rm|gc" >&2; exit 1; }
VERB="${1:-}"; [ -n "$VERB" ] || usage; shift || true
LABEL=""; JSON=0; FORCE=0; API_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;; --force) FORCE=1 ;;
    --keep) shift; KEEP="${1:-}" ;;
    --key) shift; API_KEY="${1:-}"; [ -n "$API_KEY" ] || die "--key needs a value" ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$LABEL" ] && LABEL="$1" || die "unexpected argument: $1" ;;
  esac; shift || true
done
command -v python3 >/dev/null 2>&1 || die "python3 is required"
case "$VERB" in
  ls) cmd_ls ;; status) cmd_status ;;
  add) cmd_add "$LABEL" "$API_KEY" ;;
  use) cmd_use "$LABEL" "$FORCE" ;;
  rm) cmd_rm "$LABEL" ;; gc) cmd_gc ;; *) usage ;;
esac
