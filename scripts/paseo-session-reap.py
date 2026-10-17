#!/usr/bin/env python3
"""Managed by remote-devbox. Releases the provider process of a finished Paseo session.

A Paseo agent that has answered and gone quiet keeps its provider process — omp, codex,
claude — resident with the entire heap the conversation built. Nothing in the product
releases it: `paseo stop` is documented as "no-op for idle agents", and `archive` and
`delete` remove the agent rather than free it. So the fleet only ever grows.

Measured 2026-09-08 on the shared box: 57 live sessions holding 14 GB inside a cgroup
whose ceiling is 34 GB. The cgroup sat exactly at that ceiling, `memory.pressure`
reported `full avg10` between 44% and 77%, and every session in it — including the ones
a developer was actively waiting on — ran in reclaim. 41 of those 57 had been silent for
between 12 and 114 hours. Releasing them returned 10 GB and pressure fell to 0.06%.

The kill decision comes from the daemon's own record, never from process age or size.
`ps` cannot tell a five-day-old session that is thinking from one that finished on Monday;
`lastStatus` and `lastActivityAt` in ~/.paseo/agents/**/<id>.json can, because the daemon
writes them. A record that says `running`, a record that cannot be parsed, and a process
with no record at all are all left alone: this releases what is known to be finished, and
is silent about everything else.
"""
import argparse
import calendar
import errno
import glob
import json
import os
import sys
import time

# The join key between a live process and an agent record. Paseo exports it into every
# provider it launches. Matching on the working directory instead was tried first and is
# wrong: a dozen sessions share one repo checkout, and the largest ones — the sessions
# worth releasing — were exactly the ones it could not tell apart.
AGENT_ENV_KEY = "PASEO_AGENT_ID"

# Only these two are finished. `running` is an agent mid-turn; anything unrecognised is
# treated as running, so a status this script has never heard of can never cause a kill.
FINISHED_STATUSES = ("idle", "closed")


class Session:
    """One provider process, with the record that decides its fate."""

    __slots__ = ("pid", "agent_id", "status", "idle_hours", "title", "rss_kb", "start_ts")

    def __init__(self, pid, agent_id, status, idle_hours, title, rss_kb, start_ts):
        self.pid = pid
        self.agent_id = agent_id
        self.status = status
        self.idle_hours = idle_hours
        self.title = title
        self.rss_kb = rss_kb
        self.start_ts = start_ts

    @property
    def finished(self):
        return self.status in FINISHED_STATUSES and self.idle_hours is not None

    def __repr__(self):
        return "Session(pid=%d, status=%s, idle=%.1fh, rss_kb=%d)" % (
            self.pid, self.status, self.idle_hours or -1, self.rss_kb)


def hours_since(stamp, now=None):
    """Age of an ISO-8601 UTC timestamp in hours, or None if it cannot be read.

    The records are UTC and the box is not; parsing these against a local clock shifts
    every age by the offset — two hours here — which is silent, and in the wrong
    direction for a cutoff.
    """
    if not stamp:
        return None
    try:
        parsed = time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S")
    except (ValueError, TypeError):
        return None
    return ((now if now is not None else time.time()) - calendar.timegm(parsed)) / 3600.0


def read_records(home_glob):
    """Map agent id -> record across every developer's Paseo store."""
    records = {}
    for home in glob.glob(home_glob):
        agents_dir = os.path.join(home, ".paseo", "agents")
        if not os.path.isdir(agents_dir):
            continue
        for dirpath, _dirnames, filenames in os.walk(agents_dir):
            for name in filenames:
                if not name.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(dirpath, name)) as fh:
                        doc = json.load(fh)
                except (OSError, ValueError):
                    continue
                if isinstance(doc, dict) and doc.get("id"):
                    records[doc["id"]] = doc
    return records


