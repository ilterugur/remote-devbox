#!/usr/bin/env python3
"""Register the dev box in your editors, one entry per profile.

Run on your CLIENT from the repo (or pass --repo). Reads ansible/inventory.ini +
ansible/group_vars/all.yml and writes:

  * ~/.ssh/config            — a managed `Host devbox-<user>` block per profile.
                               Covers VS Code / Cursor Remote-SSH, plain ssh, and
                               Zed (Zed shells out to ssh, inheriting the alias).
  * ~/.config/zed/settings.json — `ssh_connections` referencing those aliases,
                               pre-listing each profile's ~/projects/<name>.
  * your shell rc (~/.zshrc / ~/.bashrc) — a `devbox-<user>` function per profile
                               that connects over mosh (falls back to ssh) into a
                               persistent tmux session, so a dropped connection
                               never loses work. mosh needs this client on the
                               box's Tailscale net (mosh UDP is tailscale-only).

Idempotent: rewrites only its own managed block / its own connection entries, and
backs up each file first. Zed is skipped unless Zed is installed or --zed is given.

  python3 scripts/gen-editor-config.py [--repo PATH] [--prefix devbox] [--host H]
       [--default PROFILE] [--launch CMD] [--locale L] [--no-zed|--zed]
       [--no-shell|--shell-rc PATH]

The generated `<prefix>` command uses a remembered ACTIVE profile. Bare `<prefix>`
opens an interactive picker (fuzzy if `fzf` is installed, else a numbered menu) of
HOME / new project / the profile's projects — UNLESS run inside a local git repo whose
origin matches a box project, which it opens directly (`-m` forces the picker):
  <prefix>                    pick — or git-auto-open — for the active profile
  <prefix> <project>          active profile, in ~/projects/<project>
  <prefix> -p <profile> [proj] override the profile for one call
  <prefix> -m                 force the picker (skip git auto-open)
  <prefix> use [<profile>]    show, or set, the remembered active profile
  <prefix> ls [profile]       list open tmux sessions
  <prefix> -s [project]       plain shell (skip the --launch command), when --launch is set
The tmux session is named after the project, so each project keeps its own re-attachable
session. The active profile is persisted in ~/.config/remote-devbox/active-profile.
"""
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

BEGIN = "# >>> remote-devbox (managed) >>>"
END = "# <<< remote-devbox <<<"


def die(msg):
    sys.exit(f"error: {msg}")


def find_repo(arg):
    if arg:
        return os.path.abspath(os.path.expanduser(arg))
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.dirname(here)  # repo root (scripts/..)
    if os.path.exists(os.path.join(cand, "ansible", "playbook.yml")):
        return cand
    die("couldn't locate the remote-devbox repo; pass --repo PATH")


def connect_host(repo, override, v):
    """The host the `devbox-*` ssh aliases (and mosh) connect to. Precedence:
    --host > group_vars `connect_host` > inventory.ini `ansible_host`. The group_vars
    value lets a hardened box pin the Tailscale IP for connect (mosh's UDP range is
    opened on tailscale0 only) while Ansible keeps provisioning over the public IP."""
    if override:
        return override
    if v.get("connect_host"):
        return v["connect_host"]
    inv = os.path.join(repo, "ansible", "inventory.ini")
    if os.path.exists(inv):
        m = re.search(r"ansible_host\s*=\s*(\S+)", open(inv).read())
        if m:
            return m.group(1)
    die("no connect_host in group_vars/all.yml and no ansible_host in inventory.ini; pass --host")


def load_vars(repo):
    try:
        import yaml
    except ImportError:
        die("PyYAML needed: `pip install pyyaml` (or run from the ansible venv)")
    path = os.path.join(repo, "ansible", "group_vars", "all.yml")
    if not os.path.exists(path):
        die("ansible/group_vars/all.yml not found — set up the box first")
    return yaml.safe_load(open(path)) or {}


def ssh_block(profiles, host, key, prefix):
    out = [BEGIN]
    for p in profiles:
        out += [
            f"Host {prefix}-{p['user']}",
            f"    HostName {host}",
            f"    User {p['user']}",
            f"    IdentityFile {key}",
            "    Port 22",
            "    IdentitiesOnly yes",
            "",
        ]
    out.append(END)
    return "\n".join(out) + "\n"


