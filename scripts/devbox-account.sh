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
#   DEVBOX_ACCOUNT_VAULT         vault dir (default ~/.claude-accounts, or
#                                ~/.claude-accounts/<profile> when CLAUDE_CONFIG_DIR is set)
#   DEVBOX_ACCOUNT_BACKUP_KEEP   swap backups to retain (default 3)
#   DEVBOX_ACCOUNT_STORE         file | keychain | auto (default auto: keychain on macOS
#                                for the default tree; file when CLAUDE_CONFIG_DIR is set)
#   DEVBOX_ACCOUNT_PGREP         override the "is claude running" probe (testing seam)
#   DEVBOX_ACCOUNT_PROFILE_URL   where to ask which org a token bills (default Anthropic's
#                                /api/oauth/profile; testing seam)
#   DEVBOX_ACCOUNT_OMP_PIN       1 (default) pin omp to this label's email+org after use;
#                                0 leave omp alone
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
# One vault per config tree. Two Claude profiles sharing ~/.claude-accounts fight over
# `active` and rewrite each other's parked rows. The default tree (no CLAUDE_CONFIG_DIR)
# keeps the historical ~/.claude-accounts path.
if [ -n "${DEVBOX_ACCOUNT_VAULT:-}" ]; then
  VAULT="$DEVBOX_ACCOUNT_VAULT"
elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  VAULT="$HOME/.claude-accounts/$(basename "$CFG")"
else
  VAULT="$HOME/.claude-accounts"
fi
REG="$VAULT/accounts.json"
KEEP="${DEVBOX_ACCOUNT_BACKUP_KEEP:-3}"
KC_SERVICE="Claude Code-credentials"

STORE="${DEVBOX_ACCOUNT_STORE:-auto}"
if [ "$STORE" = auto ]; then
  # macOS keychain is one item named Claude Code-credentials. A second CLAUDE_CONFIG_DIR
  # would clobber the first profile's token, so a relocated tree always uses the file store.
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    STORE=file
  elif [ "$(uname -s)" = Darwin ]; then
    STORE=keychain
  else
    STORE=file
  fi
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
        "orgUuid": acct.get("organizationUuid", ""),
        "orgType": acct.get("organizationType", ""),
        "accountUuid": acct.get("accountUuid", ""),
        "userID": identity.get("userID", ""),
    }


def org_badge(org_type):
    if not org_type:
        return ""
    if org_type in ("claude_team", "claude_enterprise"):
        return "team"
    if org_type == "claude_max":
        return "max"
    if org_type == "claude_pro":
        return "pro"
    return org_type.replace("claude_", "", 1) if org_type.startswith("claude_") else org_type


# OAuth credential files often keep subscriptionType/rateLimitTier from whichever
# workspace was picked at /login time, even after identity-apply restores personal
# org keys. Paseo and `claude auth status` read those fields — align them to the
# parked identity whenever they disagree with organizationType / rate-limit tier.
SUBSCRIPTION_FROM_ORG_TYPE = {
    "claude_max": "max",
    "claude_pro": "pro",
    "claude_team": "team",
    "claude_enterprise": "enterprise",
}


def heal_credential_metadata(identity_path, cred_path):
    identity = load(identity_path)
    acct = identity.get("oauthAccount") or {}
    want_sub = SUBSCRIPTION_FROM_ORG_TYPE.get(acct.get("organizationType") or "")
    want_tier = acct.get("organizationRateLimitTier") or acct.get("userRateLimitTier")
    if not want_sub and not want_tier:
        return False
    cred = load(cred_path, {})
    oauth = cred.setdefault("claudeAiOauth", {})
    changed = False
    if want_sub and oauth.get("subscriptionType") != want_sub:
        oauth["subscriptionType"] = want_sub
        changed = True
    if want_tier and oauth.get("rateLimitTier") != want_tier:
        oauth["rateLimitTier"] = want_tier
        changed = True
    if changed:
        save(cred_path, cred)
    return changed


def tree_matches_registry(tree_info, row):
    if not tree_info or not row:
        return True
    if row.get("accountUuid") and tree_info.get("accountUuid"):
        if row["accountUuid"] != tree_info["accountUuid"]:
            return False
    row_org = row.get("orgUuid") or ""
    tree_org = tree_info.get("orgUuid") or ""
    if row_org and tree_org and row_org != tree_org:
        return False
    return True


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

