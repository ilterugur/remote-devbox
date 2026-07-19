#!/usr/bin/env python3
"""remote-devbox custom Stop hook: retain Hindsight memories WITH verti-style tags.

Wraps the Hindsight plugin's own run_retain() — reusing all its transcript parsing,
chunking, compaction handling, daemon resolution and POST — and only injects extra
tags: source:claude-code, project:<repo-from-cwd>. (No profile tag: the bank is already
per-profile — bankId = the profile's username — so a profile tag would just duplicate it.)

The plugin's built-in auto-retain is disabled (autoRetain:false in
~/.hindsight/claude-code.json) so retention happens exactly once, here, with tags.

Graceful: if the plugin lib can't be located/imported, exec the plugin's retain.py
unmodified so memory still works (without the project tag). Exit 0 always.
"""
import glob
import json
import os
import subprocess
import sys


def find_plugin_scripts():
    """Find the installed Hindsight plugin's scripts/ dir (newest by mtime)."""
    hits = [
        p for p in glob.glob(
            os.path.expanduser("~/.claude/plugins/**/scripts/retain.py"),
            recursive=True,
        )
        if "hindsight" in p.lower()
    ]
    if not hits:
        return None
    hits.sort(key=os.path.getmtime, reverse=True)
    return os.path.dirname(hits[0])


def build_extra_tags(project, base):
    """Append source/project tags to `base`, skipping blanks and dups."""
    tags = list(base or [])
    extra = ["source:claude-code"]
    if project:
        extra.append("project:{}".format(project))
    for t in extra:
        if t not in tags:
            tags.append(t)
    return tags


def main():
    raw = sys.stdin.read()
    try:
        hook_input = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        hook_input = {}

    scripts_dir = find_plugin_scripts()
    if not scripts_dir:
        print("[hindsight-devbox] plugin scripts not found; skipping", file=sys.stderr)
        return

    sys.path.insert(0, scripts_dir)
    try:
        import retain as hs_retain
        from lib.config import load_config as orig_load_config
        from lib.bank import _resolve_project_name
    except Exception as e:  # fallback: run plugin retain unmodified
        print("[hindsight-devbox] import failed ({}); fallback".format(e), file=sys.stderr)
        subprocess.run([sys.executable, os.path.join(scripts_dir, "retain.py")],
                       input=raw, text=True)
        return

    cwd = hook_input.get("cwd", "")

    def patched_load_config():
        cfg = orig_load_config()
        cfg["autoRetain"] = True  # this hook owns retention
        try:
            project = _resolve_project_name(cwd, cfg)
        except Exception:
            project = os.path.basename(cwd) if cwd else ""
        cfg["retainTags"] = build_extra_tags(project, cfg.get("retainTags"))
        return cfg

    hs_retain.load_config = patched_load_config
    hs_retain.run_retain(hook_input, force=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("[hindsight-devbox] unexpected error: {}".format(e), file=sys.stderr)
    sys.exit(0)
