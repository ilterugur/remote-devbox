#!/usr/bin/env python3
"""Managed by remote-devbox. Kills the runaway that has parked an agent cgroup at MemoryHigh.

MemoryHigh does not kill; it throttles. That is the right default for a fleet of agent
sessions — until one member grows without a wall of its own. Then the cgroup sits AT the
high watermark and every process in it, including every live session, spends most of its
time in reclaim. The unit stays `active (running)` and answers nothing.

Measured on the shared box, 2026-09-04/05, `paseo-daemon.service` with
MemoryHigh=34G / MemoryMax=36G:

    memory.events: high 100090357   max 4082   oom_kill 3   sock_throttled 781157
    memory.pressure: full avg10=87%   host: full avg10=92%

`oom_kill 3` against 100M throttle events is the whole story: throttling slows the
runaway enough that the 2G band to MemoryMax is crossed too rarely for the kernel's own
wall to do the job, so the cgroup never heals. The runaways were a 13.8 GB `vite build`
that escaped the heavy-job gate, and later a 24.4 GB `bun run src/index.ts` dev server
that the gate does not classify as heavy at all. Both were killed by hand; each time the
box recovered within seconds. This is that hand, on a timer.

Two constraints, both learned the hard way while the box was thrashing:

  * NEVER read /proc/<pid>/cmdline. It faults the target's pages back in from swap, so
    under exactly the condition this guard exists for, a scan that touches cmdline for
    every process blocks for minutes. A full /proc walk took >10 minutes; `ps` alone
    took >3. Only `comm` (kernel-resident) and `statm` (accounted, no fault) are read,
    and only for the pids the cgroup itself lists.
  * The janitor must outlive the condition. It runs with reclaim protection and a
    negative OOM score so the kernel does not pick it as the victim of the stall it is
    there to end.

Safety, in the order it is enforced:
  1. Only cgroups that declare a MemoryHigh — an unbounded cgroup has no wall to be
     pinned against, so there is nothing here to diagnose.
  2. Only while the cgroup is at that wall AND its own memory.pressure says the members
     are actually stalling. Sitting at high with no stall is a healthy steady state.
  3. Only a member above the RSS floor. A session is a few hundred MB; the floor is set
     so far above that only a genuine runaway is ever a candidate.
  4. Never a supervisor, an agent session, or this guard: killing the thing that owns
     the work is worse than the stall.
  5. Only after the same process has been the top candidate across passes spanning the
     grace period, so a legitimate spike that resolves itself is never killed.
  6. SIGTERM, then SIGKILL only if it is still there.

Usage: cgroup-runaway-guard [--dry-run] [--interval-sec N] [--grace-sec N]
                            [--rss-floor-mb N] [--high-ratio F] [--pressure-full-min N]
                            [--cgroup-glob GLOB]... [--state PATH]
"""
import argparse
import errno
import glob
import json
import os
import signal
import sys
import time

# Where a runaway parks a wall. The Paseo daemon holds the session fleet and each Remote
# Control unit holds one always-on session — a runaway that escaped the heavy-job gate
# inherits the cgroup of whatever spawned it and lands in one of those. The per-developer
# slice is watched too, and it is the one measured 2026-09-05: a GATED build gets a scope
# of its own (`run-*.scope`, MemoryMax 18G) so it never pins the daemon's cgroup, but that
# scope is a sibling inside the developer's slice — and there it landed beside a 13.9 GB
# valkey and a ~20 GB session fleet, taking user-1004.slice to 48.6G of its 49G
# MemoryHigh three times in one afternoon. Nothing below the slice was pinned, so the
# guard saw nothing while every session stalled.
DEFAULT_CGROUP_GLOBS = (
    "/sys/fs/cgroup/**/paseo-daemon.service",
    "/sys/fs/cgroup/**/agent-rc-*.service",
    "/sys/fs/cgroup/user.slice/user-*.slice",
)

