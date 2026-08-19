#!/usr/bin/env python3
"""Managed by remote-devbox. Reaps build processes left behind by deleted worktrees.

A Remote Control server runs with `--spawn worktree`: every session gets its own
git worktree, and when the session is done the worktree is removed. The processes
that session started inside it — dev servers, bundler service processes, test
runners — are not children of anything that removal reaps, so they keep running
with their working directory pointing at a directory that no longer exists. Each
one holds its heap for as long as the box is up.

They accumulate in the unit's cgroup. Once the total crosses MemoryHigh the kernel
stops killing anything and starts *throttling* instead: every process in that
cgroup, including the live agent sessions, stalls in reclaim. The unit stays
"active (running)" and answers nothing. That is what this reaps, and it is the
only thing it reaps — a runaway build inside a *live* worktree is a different
failure with its own containment (the heavy-job gate, MemoryMax, OOMPolicy).

Safety, in the order it is enforced:
  1. Only PIDs inside an agent-rc-*.service cgroup are ever considered.
  2. Only a working directory the kernel reports as "(deleted)" AND that sits
     under a spawned-worktree root.
  3. Never an agent session or the unit's own scaffolding — a session whose
     worktree was removed underneath it is still someone's live conversation.
  4. Only after the orphan has been observed across passes spanning the grace
     period. Nothing here can tell how long a cwd has been deleted, so the
     reaper earns that fact by watching rather than guessing.
  5. SIGTERM, then SIGKILL only if it is still there.

Usage: agent-rc-reap [--dry-run] [--grace-sec N] [--state PATH]
"""
import argparse
import errno
import glob
import json
import os
import signal
import sys
import time

# `--spawn worktree` puts session worktrees under one of these roots. Matching the
# root rather than a per-project path keeps the reaper from having to be told what
# the projects are, and keeps it from ever straying outside them.
WORKTREE_ROOTS = ("/.claude/worktrees/", "/.worktrees/")

# Agent sessions and this unit's own machinery. Matched against the executable and,
# for an interpreter, its script argument — never against the whole command line.
# Both narrowings are load-bearing: ~/.claude/plugins/... contains "claude" without
# being an agent, and a shell whose script merely names an agent-rc path would
# otherwise be permanently immune to the reaper.
PROTECTED_EXE = ("claude", "codex", "tmux")
SCAFFOLDING_PREFIX = "agent-rc-"

CLK_TCK = os.sysconf("SC_CLK_TCK")


class Proc:
    __slots__ = ("pid", "cwd", "cmdline", "start_ts", "rss_kb")

    def __init__(self, pid, cwd, cmdline, start_ts, rss_kb):
        self.pid = pid
        self.cwd = cwd
        self.cmdline = cmdline
        self.start_ts = start_ts
        self.rss_kb = rss_kb

    # pid alone is not an identity: pids are recycled, and a new process must not
    # inherit the elapsed grace of the one that held its number before it.
    @property
    def key(self):
        return "%d:%s" % (self.pid, self.start_ts)

    def __repr__(self):
        return "Proc(pid=%d, rss_kb=%d, cwd=%r)" % (self.pid, self.rss_kb, self.cwd)


def is_orphan_cwd(cwd):
    """True when this working directory is a removed spawned-worktree path."""
    if not cwd.endswith(" (deleted)"):
        return False
    path = cwd[: -len(" (deleted)")]
    # The root itself is an orphan too, hence the trailing separator on both sides.
    return any(r in path + "/" for r in WORKTREE_ROOTS)


def is_protected(cmdline):
    """True for agent sessions and Remote Control scaffolding — never victims."""
    if not cmdline:
        return True  # a kernel thread or a process that raced us: not ours to judge
    argv = cmdline.split()
    exe = os.path.basename(argv[0])
    if exe in PROTECTED_EXE or exe.startswith(SCAFFOLDING_PREFIX):
        return True
    # Interpreted scaffolding: `bash /usr/local/bin/agent-rc-run`, and this script.
    # Only the script argument counts — an agent-rc path appearing anywhere later
    # in the line is a mention, not an identity.
    return len(argv) > 1 and os.path.basename(argv[1]).startswith(SCAFFOLDING_PREFIX)


def select_orphans(procs):
    return [p for p in procs if is_orphan_cwd(p.cwd) and not is_protected(p.cmdline)]


def reconcile(state, orphans, now, grace_sec):
    """Fold this pass's orphans into the carried state; return (state, due).

    State maps a process identity to the moment it was FIRST seen as an orphan.
    Identities that did not appear this pass are dropped, so a process that exits
    — or a worktree that comes back — starts from zero rather than banking credit.
    """
    fresh = {}
    due = []
    for p in orphans:
        first_seen = state.get(p.key, now)
        fresh[p.key] = first_seen
        if now - first_seen >= grace_sec:
            due.append(p)
    return fresh, due