def write_ssh_config(block):
    path = os.path.expanduser("~/.ssh/config")
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    existing = open(path).read() if os.path.exists(path) else ""
    if existing:
        shutil.copy2(path, path + ".bak")
    # Strip a previous managed block, then append the new one.
    stripped = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", existing, flags=re.S)
    new = (stripped.rstrip() + "\n\n" if stripped.strip() else "") + block
    with open(path, "w") as f:
        f.write(new)
    os.chmod(path, 0o600)
    print(f"  ✓ ~/.ssh/config updated (backup: ~/.ssh/config.bak)")


def zed_entries(profiles, prefix):
    entries = []
    for p in profiles:
        projects = [{"paths": [f"~/projects/{pr['name']}"]} for pr in (p.get("projects") or [])]
        entries.append({"host": f"{prefix}-{p['user']}", "nickname": f"remote-devbox · {p['user']}", "projects": projects})
    return entries


def write_zed(entries, prefix, forced):
    cfg_dir = os.path.expanduser("~/.config/zed")
    path = os.path.join(cfg_dir, "settings.json")
    if not forced and not os.path.isdir(cfg_dir):
        print("  – Zed not detected (no ~/.config/zed); skipping. Use --zed to force.")
        return
    snippet = json.dumps({"ssh_connections": entries}, indent=2, ensure_ascii=False)
    if os.path.exists(path):
        try:
            data = json.load(open(path))
        except (json.JSONDecodeError, ValueError):
            print("  ! ~/.config/zed/settings.json has comments/JSON5 — not editing it.")
            print("    Paste this `ssh_connections` block in yourself:\n")
            print(snippet)
            return
        shutil.copy2(path, path + ".bak")
    else:
        os.makedirs(cfg_dir, exist_ok=True)
        data = {}
    others = [c for c in data.get("ssh_connections", []) if not str(c.get("host", "")).startswith(prefix + "-")]
    data["ssh_connections"] = others + entries
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  ✓ ~/.config/zed/settings.json updated (backup alongside if it existed)")


def norm_repo(url):
    """Normalize a git remote URL to host/owner/repo (lowercased, no scheme/.git) so
    https and git@ forms of the same repo compare equal. Must mirror the shell `_norm`."""
    u = url.strip().lower()
    u = re.sub(r"^[a-z+]+://", "", u)   # scheme
    u = re.sub(r"^git@", "", u)
    u = re.sub(r"^[^@/]*@", "", u)       # user@
    u = u.replace(":", "/", 1)           # git@host:path -> host/path
    u = u.rstrip("/")
    u = re.sub(r"\.git$", "", u)
    return u.rstrip("/")