# Matched against `comm`, which is all this guard is allowed to read (see the module
# docstring). `comm` is 15 bytes and set by the process itself, so these are prefixes:
# the Paseo daemon reports "Paseo Daemon"/"Paseo Superviso", a bun-hosted omp session
# reports "omp".
#
# The data stores are here for a reason that only appears at slice level: inside
# user-1004.slice the largest member is valkey at 13.9 GB, ahead of the 12.8 GB build that
# is actually the transient one. Picking "largest" without this list would answer a stall
# by killing the datastore — writes lost, and the stall back within the hour when the next
# build starts. A store that is big every day is capacity, not a runaway.
PROTECTED_COMM_PREFIXES = (
    "Paseo Daemon", "Paseo Superviso", "systemd", "omp", "codex", "claude", "tmux",
    "sshd", "dbus", "cgroup-runaway", "agent-rc-", "mosh", "et", "hermes",
    "valkey-server", "redis-server", "postgres", "nats-server", "clickhouse",
    "victoria", "openconnector-r", "dockerd", "containerd", "docker-proxy",
    "rootlesskit", "slirp4netns", "mutagen", "syncthing", "tailscaled",
)

CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_KB = os.sysconf("SC_PAGE_SIZE") // 1024


class Member:
    """One process inside a watched cgroup, described only by what is cheap to read."""

    __slots__ = ("pid", "comm", "rss_kb", "start_ticks", "cgroup")

    def __init__(self, pid, comm, rss_kb, start_ticks, cgroup):
        self.pid = pid
        self.comm = comm
        self.rss_kb = rss_kb
        self.start_ticks = start_ticks
        self.cgroup = cgroup

    # pid alone is not an identity: pids are recycled, and a new process must not
    # inherit the elapsed grace of the one that held its number before it.
    @property
    def key(self):
        return "%d:%d" % (self.pid, self.start_ticks)

    def __repr__(self):
        return "Member(pid=%d, comm=%r, rss_mb=%d)" % (self.pid, self.comm, self.rss_kb // 1024)


def is_protected(comm):
    """True for supervisors, agent sessions and this guard — never victims."""
    return any(comm.startswith(p) for p in PROTECTED_COMM_PREFIXES)


def read_int(path):
    """A cgroup integer file, or None when absent/unreadable/unlimited."""
    try:
        with open(path) as fh:
            raw = fh.read().strip()
    except (FileNotFoundError, PermissionError, OSError):
        return None
    if raw in ("max", ""):
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def parse_pressure(text):
    """The `full` averages from a memory.pressure file, as floats keyed by window."""
    out = {}
    for line in text.splitlines():
        if not line.startswith("full"):
            continue
        for field in line.split()[1:]:
            name, _, value = field.partition("=")
            try:
                out[name] = float(value)
            except ValueError:
                continue
    return out


def read_pressure_full(cgroup, window="avg10"):
    try:
        with open(os.path.join(cgroup, "memory.pressure")) as fh:
            return parse_pressure(fh.read()).get(window, 0.0)
    except (FileNotFoundError, PermissionError, OSError):
        return 0.0


def is_pinned(current, high, ratio):
    """True when the cgroup is effectively sitting at its high watermark.

    A ratio rather than equality: the kernel lets usage hover just under high while it
    reclaims, so `current == high` almost never holds on a sample boundary.
    """
    if not high or not current:
        return False
    return current >= high * ratio


def member_pids(cgroup):
    """Every pid accounted to this cgroup, including its descendants.

    Reading only the cgroup's own `cgroup.procs` was wrong the moment slices came into
    scope, and wrong invisibly: in cgroup v2 an inner node holds no processes, so a slice
    reads EMPTY while every process it accounts for sits in a leaf below it. Measured
    2026-09-05, the guard reported `user-1004.slice: stalled-no-candidate` on a slice
    pinned at 49G with a 9.5 GB build inside it — the diagnosis was right and the
    membership was blank, so it stood there naming the problem it could have ended.

    Still no /proc walk: this reads one file per cgroup in a subtree of tens, not one per
    process out of six thousand, and it never touches a process's own memory.
    """
    pids = []
    for dirpath, _dirnames, filenames in os.walk(cgroup):
        if "cgroup.procs" not in filenames:
            continue
        try:
            with open(os.path.join(dirpath, "cgroup.procs")) as fh:
                pids.extend(int(line) for line in fh if line.strip())
        except (FileNotFoundError, PermissionError, ValueError, OSError):
            continue
    return pids


def read_members(cgroup, procfs="/proc"):
    """Every process the cgroup accounts for, with only its comm, RSS and start time."""
    members = []
    for pid in member_pids(cgroup):
        base = os.path.join(procfs, str(pid))
        try:
            with open(os.path.join(base, "comm")) as fh:
                comm = fh.read().strip()
            with open(os.path.join(base, "statm")) as fh:
                rss_pages = int(fh.read().split()[1])
            with open(os.path.join(base, "stat")) as fh:
                stat = fh.read()
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
            continue
        except OSError as exc:
            if exc.errno in (errno.ESRCH, errno.EACCES, errno.EINVAL):
                continue
            raise
        # comm is field 2, parenthesised, and may itself contain spaces and ')'.
        # Everything positional has to be counted from the LAST ')'.
        fields = stat[stat.rfind(")") + 1:].split()
        try:
            start_ticks = int(fields[19])
        except (IndexError, ValueError):
            continue
        members.append(Member(pid, comm, rss_pages * PAGE_KB, start_ticks, cgroup))
    return members


def select_candidate(members, rss_floor_kb):
    """The one process worth killing: biggest, unprotected, above the floor."""
    eligible = [m for m in members if m.rss_kb >= rss_floor_kb and not is_protected(m.comm)]
    if not eligible:
        return None
    return max(eligible, key=lambda m: m.rss_kb)


def find_cgroups(globs=DEFAULT_CGROUP_GLOBS):
    found = []
    for pattern in globs:
        for path in glob.glob(pattern, recursive=True):
            if os.path.isdir(path):
                found.append(path)
    return sorted(set(found))


def assess(cgroup, ratio, pressure_min, rss_floor_kb, procfs="/proc"):
    """Decide whether this cgroup is stalled, and on whom. Returns (verdict, candidate).

    The verdict is returned rather than logged here so the caller can report a cgroup it
    is watching but not acting on — a guard that only speaks when it kills is a guard
    nobody can tell is working.
    """
    high = read_int(os.path.join(cgroup, "memory.high"))
    current = read_int(os.path.join(cgroup, "memory.current"))
    if high is None:
        return "unbounded", None
    if not is_pinned(current, high, ratio):
        return "below-wall", None
    if read_pressure_full(cgroup) < pressure_min:
        # At the wall but nobody is waiting on memory: the kernel is keeping up, and a
        # cgroup that lives at its watermark is not by itself a fault.
        return "pinned-no-stall", None
    candidate = select_candidate(read_members(cgroup, procfs), rss_floor_kb)
    if candidate is None:
        # Stalling, but the weight is spread across sessions rather than concentrated in
        # one runaway. Killing the largest session would cost work and fix nothing; this
        # is a capacity problem for a human to see.
        return "stalled-no-candidate", None
    return "stalled", candidate


def reconcile(state, candidates, now, grace_sec):
    """Fold this pass's candidates into the carried state; return (state, due).

    State maps a process identity to when it was FIRST seen as the runaway. Identities
    absent from this pass are dropped, so a spike that resolves — or a cgroup that comes
    off its wall — starts from zero rather than banking credit toward a kill.
    """
    fresh = {}
    due = []
    for member in candidates:
        first_seen = state.get(member.key, now)
        fresh[member.key] = first_seen
        if now - first_seen >= grace_sec:
            due.append(member)
    return fresh, due


def reap(victims, dry_run, killer=os.kill, grace_term_sec=5):
    """SIGTERM, wait, then SIGKILL whatever is still there. Returns what was hit.

    The grace is short on purpose: measured 2026-09-05, a 24.4 GB dev server ignored
    SIGTERM entirely — a process this deep in reclaim may never run its handler, and the
    cgroup stays stalled for as long as we wait on it.
    """
    if dry_run:
        return list(victims)
    hit = []
    for member in victims:
        try:
            killer(member.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
        hit.append(member)
    if not hit:
        return hit
    if grace_term_sec:
        time.sleep(grace_term_sec)
    for member in hit:
        try:
            killer(member.pid, 0)  # still alive?
        except (ProcessLookupError, PermissionError):
            continue
        try:
            killer(member.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return hit


def load_state(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Kill the runaway pinning an agent cgroup at MemoryHigh.")
    ap.add_argument("--dry-run", action="store_true", help="report the verdict and exit")
    ap.add_argument("--grace-sec", type=int, default=int(os.environ.get("RUNAWAY_GUARD_GRACE_SEC", 120)),
                    help="how long one process must be the runaway before it is killed")
    ap.add_argument("--rss-floor-mb", type=int, default=int(os.environ.get("RUNAWAY_GUARD_RSS_FLOOR_MB", 6144)))
    ap.add_argument("--high-ratio", type=float, default=float(os.environ.get("RUNAWAY_GUARD_HIGH_RATIO", 0.98)))
    ap.add_argument("--pressure-full-min", type=float,
                    default=float(os.environ.get("RUNAWAY_GUARD_PRESSURE_FULL_MIN", 25)))
    ap.add_argument("--cgroup-glob", action="append", default=None, metavar="GLOB",
                    help="cgroup pattern to watch; repeatable, replaces the built-in set")
    ap.add_argument("--state", default=os.environ.get("RUNAWAY_GUARD_STATE",
                                                      "/run/cgroup-runaway-guard/seen.json"))
    ap.add_argument("--procfs", default="/proc")
    args = ap.parse_args(argv)

    globs = tuple(args.cgroup_glob) if args.cgroup_glob else DEFAULT_CGROUP_GLOBS
    rss_floor_kb = args.rss_floor_mb * 1024
    now = time.time()
    state = load_state(args.state)

    candidates = []
    for cgroup in find_cgroups(globs):
        verdict, candidate = assess(cgroup, args.high_ratio, args.pressure_full_min,
                                    rss_floor_kb, args.procfs)
        name = os.path.basename(cgroup)
        if verdict in ("unbounded", "below-wall"):
            continue
        if candidate is None:
            print("[cgroup-runaway-guard] %s: %s (current=%dM high=%dM full=%.1f%%)"
                  % (name, verdict,
                     (read_int(os.path.join(cgroup, "memory.current")) or 0) // 1048576,
                     (read_int(os.path.join(cgroup, "memory.high")) or 0) // 1048576,
                     read_pressure_full(cgroup)))
            continue
        print("[cgroup-runaway-guard] %s: stalled, runaway pid=%d comm=%s rss=%dM"
              % (name, candidate.pid, candidate.comm, candidate.rss_kb // 1024))
        candidates.append(candidate)

    state, due = reconcile(state, candidates, now, args.grace_sec)

    if args.dry_run:
        for member in due:
            print("[cgroup-runaway-guard] would kill pid=%d comm=%s rss=%dM"
                  % (member.pid, member.comm, member.rss_kb // 1024))
        print("[cgroup-runaway-guard] dry run: %d runaway(s), %d past grace"
              % (len(candidates), len(due)))
        return 0

    hit = reap(due, dry_run=False)
    for member in hit:
        print("[cgroup-runaway-guard] killed pid=%d comm=%s rss=%dM in %s"
              % (member.pid, member.comm, member.rss_kb // 1024, os.path.basename(member.cgroup)))
    # Whatever we just killed must not linger in state; the next pass would otherwise
    # carry a dead identity until it aged out on its own.
    for member in hit:
        state.pop(member.key, None)
    try:
        save_state(args.state, state)
    except OSError as exc:
        print("[cgroup-runaway-guard] WARNING: cannot persist state at %s (%s) — grace restarts each pass"
              % (args.state, exc), file=sys.stderr)
    if hit:
        print("[cgroup-runaway-guard] reclaimed %dM from %d runaway(s)"
              % (sum(m.rss_kb for m in hit) // 1024, len(hit)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