def read_procs(pids, procfs="/proc", boot_ts=None):
    """Read the fields we judge on. Processes that exit mid-scan are skipped."""
    if boot_ts is None:
        boot_ts = _boot_ts()
    out = []
    for pid in pids:
        base = os.path.join(procfs, str(pid))
        try:
            # readlink, not realpath: the " (deleted)" suffix is the whole signal
            # and resolving the path would throw it away.
            cwd = os.readlink(os.path.join(base, "cwd"))
            with open(os.path.join(base, "cmdline"), "rb") as fh:
                cmdline = fh.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
            with open(os.path.join(base, "stat")) as fh:
                stat = fh.read()
            with open(os.path.join(base, "statm")) as fh:
                rss_pages = int(fh.read().split()[1])
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        except OSError as exc:
            if exc.errno in (errno.ESRCH, errno.EACCES, errno.EINVAL):
                continue
            raise
        # comm is field 2, parenthesised, and may itself contain spaces and ')'.
        # Everything positional has to be counted from the LAST ')'.
        fields = stat[stat.rfind(")") + 1 :].split()
        start_ts = boot_ts + int(fields[19]) / CLK_TCK
        out.append(Proc(pid, cwd, cmdline, start_ts, rss_pages * os.sysconf("SC_PAGE_SIZE") // 1024))
    return out


def _boot_ts():
    with open("/proc/stat") as fh:
        for line in fh:
            if line.startswith("btime "):
                return float(line.split()[1])
    return time.time() - float(open("/proc/uptime").read().split()[0])


def find_rc_cgroups(cgroup_root="/sys/fs/cgroup"):
    """Map each Remote Control unit cgroup to the pids inside it.

    The resume companion (agent-rc-resume-*) is deliberately excluded: it is a
    short-lived oneshot, it holds no worktrees, and it is not where leaks land.
    """
    found = {}
    for unit_dir in glob.glob(os.path.join(cgroup_root, "**", "agent-rc-*.service"), recursive=True):
        unit = os.path.basename(unit_dir)
        if unit.startswith("agent-rc-resume-") or not os.path.isdir(unit_dir):
            continue
        # The unit's own cgroup.procs plus any delegated subtree. Without the walk
        # a delegated child would hold every process and this would read empty.
        pids = []
        for dirpath, _dirnames, filenames in os.walk(unit_dir):
            if "cgroup.procs" not in filenames:
                continue
            try:
                with open(os.path.join(dirpath, "cgroup.procs")) as fh:
                    pids.extend(int(line) for line in fh if line.strip())
            except (FileNotFoundError, PermissionError):
                continue
        found[unit] = pids
    return found


def reap(victims, dry_run, killer=os.kill, grace_term_sec=10):
    """SIGTERM, wait, then SIGKILL whatever is still there. Returns what was hit."""
    if dry_run:
        return list(victims)
    hit = []
    for p in victims:
        try:
            killer(p.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
        hit.append(p)
    if not hit:
        return hit
    if grace_term_sec:
        time.sleep(grace_term_sec)
    for p in hit:
        try:
            killer(p.pid, 0)  # still alive?
        except ProcessLookupError:
            continue
        except PermissionError:
            continue
        try:
            killer(p.pid, signal.SIGKILL)
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
    ap = argparse.ArgumentParser(description="Reap processes stranded by deleted Remote Control worktrees.")
    ap.add_argument("--dry-run", action="store_true", help="report what would be killed and exit")
    ap.add_argument("--grace-sec", type=int, default=int(os.environ.get("RC_REAP_GRACE_SEC", 900)),
                    help="how long a process must be observed as an orphan before it is killed")
    ap.add_argument("--state", default=os.environ.get("RC_REAP_STATE", "/run/agent-rc-reap/seen.json"))
    ap.add_argument("--cgroup-root", default="/sys/fs/cgroup")
    args = ap.parse_args(argv)

    now = time.time()
    state = load_state(args.state)
    all_orphans = []
    for unit, pids in sorted(find_rc_cgroups(args.cgroup_root).items()):
        orphans = select_orphans(read_procs(pids))
        for p in orphans:
            print("[agent-rc-reap] %s: orphan pid=%d rss=%dM cwd=%s cmd=%.80s"
                  % (unit, p.pid, p.rss_kb // 1024, p.cwd, p.cmdline))
        all_orphans.extend(orphans)

    state, due = reconcile(state, all_orphans, now, args.grace_sec)

    if args.dry_run:
        for p in due:
            print("[agent-rc-reap] would kill pid=%d rss=%dM cmd=%.80s" % (p.pid, p.rss_kb // 1024, p.cmdline))
        print("[agent-rc-reap] dry run: %d orphan(s), %d past grace" % (len(all_orphans), len(due)))
        return 0

    hit = reap(due, dry_run=False)
    for p in hit:
        print("[agent-rc-reap] reaped pid=%d rss=%dM cwd=%s cmd=%.80s"
              % (p.pid, p.rss_kb // 1024, p.cwd, p.cmdline))
    # Whatever we just killed must not linger in state; the next pass would
    # otherwise carry a dead identity until it aged out on its own.
    for p in hit:
        state.pop(p.key, None)
    try:
        save_state(args.state, state)
    except OSError as exc:
        print("[agent-rc-reap] WARNING: cannot persist state at %s (%s) — grace restarts each pass"
              % (args.state, exc), file=sys.stderr)
    if hit:
        print("[agent-rc-reap] reaped %d process(es), %dM reclaimed"
              % (len(hit), sum(p.rss_kb for p in hit) // 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