# Bash template for the connect command. @@PLACEHOLDERS@@ are substituted in shell_block.
_DEVBOX_TEMPLATE = r'''_@@PFX@@_norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's#^[a-z+]+://##; s#^git@##; s#^[^@/]*@##; s#:#/#; s#/+$##; s#\.git$##; s#/+$##'; }
_@@PFX@@_q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }  # POSIX single-quote a value
_@@PFX@@_match() {  # echo "<profile> <project>" if $PWD's git origin is a known box project
  command -v git >/dev/null 2>&1 || return 1
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  local u; u="$(git remote get-url origin 2>/dev/null)"; [ -n "$u" ] || return 1
  case "$(_@@PFX@@_norm "$u")" in
@@REPOCASES@@    *) return 1 ;;
  esac
}
_@@PFX@@_projects() {  # echo a profile's known projects, one per line
  case "${1:-}" in
@@PROJCASES@@    *) ;;
  esac
}
_@@PFX@@_newhelp() {
  cat >&2 <<'EOH'
To add a project on the box, edit the remote-devbox repo then re-run the playbook:
  1) ansible/group_vars/all.yml -> add under that profile's projects:
       - { name: myproj, repo: "git@github.com:org/myproj.git", branch: main }
  2) cd ansible && ansible-playbook -i inventory.ini playbook.yml --tags projects
  3) private repo? add the profile's SSH key to GitHub, then re-run.
Then connect with:  @@PFX@@ myproj
EOH
}
_@@PFX@@_pick() {  # $1=profile; echo __home__ | __new__ | <project>; non-zero on cancel
  local prof="$1" items sel HOME_ITEM NEW_ITEM
  HOME_ITEM="[ open in HOME - no project ]"
  NEW_ITEM="[ + create a new project ]"
  items="$(printf '%s\n%s\n' "$HOME_ITEM" "$NEW_ITEM"; _@@PFX@@_projects "$prof")"
  if command -v fzf >/dev/null 2>&1; then
    sel="$(printf '%s\n' "$items" | fzf --prompt="@@PFX@@ $prof > " --height=40% --reverse --no-multi --no-sort)" || return 1
  else
    { printf 'Select for profile %s (number):\n' "$prof"; printf '%s\n' "$items" | nl -ba -w2 -s') '; printf 'number > '; } >&2
    local n; IFS= read -r n || return 1
    case "$n" in ''|*[!0-9]*) return 1 ;; esac
    sel="$(printf '%s\n' "$items" | sed -n "${n}p" 2>/dev/null)"
  fi
  [ -n "$sel" ] || return 1
  if [ "$sel" = "$HOME_ITEM" ]; then echo __home__
  elif [ "$sel" = "$NEW_ITEM" ]; then echo __new__
  else echo "$sel"; fi
}
@@PFX@@() {
  local STATE="$HOME/.config/remote-devbox/active-profile"
  local prof proj sess dir h nolaunch= povr= menu=
  if [ "${1:-}" = use ] || [ "${1:-}" = profile ]; then
    if [ -z "${2:-}" ]; then prof="$(cat "$STATE" 2>/dev/null)"; echo "active profile: ${prof:-@@DEFAULT@@}"; return; fi
    case " @@USERS@@ " in *" $2 "*) ;; *) @@BADP@@ "$2" >&2; return 1 ;; esac
    mkdir -p "${STATE%/*}" && printf '%s\n' "$2" > "$STATE" && echo "active profile -> $2"; return
  fi
  if [ "${1:-}" = ls ] || [ "${1:-}" = -l ] || [ "${1:-}" = --list ]; then
    povr="${2:-}"; @@RESOLVE@@
    case " @@USERS@@ " in *" $prof "*) ;; *) @@BADP@@ "$prof" >&2; return 1 ;; esac
    @@LOC@@ ssh "@@PFX@@-$prof" "tmux ls 2>/dev/null || echo '(no open sessions)'"; return
  fi
  while [ $# -gt 0 ]; do case "$1" in
    -p|--profile) povr="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    -m|--menu|--pick) menu=1; shift ;;
@@SFLAG@@    --) shift; break ;;
    -?*) printf '@@PFX@@: unknown option %s\n' "$1" >&2; return 1 ;;
    *) break ;;
  esac; done
  @@RESOLVE@@
  case " @@USERS@@ " in *" $prof "*) ;; *) @@BADP@@ "$prof" >&2; return 1 ;; esac
  proj="${1:-}"
  if [ -z "$proj" ]; then
    if [ -z "$menu" ]; then local m; if m="$(_@@PFX@@_match)"; then prof="${m%% *}"; proj="${m#* }"; fi; fi
    if [ -z "$proj" ]; then
      local sel; sel="$(_@@PFX@@_pick "$prof")" || return 0
      if [ "$sel" = __home__ ]; then proj=
      elif [ "$sel" = __new__ ]; then _@@PFX@@_newhelp; return 0
      else proj="$sel"; fi
    fi
  fi
  if [ -n "$proj" ]; then sess="$proj"; dir="/home/$prof/projects/$proj"; else sess=main; dir="/home/$prof"; fi
  h="@@PFX@@-$prof"
@@CONNECT@@
}'''