elif op == "tree-matches-vault":
    state, vault_path = sys.argv[2], sys.argv[3]
    tree_info = info(load(state))
    vault_info = info(load(vault_path))
    row = {
        "accountUuid": vault_info.get("accountUuid"),
        "orgUuid": vault_info.get("orgUuid"),
    }
    sys.exit(0 if tree_matches_registry(tree_info, row) else 1)

elif op == "credential-heal":
    identity_path, cred_path = sys.argv[2], sys.argv[3]
    sys.exit(0 if heal_credential_metadata(identity_path, cred_path) else 1)

elif op == "verify-org":
    # The identity comes from .claude.json and the credential from the store, read
    # separately. With one email on personal Max and a Team seat, a live session or a
    # half-finished /login can leave them naming different orgs; parked like that, the
    # label says personal while every request bills Team. Ask the token itself.
    # Exit 0: same org (or nothing to compare). 3: different org. 2: could not ask.
    import urllib.request
    identity_path, cred_path = sys.argv[2], sys.argv[3]
    want = info(load(identity_path))
    want_org = want["orgUuid"].strip().lower()
    if not want_org:
        sys.exit(0)
    raw = open(cred_path).read().strip()
    try:
        cred = json.loads(raw)
    except ValueError:
        try:
            cred = json.loads(bytes.fromhex(raw).decode())  # macOS keychain stores hex
        except ValueError:
            cred = None
    oauth = (cred.get("claudeAiOauth") or {}) if isinstance(cred, dict) else {}
    token = oauth.get("accessToken")
    if not token:
        print("the credential holds no access token, so its org cannot be checked")
        sys.exit(2)
    url = os.environ.get("DEVBOX_ACCOUNT_PROFILE_URL") or "https://api.anthropic.com/api/oauth/profile"
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            org = json.load(res).get("organization") or {}
    except Exception as exc:
        print("could not ask Anthropic which org this token bills (%s)" % exc)
        sys.exit(2)
    got_org = (org.get("uuid") or "").strip().lower()
    if not got_org:
        print("Anthropic did not say which org this token bills")
        sys.exit(2)
    if got_org != want_org:
        print("the token bills %s (%s) but .claude.json names %s (%s) — run /login, pick %s, then try again"
              % (org.get("name") or "?", got_org, want["org"] or "?", want_org, want["org"] or want_org))
        sys.exit(3)

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
            org = row.get("org", "")
            badge = org_badge(row.get("orgType", ""))
            if badge:
                org = ("%s [%s]" % (org, badge)) if org else "[%s]" % badge
            print("%s %-14s %-32s %-32s %s" % (
                mark, row["label"], row.get("email", ""), org,
                row.get("lastUsedAt", "")))
    else:
        print("active      : %s" % (doc["active"] or "(none tracked)"))
        if tree_info:
            badge = org_badge(tree_info.get("orgType", ""))
            org = tree_info.get("org", "")
            if badge:
                org = ("%s [%s]" % (org, badge)) if org else "[%s]" % badge
            print("tree        : %s%s" % (
                tree_info["email"] or "(no oauthAccount)",
                "  (%s)" % org if org else ""))
        else:
            print("tree        : nothing logged in")
        print("credential  : %s (%s store)" % (doc["credential"], doc["store"]))
        print("parked      : %s" % (", ".join(r["label"] for r in doc["accounts"]) or "none"))

    # A tree that holds an account the registry does not point at is the one state where a
    # swap would silently overwrite an untracked login, so say so loudly.
    if tree_info and doc["active"]:
        row = reg["accounts"].get(doc["active"], {})
        if not tree_matches_registry(tree_info, row):
            held = tree_info["email"] or "(unknown)"
            if tree_info.get("org"):
                held += " / " + tree_info["org"]
            print("warning: the tree holds %s but the registry says %s — run `add <label>` to adopt it"
                  % (held, doc["active"]), file=sys.stderr)

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
    # Paseo and some CLIs read ~/.claude/.credentials.json even when the live store is
    # keychain; keep the file in sync so plan badges match the parked identity.
    cp "$src" "$CFG/.credentials.json.tmp"
    chmod 600 "$CFG/.credentials.json.tmp"
    mv "$CFG/.credentials.json.tmp" "$CFG/.credentials.json"
    rm -f "$CFG/credentials.json"
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
# Pids of `claude` that rewrite THIS tree. A leftover session on ~/.claude must not
# block swapping claude-main, and a live claude-main session must not be ignored just
# because another tree is quiet. Linux reads CLAUDE_CONFIG_DIR from /proc; elsewhere
# any `claude` counts (macOS has no cheap per-pid environ).
tree_claude_pids() {
  local pid envdir
  if [ "$(uname -s)" != Linux ]; then
    pgrep -u "$(id -u)" -x claude 2>/dev/null || true
    return 0
  fi
  for pid in $(pgrep -u "$(id -u)" -x claude 2>/dev/null); do
    envdir="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n 's/^CLAUDE_CONFIG_DIR=//p' | head -1)"
    envdir="${envdir%/}"
    if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
      [ "$envdir" = "$CFG" ] && printf '%s\n' "$pid"
    else
      if [ -z "$envdir" ] || [ "$envdir" = "$HOME/.claude" ]; then
        printf '%s\n' "$pid"
      fi
    fi
  done
}

