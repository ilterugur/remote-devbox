#!/usr/bin/env python3
"""Managed by remote-devbox. Bridge-identity snapshotter for one RC instance.

A Remote Control session's card on claude.ai is identified by a bridge session id.
For sessions the RC server spawns, that id is written nowhere durable: the
transcript never records it, and the only copy lives in the pid-keyed state file
~/.claude/sessions/<pid>.json, which disappears with the process. After an OOM the
resume launcher therefore has no pointer to hand back, the CLI mints a fresh
bridge session, and the conversation acquires a second card while its own is left
behind dead.

This keeps a durable map of  local session uuid -> bridge session id  for the
sessions of ONE Remote Control unit, refreshed from agent-rc-monitor's poll loop
while those processes are still alive.

Reads session state files; writes only its own map, atomically. Nothing under
~/.claude is ever modified.

Usage: agent-rc-bridge-snapshot <instance-id>
Env:   HOME, RC_BRIDGE_MAP_TTL_DAYS (default 14)
"""
import json
import os
import re
import sys
import time

BRIDGE_RE = re.compile(r"^session_[A-Za-z0-9_-]{6,128}$")
UUID_RE = re.compile(r"^[0-9a-fA-F-]{16,64}$")
# <agent>-<user>-<project>, all three already charset-bound by `devbox plan`.
INSTANCE_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def live_entries(states, instance_id):
    """Session state records that belong to this RC unit and carry a bridge id.

    A record's `tmux` field is "<tmux-session>:@<window>.%<pane>" and the unit's
    tmux session is named after the instance, so the "<name>:" prefix is an exact
    ownership test -- unlike cwd, which a second unit can share.
    """
    prefix = "agent-rc-%s:" % instance_id
    out = {}
    for st in states:
        if not isinstance(st, dict):
            continue
        if not str(st.get("tmux") or "").startswith(prefix):
            continue
        uuid = str(st.get("sessionId") or "")
        bridge = str(st.get("bridgeSessionId") or "")
        if not UUID_RE.match(uuid) or not BRIDGE_RE.match(bridge):
            continue
        out[uuid] = {"bridge": bridge, "cwd": str(st.get("cwd") or "")}
    return out


def merge(existing, live, now, ttl_days):
    """Fold the live sessions into the stored map and retire stale entries.

    A session that is not running right now keeps its entry -- that is precisely
    the case the resume path exists for. Only age retires an entry.
    """
    # A map that parses as JSON but is not an object (a torn write, a future
    # schema change) must degrade to "nothing stored" rather than raise here --
    # this is the writer side of the same hazard the reader already guards
    # against (agent-rc-resume.sh), except a crash here is permanent: the monitor
    # calls this every tick and swallows failures with `|| true`, so an unguarded
    # AttributeError would brick the snapshotter for this unit forever.
    if not isinstance(existing, dict):
        existing = {}
    ttl = ttl_days * 86400
    out = {}
    for uuid, rec in existing.items():
        if not isinstance(rec, dict):
            continue
        bridge = str(rec.get("bridge") or "")
        if not BRIDGE_RE.match(bridge):
            continue
        try:
            seen = float(rec.get("seen") or 0)
        except (TypeError, ValueError):
            continue
        if now - seen > ttl:
            continue
        out[uuid] = {"bridge": bridge, "cwd": str(rec.get("cwd") or ""), "seen": seen}
    for uuid, rec in live.items():
        out[uuid] = {"bridge": rec["bridge"], "cwd": rec["cwd"], "seen": now}
    return out


def read_states(sessions_dir):
    states = []
    try:
        names = os.listdir(sessions_dir)
    except OSError:
        return states
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(sessions_dir, name)) as fh:
                states.append(json.load(fh))
        except Exception:
            continue
    return states


def write_atomic(path, data):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except Exception:
        # The rename never happened, so the previous map is still the good one --
        # take the half-written file with us rather than leaving it in the rundir.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def main():
    if len(sys.argv) < 2:
        print("usage: agent-rc-bridge-snapshot <instance-id>", file=sys.stderr)
        return 2
    instance_id = sys.argv[1]
    # The id reaches us from a root-generated systemd unit, so nothing on the box can
    # bend it today -- but it lands in a filename, and a caller that gets this wrong
    # should fail loudly here instead of writing outside the run directory.
    if not INSTANCE_RE.match(instance_id):
        print("agent-rc-bridge-snapshot: refusing instance id %r" % instance_id, file=sys.stderr)
        return 2
    home = os.environ.get("HOME", os.path.expanduser("~"))
    try:
        ttl_days = float(os.environ.get("RC_BRIDGE_MAP_TTL_DAYS", "14"))
    except ValueError:
        ttl_days = 14.0
    rundir = os.path.join(home, ".cache", "agent-devbox", "resume")
    path = os.path.join(rundir, "bridge-map-%s.json" % instance_id)

    live = live_entries(read_states(os.path.join(home, ".claude", "sessions")), instance_id)
    try:
        with open(path) as fh:
            existing = json.load(fh)
    except Exception:
        existing = {}
    merged = merge(existing, live, time.time(), ttl_days)
    if merged == existing:
        return 0
    os.makedirs(rundir, exist_ok=True)
    write_atomic(path, merged)
    return 0


if __name__ == "__main__":
    sys.exit(main())