def shell_block(profiles, prefix, default, locale, launch):
    users = " ".join(p["user"] for p in profiles)
    loc = f"LANG={locale} LC_ALL={locale} LC_CTYPE={locale}"
    badp = f"printf '{prefix}: unknown profile \"%s\" (have: {users})\\n'"
    resolve = ('prof="$povr"; [ -n "$prof" ] || prof="$(cat "$STATE" 2>/dev/null)"; '
               '[ -n "$prof" ] || prof="@@DEFAULT@@"')
    run = f"bash -lc '{launch}; exec bash'" if launch else ""
    sflag = "    -s|--shell) nolaunch=1; shift ;;\n" if launch else ""
    if launch:
        connect = (
            '  if command -v mosh >/dev/null 2>&1; then\n'
            '    if [ -n "$nolaunch" ]; then @@LOC@@ mosh "$h" -- tmux new -A -s "$sess" -c "$dir"\n'
            '    else @@LOC@@ mosh "$h" -- tmux new -A -s "$sess" -c "$dir" "@@RUN@@"; fi\n'
            '  else\n'
            "    if [ -n \"$nolaunch\" ]; then @@LOC@@ ssh -t \"$h\" \"tmux new -A -s $(_@@PFX@@_q \"$sess\") -c $(_@@PFX@@_q \"$dir\")\"\n"
            "    else @@LOC@@ ssh -t \"$h\" \"tmux new -A -s $(_@@PFX@@_q \"$sess\") -c $(_@@PFX@@_q \"$dir\") \\\"@@RUN@@\\\"\"; fi\n"
            '  fi'
        )
    else:
        connect = (
            '  if command -v mosh >/dev/null 2>&1; then @@LOC@@ mosh "$h" -- tmux new -A -s "$sess" -c "$dir"\n'
            "  else @@LOC@@ ssh -t \"$h\" \"tmux new -A -s $(_@@PFX@@_q \"$sess\") -c $(_@@PFX@@_q \"$dir\")\"; fi"
        )
    # git auto-detect map (normalized repo -> "profile project") + per-profile project lists
    repo_arms, proj_arms = [], []
    for p in profiles:
        names = [pr["name"] for pr in (p.get("projects") or [])]
        if names:
            proj_arms.append(f"    {p['user']}) printf '%s\\n' {' '.join(names)} ;;")
        for pr in (p.get("projects") or []):
            if pr.get("repo"):
                repo_arms.append(f"    {norm_repo(pr['repo'])}) echo '{p['user']} {pr['name']}'; return 0 ;;")
    repocases = ("\n".join(repo_arms) + "\n") if repo_arms else ""
    projcases = ("\n".join(proj_arms) + "\n") if proj_arms else ""

    body = _DEVBOX_TEMPLATE
    for ph, val in (("@@CONNECT@@", connect), ("@@SFLAG@@", sflag), ("@@BADP@@", badp),
                    ("@@RESOLVE@@", resolve), ("@@REPOCASES@@", repocases), ("@@PROJCASES@@", projcases)):
        body = body.replace(ph, val)
    for ph, val in (("@@RUN@@", run), ("@@LOC@@", loc), ("@@USERS@@", users),
                    ("@@DEFAULT@@", default), ("@@PFX@@", prefix)):
        body = body.replace(ph, val)

    head = [
        f"# `{prefix} [project]` — mosh+tmux (falls back to ssh) into a persistent session.",
        "# Uses a remembered ACTIVE profile (set once via `use`). Bare `" + prefix + "` opens an",
        "# interactive picker (fuzzy when fzf is installed) of HOME / new / your projects —",
        "# unless run inside a local git repo that matches a box project, which it opens",
        "# directly (use `-m` to force the picker).",
        f"#   {prefix}                   pick — or git-auto-open — for the active profile",
        f"#   {prefix} <project>         active profile, in ~/projects/<project>",
        f"#   {prefix} -p <profile> ...  use <profile> for this call only",
        f"#   {prefix} -m                force the picker (skip git auto-open)",
        f"#   {prefix} use [<profile>]   show, or set, the remembered active profile",
        f"#   {prefix} ls [profile]      list open tmux sessions",
    ]
    if launch:
        head.append(f"#   {prefix} -s [project]      plain shell (skip the auto-`{launch}`)")
    head.append("# mosh needs this client on the box's Tailscale net (mosh UDP is tailscale-only).")

    return BEGIN + "\n" + "\n".join(head) + "\n" + body + "\n" + END + "\n"


def shell_rc_path(override):
    if override:
        return os.path.expanduser(override)
    home = os.path.expanduser("~")
    sh = os.environ.get("SHELL", "")
    if "zsh" in sh:
        return os.path.join(home, ".zshrc")
    if "bash" in sh:
        return os.path.join(home, ".bashrc")
    for cand in (".zshrc", ".bashrc"):
        if os.path.exists(os.path.join(home, cand)):
            return os.path.join(home, cand)
    return os.path.join(home, ".zshrc")