claude_running() {
  if [ -n "${DEVBOX_ACCOUNT_PGREP:-}" ]; then
    # shellcheck disable=SC2086
    $DEVBOX_ACCOUNT_PGREP >/dev/null 2>&1
  else
    [ -n "$(tree_claude_pids)" ]
  fi
}

# --force lets the swap proceed while Claude is live. That is enough to land the vault
# row on disk, but not enough to keep it: interactive Claude and `claude remote-control`
# rewrite oauthAccount from the cloud session's current org (personal vs Team) within
# seconds. Tell the operator so "now using <label>" is not read as a sticky /status.
warn_live_writers() {
  claude_running || return 0
  say "warning: a live Claude process is still running. It rewrites oauthAccount from the cloud session, so this tree can snap back to that session's org (Team vs personal) within seconds."
  say "         Quit Claude, or have the operator restart agent-rc after /login on the org you want. Team Remote Control on this same profile will keep pulling Team back."
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

# Capture the tree's identity + credential into vault dir $1, committing them only when
# the token bills the org the identity names. 0: committed (a check that could not run
# only warns). 1: mismatch — the pair is left as *.new and CAPTURE_WHY says why.
# Called from `if`, where set -e is off, so every step checks itself.
capture() {
  local dir="$1" rc=0
  mkdir -p "$dir" && chmod 700 "$dir" || die "could not create $dir"
  py identity-extract "$STATE" "$dir/identity.json.new" >/dev/null || exit 1
  store_save "$dir/credentials.json.new" || die "could not copy the credential into $dir"
  CAPTURE_WHY="$(py verify-org "$dir/identity.json.new" "$dir/credentials.json.new")" || rc=$?
  case "$rc" in
    0) ;;
    3) return 1 ;;
    *) printf '%s: warning: %s; parked as .claude.json describes it\n' "$ME" "${CAPTURE_WHY:-org check failed}" >&2 ;;
  esac
  mv -f "$dir/identity.json.new" "$dir/identity.json" \
    && mv -f "$dir/credentials.json.new" "$dir/credentials.json" \
    || die "could not commit the parked pair in $dir"
}

cmd_add() {
  local label="$1" dir meta acct
  [ -n "$label" ] || die "usage: $ME add <label>"
  case "$label" in *[!a-zA-Z0-9._-]*) die "label may only contain letters, digits, '.', '_' and '-'" ;; esac
  store_has || die "nothing is logged in under $CFG — log in first (\`claude\` then /login), then adopt it"
  lock
  dir="$VAULT/$label"
  if ! capture "$dir"; then
    rm -f "$dir/identity.json.new" "$dir/credentials.json.new"
    rmdir "$dir" 2>/dev/null || true
    die "refusing to park '$label': $CAPTURE_WHY"
  fi
  meta="$(py identity-info "$dir/identity.json")"
  py credential-heal "$dir/identity.json" "$dir/credentials.json" >/dev/null 2>&1 || true
  acct="$(store_acct)"
  py reg-upsert "$REG" "$label" "$meta" "$acct"
  chmod 600 "$REG"
  say "adopted the current login as '$label'."
  cmd_ls
}