def process_env(pid, key, procfs="/proc"):
    """One variable out of a process environment, or None.

    /proc/<pid>/environ is ptrace-gated: reading another user's requires
    CAP_SYS_PTRACE, which the unit grants for exactly this. Without it every read
    fails with EACCES and the sweep finds nothing while looking perfectly healthy.
    """
    try:
        with open(os.path.join(procfs, str(pid), "environ"), "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    prefix = (key + "=").encode()
    for entry in raw.split(b"\0"):
        if entry.startswith(prefix):
            return entry[len(prefix):].decode("utf-8", "replace")
    return None


def proc_facts(pid, procfs="/proc"):
    """(ppid, start_ts, rss_kb) from /proc/<pid>/stat and statm, or None.

    Both are kernel-resident: unlike cmdline and environ they cannot fault a swapped-out
    page back in, which matters when this runs against a box already under memory
    pressure.
    """
    try:
        with open(os.path.join(procfs, str(pid), "stat")) as fh:
            stat = fh.read()
        with open(os.path.join(procfs, str(pid), "statm")) as fh:
            rss_pages = int(fh.read().split()[1])
    except (OSError, IndexError, ValueError):
        return None
    # comm is field 2 and may itself contain spaces and ')'. Everything positional has to
    # be counted from the last ')', which is the convention the rest of this repo uses.
    try:
        fields = stat[stat.rfind(")") + 1:].split()
        ppid = int(fields[1])
        start_ts = int(fields[19])
    except (IndexError, ValueError):
        return None
    return ppid, start_ts, rss_pages * (os.sysconf("SC_PAGE_SIZE") // 1024)


def read_sessions(records, procfs="/proc"):
    """Every provider process that belongs to a known agent, one entry per session.

    A provider spawns children — shells, bundlers, browsers — and they inherit the agent
    id, so the naive scan returns the whole tree. Only the root is a session: killing it
    takes its tree with it, while signalling a child would leave the heap behind and
    break the session it was supposed to release.
    """
    owned = {}
    for entry in os.listdir(procfs):
        if not entry.isdigit():
            continue
        pid = int(entry)
        agent_id = process_env(pid, AGENT_ENV_KEY, procfs)
        if not agent_id:
            continue
        facts = proc_facts(pid, procfs)
        if facts is None:
            continue
        owned[pid] = (agent_id, facts)

    sessions = []
    for pid, (agent_id, (ppid, start_ts, rss_kb)) in owned.items():
        parent = owned.get(ppid)
        if parent is not None and parent[0] == agent_id:
            continue  # A child of the same session, not the session itself.
        record = records.get(agent_id)
        if record is None:
            # Unidentified is not the same as finished.
            continue
        sessions.append(Session(
            pid=pid,
            agent_id=agent_id,
            status=record.get("lastStatus") or "unknown",
            idle_hours=hours_since(record.get("lastActivityAt") or record.get("updatedAt")),
            title=(record.get("title") or "")[:60],
            rss_kb=rss_kb,
            start_ts=start_ts,
        ))
    sessions.sort(key=lambda s: s.rss_kb, reverse=True)
    return sessions


def select(sessions, idle_hours):
    return [s for s in sessions if s.finished and s.idle_hours > idle_hours]


def release(victims, dry_run, killer=os.kill, sleeper=time.sleep, term_wait_sec=10):
    """SIGTERM, wait, then SIGKILL whatever is still there. Returns what was released.

    The polite signal first, even though it is usually wasted: measured 2026-09-08, an
    omp session sat through SIGTERM for twenty seconds without exiting. SIGKILL is
    therefore expected rather than exceptional here — which is only defensible because
    every process reaching this point has been silent for hours and has long since
    flushed its transcript to disk. The record and the transcript are never touched, so
    the session can be resumed; verified on one session before this ran as a batch.
    """
    if dry_run:
        return list(victims)

    signalled = []
    for victim in victims:
        try:
            killer(victim.pid, 15)
            signalled.append(victim)
        except ProcessLookupError:
            continue  # Exited between the scan and the signal; nothing to claim.
        except PermissionError:
            continue

    if not signalled:
        return []

    sleeper(term_wait_sec)

    released = []
    for victim in signalled:
        try:
            killer(victim.pid, 0)
        except ProcessLookupError:
            released.append(victim)
            continue
        except PermissionError:
            continue
        try:
            killer(victim.pid, 9)
            released.append(victim)
        except (ProcessLookupError, PermissionError):
            released.append(victim)
    return released


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Release the provider process of a finished Paseo session.")
    ap.add_argument("--idle-hours", type=float,
                    default=float(os.environ.get("PASEO_SESSION_REAP_IDLE_HOURS", 12)),
                    help="how long an idle or closed agent must have been silent")
    ap.add_argument("--home-glob", default=os.environ.get("PASEO_SESSION_REAP_HOMES", "/home/*"),
                    help="where developer Paseo stores live")
    ap.add_argument("--dry-run", action="store_true", help="report what would be released")
    ap.add_argument("--procfs", default="/proc")
    args = ap.parse_args(argv)

    records = read_records(args.home_glob)
    sessions = read_sessions(records, args.procfs)
    victims = select(sessions, args.idle_hours)
    released = release(victims, args.dry_run)

    verb = "would release" if args.dry_run else "released"
    for victim in released:
        print("[paseo-session-reap] %s pid=%d rss=%dM idle=%.1fh %s"
              % (verb, victim.pid, victim.rss_kb // 1024, victim.idle_hours, victim.title))
    print("[paseo-session-reap] %d session(s) live, %s %d, %dM reclaimed (cutoff %.0fh)"
          % (len(sessions), verb, len(released),
             sum(v.rss_kb for v in released) // 1024, args.idle_hours))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as exc:
        if exc.errno == errno.EACCES:
            print("[paseo-session-reap] WARNING: cannot read process environments (%s) — "
                  "CAP_SYS_PTRACE is required to identify sessions" % exc, file=sys.stderr)
            sys.exit(1)
        raise