def write_shell_rc(block, path):
    existing = open(path).read() if os.path.exists(path) else ""
    if existing:
        shutil.copy2(path, path + ".bak")
    stripped = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", existing, flags=re.S)
    new = (stripped.rstrip() + "\n\n" if stripped.strip() else "") + block
    with open(path, "w") as f:
        f.write(new)
    short = path.replace(os.path.expanduser("~"), "~")
    print(f"  ✓ {short} updated (backup: {short}.bak) — open a new terminal or `source {short}`")


def strip_managed_block(path):
    """Remove our managed block from a file (used to drop the shell function when the
    Bun CLI is installed, so the CLI on PATH isn't shadowed by a shell function)."""
    if not os.path.exists(path):
        return
    existing = open(path).read()
    if BEGIN not in existing:
        return
    shutil.copy2(path, path + ".bak")
    stripped = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", existing, flags=re.S)
    with open(path, "w") as f:
        f.write(re.sub(r"\n\n\n+", "\n\n", stripped))
    short = path.replace(os.path.expanduser("~"), "~")
    print(f"  ✓ removed the shell function from {short} (the CLI on PATH is now `{os.path.basename(path)}`'s devbox)")


def write_cli_config(profiles, prefix, host, default, locale, launch, repo):
    """Write ~/.config/remote-devbox/config.json for the Bun CLI to read."""
    cfg = {
        "prefix": prefix,
        "host": host,
        "default": default,
        "locale": locale,
        "launch": launch,
        "repoPath": repo,  # so `devbox add --write` can find ansible/group_vars/all.yml
        "profiles": [
            {"user": p["user"],
             "projects": [{"name": pr["name"], "repo": pr.get("repo", "")} for pr in (p.get("projects") or [])],
             **({"lazyMounts": [{"label": m["label"], "path": m["path"]} for m in p["lazy_mounts"]]} if p.get("lazy_mounts") else {}),
             **({"syncEngine": p["sync_engine"]} if p.get("sync_engine") else {}),
             **({"syncDisk": True} if p.get("sync_disk") else {}),
             **({"lazyMountOnConnect": True} if p.get("lazy_mount_on_connect") else {}),
             **({"appConfigs": [
                 {"label": e["label"], "client": e["client"], "box": e["box"],
                  "mode": e["mode"], "excludes": e.get("excludes", [])}
                 for e in (p.get("app_configs") or {}).get("paths", [])
             ]} if (p.get("app_configs") or {}).get("enabled") else {})}
            for p in profiles
        ],
    }
    d = os.path.expanduser("~/.config/remote-devbox")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "config.json")
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print(f"  ✓ ~/.config/remote-devbox/config.json written ({len(profiles)} profile(s))")