cmd_use() {
  local label="$1" force="$2" active dir heal_only=0 stash pids
  [ -n "$label" ] || die "usage: $ME use <label>"
  dir="$VAULT/$label"
  [ -d "$dir" ] || die "no parked account named '$label' — \`$ME ls\` shows what there is"
  [ -f "$dir/identity.json" ] || die "'$label' has no identity.json — re-adopt it with \`$ME add $label\`"
  [ -f "$dir/credentials.json" ] || die "'$label' has no parked credential — re-adopt it with \`$ME add $label\`"
  active="$(py reg-field "$REG" active)"
  if [ "$active" = "$label" ] && store_has; then
    if py tree-matches-vault "$STATE" "$dir/identity.json" >/dev/null 2>&1; then
      if [ "$force" != 1 ]; then
        py credential-heal "$dir/identity.json" "$dir/credentials.json" >/dev/null 2>&1 || true
        store_load "$dir/credentials.json" "$(py reg-keychain-acct "$REG" "$label")"
        say "'$label' is already active."
        omp_pin_after_use "$label"
        return 0
      fi
      heal_only=1
    else
      say "'$label' is active in the registry but the tree differs — restoring from vault."
      heal_only=1
    fi
  fi

  if [ "$force" != 1 ] && claude_running; then
    if [ -z "${DEVBOX_ACCOUNT_PGREP:-}" ]; then
      pids="$(tree_claude_pids | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    fi
    if [ -n "$pids" ]; then
      die "claude is running on this tree (pid $pids) — it rewrites .claude.json under us and concurrent writes corrupt it (claude-code#28992). Quit that session, then retry, or pass --force."
    fi
    die "claude is running — it rewrites .claude.json under us and concurrent writes corrupt it (claude-code#28992). Quit it, or pass --force."
  fi

  lock
  if [ "$active" = "$label" ] && [ "$heal_only" != 1 ]; then
    say "'$label' is already active but the tree has no credential — restoring it."
  fi

  # Park what is there BEFORE touching anything, and refuse rather than destroy a login
  # the registry does not know about. When healing registry/tree drift for the active label,
  # the vault row is the source of truth — never overwrite it with the stale tree.
  if store_has && [ "$heal_only" != 1 ]; then
    [ -n "$active" ] || die "the current login is not tracked — \`$ME add <label>\` it first so this swap cannot lose it"
    if capture "$VAULT/$active"; then
      snapshot "$active"
    else
      # The vault row stays as last parked; the mismatched pair is kept, not lost.
      stash="$VAULT/.backups/$(date +%s)-$active-mismatch"
      mkdir -p "$stash" && chmod 700 "$VAULT/.backups" "$stash"
      mv -f "$VAULT/$active/identity.json.new" "$stash/identity.json"
      mv -f "$VAULT/$active/credentials.json.new" "$stash/credentials.json"
      printf '%s: warning: not re-parking %s: %s. That pair is kept in %s\n' \
        "$ME" "$active" "$CAPTURE_WHY" "$stash" >&2
      prune
    fi
  fi

  py identity-apply "$STATE" "$dir/identity.json"
  py credential-heal "$dir/identity.json" "$dir/credentials.json" >/dev/null 2>&1 || true
  store_load "$dir/credentials.json" "$(py reg-keychain-acct "$REG" "$label")"
  if [ "$STORE" = file ]; then
    py credential-heal "$dir/identity.json" "$CFG/.credentials.json" >/dev/null 2>&1 || true
  fi
  py reg-activate "$REG" "$label"
  say "now using '$label'."
  cmd_status
  warn_live_writers
  omp_pin_after_use "$label"
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

omp_pin_after_use() {
  local label="$1"
  [ "${DEVBOX_ACCOUNT_OMP_PIN:-1}" = "0" ] && return 0
  local script="${DEVBOX_OMP_PIN_SCRIPT:-}"
  if [ -z "$script" ]; then
    local engine_dir
    engine_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
    for candidate in \
      "/usr/local/share/remote-devbox/omp-pin-after-use.py" \
      "${HOME:-}/.local/share/remote-devbox/omp-pin-after-use.py" \
      "$engine_dir/omp-pin-after-use.py"; do
      if [ -f "$candidate" ]; then
        script="$candidate"
        break
      fi
    done
  fi
  [ -n "$script" ] || return 0
  python3 "$script" "$label" >&2 || true
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