def install_cli(repo, prefix):
    """Install the Bun TS CLI: `bun install` its deps and drop a wrapper on PATH that
    runs the source via bun. Returns the wrapper path, or None if bun is missing."""
    if not shutil.which("bun"):
        print("  ! bun not found — install bun (https://bun.sh) then re-run with --cli, "
              "or use the shell function instead (drop --cli).")
        return None
    cli_dir = os.path.join(repo, "clients", "devbox")
    src = os.path.join(cli_dir, "src", "devbox.ts")
    if not os.path.exists(src):
        die(f"CLI source not found at {src}")
    print("  · bun install (CLI deps)…")
    subprocess.run(["bun", "install"], cwd=cli_dir, check=True, stdout=subprocess.DEVNULL)
    bindir = os.path.expanduser("~/.local/bin")
    os.makedirs(bindir, exist_ok=True)
    wrapper = os.path.join(bindir, prefix)
    with open(wrapper, "w") as f:
        f.write(f'#!/bin/sh\n# Managed by remote-devbox (gen-editor-config.py --cli).\n'
                f'exec bun {shlex.quote(src)} "$@"\n')
    os.chmod(wrapper, 0o755)
    print(f"  ✓ installed `{prefix}` -> ~/.local/bin/{prefix} (runs the Bun CLI)")
    if bindir not in os.environ.get("PATH", "").split(os.pathsep):
        print(f"  ! ~/.local/bin is not on your PATH — add: export PATH=\"$HOME/.local/bin:$PATH\"")
    # Install the bundled slash commands (devbox-*.md) into ~/.claude/commands/,
    # renaming the `devbox` prefix to the configured one and substituting __PREFIX__.
    cmds_src_dir = os.path.join(cli_dir, "commands")
    if os.path.isdir(cmds_src_dir):
        cmds_dir = os.path.expanduser("~/.claude/commands")
        os.makedirs(cmds_dir, exist_ok=True)
        for fn in sorted(os.listdir(cmds_src_dir)):
            if not fn.endswith(".md"):
                continue
            with open(os.path.join(cmds_src_dir, fn)) as f:
                body = f.read().replace("__PREFIX__", prefix)
            dest_name = fn.replace("devbox", prefix, 1)  # devbox-push.md -> <prefix>-push.md
            with open(os.path.join(cmds_dir, dest_name), "w") as f:
                f.write(body)
            print(f"  ✓ installed `/{dest_name[:-3]}` -> ~/.claude/commands/{dest_name}")
    return wrapper


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo")
    ap.add_argument("--prefix", default="devbox")
    ap.add_argument("--host", help="host the ssh aliases connect to (else group_vars connect_host, else inventory.ini ansible_host)")
    ap.add_argument("--key", help="override IdentityFile (else operator_private_key_path)")
    ap.add_argument("--zed", action="store_true", help="write Zed config even if Zed isn't detected")
    ap.add_argument("--no-zed", action="store_true")
    ap.add_argument("--default", help="default profile for the bare `<prefix>` command (else the first)")
    ap.add_argument("--shell-rc", help="shell rc file to write the connect function into (else autodetect)")
    ap.add_argument("--no-shell", action="store_true", help="don't add the shell connect function")
    ap.add_argument("--locale", default="en_US.UTF-8", help="locale the connect command pins (LANG/LC_ALL/LC_CTYPE) so mosh-server starts (default en_US.UTF-8)")
    ap.add_argument("--launch", default="", help="command to auto-run on a fresh session, e.g. 'claude' (default: none — lands in a shell)")
    ap.add_argument("--cli", action="store_true", help="install the Bun TS CLI (fuzzy picker, no fzf) instead of the shell function")
    args = ap.parse_args()

    repo = find_repo(args.repo)
    v = load_vars(repo)
    profiles = v.get("profiles") or []
    if not profiles:
        die("no profiles in group_vars/all.yml")
    host = connect_host(repo, args.host, v)
    key = args.key or v.get("operator_private_key_path") or "~/.ssh/id_ed25519"
    users = [p["user"] for p in profiles]
    default = args.default or users[0]
    if default not in users:
        die(f"--default '{default}' is not a profile (have: {', '.join(users)})")

    print(f"Box {host} · {len(profiles)} profile(s) · alias prefix '{args.prefix}-'")
    write_ssh_config(ssh_block(profiles, host, key, args.prefix))
    if not args.no_zed:
        write_zed(zed_entries(profiles, args.prefix), args.prefix, args.zed)

    if args.cli:
        # Bun CLI mode: write its config, install it on PATH, and remove the shell
        # function (a same-named shell function would shadow the CLI binary on PATH).
        write_cli_config(profiles, args.prefix, host, default, args.locale, args.launch, repo)
        installed = install_cli(repo, args.prefix)
        if installed:
            strip_managed_block(shell_rc_path(args.shell_rc))
    elif not args.no_shell:
        write_shell_rc(shell_block(profiles, args.prefix, default, args.locale, args.launch), shell_rc_path(args.shell_rc))

    aliases = ", ".join(f"{args.prefix}-{p['user']}" for p in profiles)
    print(f"\nDone.")
    if args.cli:
        print(f"  • Terminal CLI (fuzzy picker, mosh+tmux):  {args.prefix} [project] · {args.prefix} use · {args.prefix} ls")
        print(f"      bare `{args.prefix}` git-auto-opens a matching repo, else shows the picker")
    else:
        print(f"  • Terminal (mosh+tmux, drop-proof):  {args.prefix} [project] · {args.prefix} use · {args.prefix} ls")
    print(f"  • VS Code / Cursor: Remote-SSH → Connect to Host → {aliases}")
    print(f"  • Zed: command palette → 'projects: open remote'")


if __name__ == "__main__":
    main()
