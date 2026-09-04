#!/usr/bin/env python3
"""Managed by remote-devbox. Reaps Chrome instances stranded by finished agent sessions.

An agent session that drives a browser spawns Chrome detached, with a throwaway
profile under a scratch root, and talks to it over CDP on a loopback port. When the
session ends the tool is supposed to close the browser. When it does not — the
session was killed, the box was under pressure, the harness crashed — Chrome keeps
running: reparented to `systemd --user`, still listening on its debugging port,
with nobody on the other end. A browser plus its renderers is 1.2-1.5 GB, and they
accumulate one per abandoned session.

That is what this reaps. From the 2026-09-04 incident on the shared box: 15 stranded
instances, 163 processes, 20.5 GB RSS, load 84 on 16 cores, and `memory.pressure`
reporting `full avg10=51.7%` — every process on the box, including every live agent
session, stalled in reclaim half the time. Killing the 12 idle instances returned
18.6 GB. Nothing else was wrong with the box.

The decisive signal is the CDP socket, not CPU and not age. A browser puppeteer or
omp is driving holds an ESTABLISHED connection to its own debugging port for as long
as the client lives; an abandoned one is left with the LISTEN socket and no peer.
CPU is worthless here — a stranded instance with an animating page burns more than
an idle live one, and the incident's most active leaked browser was at 6.4%.

Safety, in the order it is enforced:
  1. Only a Chrome *browser* process — never a renderer, GPU, zygote or crashpad
     helper. Those die with their browser; signalling them individually would leave
     a live browser with holes in it.
  2. Only a browser whose --user-data-dir is a throwaway automation profile. A
     browser with a real profile, or none, is somebody's actual browser.
  3. Never a browser inside a systemd service cgroup. The managed endpoints — the
     fallback Chrome, each developer's playwright MCP server — are services, and
     they are supposed to sit idle waiting for work.
  4. Never a browser whose spawner is still alive: something owns it.
  5. Only when the process's own fd table shows a CDP port with no ESTABLISHED
     peer. This is the one rule that distinguishes abandoned from merely quiet, so
     it is also the one that must fail closed: an fd table the reaper cannot read
     (no CAP_SYS_PTRACE, hidepid) proves nothing and spares the browser.
  6. Only after the sighting has held across passes spanning the grace period, so a
     client reconnecting between two sweeps is never mistaken for an absent one.
  7. SIGTERM, then SIGKILL only if it is still there.
  8. Then, and only then, its profile directory — but only inside the scratch root,
     and only if no surviving browser names it. The tmpfiles policy ages that root
     in days; a browser's dead profile is garbage the instant its owner is gone, and
     the incident left 3.8 GB of it behind on a disk that was already 92% full.

Usage: orphan-browser-reap [--dry-run] [--grace-sec N] [--state PATH]
                           [--profile-glob GLOB]... [--purge-profiles-under DIR]... [--keep-profiles]
"""
import argparse
import errno
import fnmatch
import json
import os
import shlex
import shutil
import signal
import sys
import time

# argv[0]'s basename for a Chrome *browser* process. The crashpad handler is
# deliberately absent: it is a separate executable and it is not what holds the heap.
BROWSER_EXE = ("chrome", "chrome-stable", "google-chrome", "google-chrome-stable",
               "chromium", "chromium-browser")

# Profiles that exist only for the life of one automation session. `puppeteer_dev_
# chrome_profile-*` is puppeteer's own mkdtemp name (on this box the scratch root is
# redirected per account); `omp.browser*` is the harness's managed browser daemon.
# Matching the profile rather than the port or the command line is what keeps this
# away from browsers that belong to a person: a real profile never looks like these.
DEFAULT_PROFILE_GLOBS = (
    "/var/tmp/devbox-scratch/*/puppeteer_dev_chrome_profile-*",
    "/tmp/puppeteer_dev_chrome_profile-*",
    "*/.omp/run/daemons/*/omp.browser*",
    "*/.cache/omp/browser/*",
)

# Where a reaped browser's profile may be deleted. The scratch root is the one place
# a throwaway profile is guaranteed to be throwaway AND writable by this unit; the
# home-based harness profiles are left to their owner, and ProtectHome=yes in the
# unit enforces that rather than trusting this list.
DEFAULT_PURGE_ROOTS = ("/var/tmp/devbox-scratch",)

# /proc/net/tcp state column, in the kernel's hex.
TCP_ESTABLISHED = "01"
TCP_LISTEN = "0A"

CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_KB = os.sysconf("SC_PAGE_SIZE") // 1024


class Browser:
    """One Chrome browser process, with the facts the rules are decided on.

    `sockets_readable` is not a detail: an empty port set means "this browser
    exposes no CDP endpoint" only when the fd table was actually read. When it was
    not — no CAP_SYS_PTRACE, hidepid, a process that exited mid-scan — the same
    empty set would otherwise read as "nobody is attached" and turn the one rule
    that protects busy browsers into a rule that kills them.
    """

    __slots__ = ("pid", "cmdline", "cgroup", "profile", "spawner_alive",
                 "listen_ports", "peer_ports", "sockets_readable", "start_ts", "rss_kb")

    def __init__(self, pid, cmdline, cgroup, profile, spawner_alive,
                 listen_ports, peer_ports, sockets_readable=True, start_ts=0.0, rss_kb=0):
        self.pid = pid
        self.cmdline = cmdline
        self.cgroup = cgroup
        self.profile = profile
        self.spawner_alive = spawner_alive
        self.listen_ports = frozenset(listen_ports)
        self.peer_ports = frozenset(peer_ports)
        self.sockets_readable = sockets_readable
        self.start_ts = start_ts
        self.rss_kb = rss_kb

    # pid alone is not an identity: pids are recycled, and a new process must not
    # inherit the elapsed grace of the one that held its number before it.
    @property
    def key(self):
        return "%d:%s" % (self.pid, self.start_ts)

    def __repr__(self):
        return "Browser(pid=%d, rss_kb=%d, profile=%r)" % (self.pid, self.rss_kb, self.profile)


def _argv(cmdline):
    """Chrome's command line, split without letting a quoted path break the split."""
    try:
        return shlex.split(cmdline)
    except ValueError:
        return cmdline.split()


def is_browser_process(cmdline):
    """True for a Chrome browser process, false for every helper it spawns.

    Renderers, the GPU process, zygotes and utilities all carry --type=; the browser
    is the only one that does not. They are children of the browser and exit with it,
    so they are never victims in their own right.
    """
    if not cmdline:
        return False
    argv = _argv(cmdline)
    if os.path.basename(argv[0]) not in BROWSER_EXE:
        return False
    return not any(a == "--type" or a.startswith("--type=") for a in argv[1:])


def profile_dir(cmdline):
    """The --user-data-dir Chrome was started with, or None when it has no flag."""
    argv = _argv(cmdline)
    for i, arg in enumerate(argv):
        if arg.startswith("--user-data-dir="):
            return arg[len("--user-data-dir="):] or None
        if arg == "--user-data-dir" and i + 1 < len(argv):
            return argv[i + 1] or None
    return None


def is_throwaway_profile(profile, globs=DEFAULT_PROFILE_GLOBS):
    """True only for a profile that exists for one automation session and no longer."""
    if not profile:
        return False
    # A trailing separator would make the globs miss, and `..` in a scratch path is
    # how a profile argument reaches outside the root it appears to be under.
    path = os.path.normpath(profile)
    return any(fnmatch.fnmatchcase(path, g) for g in globs)


def is_service_cgroup(cgroup):
    """True when the process belongs to a systemd service.

    The managed browser endpoints run as services and are meant to idle with no
    client attached — that is their whole job. An app scope, a session scope or a
    bare cgroup path is where a session-spawned browser lands.
    """
    leaf = (cgroup or "").rstrip("/").rsplit("/", 1)[-1]
    return leaf.endswith(".service")


def has_attached_client(browser):
    """True when something is on the other end of this browser's debugging port."""
    return bool(browser.listen_ports & browser.peer_ports)


def is_orphan(browser, globs=DEFAULT_PROFILE_GLOBS):
    if not is_throwaway_profile(browser.profile, globs):
        return False
    if is_service_cgroup(browser.cgroup):
        return False
    if browser.spawner_alive:
        return False
    # Everything below is the proof requirement. A kill needs positive evidence
    # that this browser publishes a CDP endpoint and that nothing is on it; the
    # absence of evidence — an unreadable fd table, a browser that never exposed
    # a port — is never promoted into a conclusion.
    if not browser.sockets_readable or not browser.listen_ports:
        return False
    return not has_attached_client(browser)


def select_orphans(browsers, globs=DEFAULT_PROFILE_GLOBS):
    return [b for b in browsers if is_orphan(b, globs)]


def reconcile(state, orphans, now, grace_sec):
    """Fold this pass's orphans into the carried state; return (state, due).

    State maps a process identity to the moment it was FIRST seen orphaned.
    Identities absent from this pass are dropped, so a browser that exits — or one a
    client reattached to — starts from zero rather than banking credit toward a kill.
    """
    fresh = {}
    due = []
    for b in orphans:
        first_seen = state.get(b.key, now)
        fresh[b.key] = first_seen
        if now - first_seen >= grace_sec:
            due.append(b)
    return fresh, due


def parse_tcp_table(text):
    """Yield (inode, local_port, peer_port, state) from a /proc/net/tcp{,6} table."""
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 10:
            continue
        try:
            local_port = int(fields[1].rsplit(":", 1)[1], 16)
            peer_port = int(fields[2].rsplit(":", 1)[1], 16)
            inode = int(fields[9])
        except (IndexError, ValueError):
            continue
        yield inode, local_port, peer_port, fields[3]


def socket_inodes(pid, procfs="/proc"):
    """The socket inodes this process holds open, or None when the fd table is closed to us.

    Readlinking another uid's fd table is ptrace-mode gated (CAP_SYS_PTRACE), so
    "unreadable" is a state the reaper genuinely reaches — and it has to be told
    apart from "read it, and there were no sockets".
    """
    fd_dir = os.path.join(procfs, str(pid), "fd")
    try:
        names = os.listdir(fd_dir)
    except OSError:
        return None
    inodes = set()
    for name in names:
        try:
            target = os.readlink(os.path.join(fd_dir, name))
        except OSError:
            continue
        if target.startswith("socket:["):
            try:
                inodes.add(int(target[len("socket:["):-1]))
            except ValueError:
                continue
    return inodes


def cdp_ports(pid, tcp_tables, procfs="/proc"):
    """This browser's own (listening ports, ports with a live peer, fd table readable).

    Ownership is established through the process's fd table rather than by port
    number: /proc/net/tcp is the whole namespace, and the reaper must never draw a
    conclusion about one browser from another browser's connection.
    """
    mine = socket_inodes(pid, procfs)
    listening = set()
    peered = set()
    if not mine:
        return listening, peered, mine is not None
    for table in tcp_tables:
        for inode, local_port, peer_port, state in table:
            if inode not in mine:
                continue
            if state == TCP_LISTEN:
                listening.add(local_port)
            elif state == TCP_ESTABLISHED and peer_port:
                peered.add(local_port)
    return listening, peered, True


def read_tcp_tables(procfs="/proc"):
    tables = []
    for name in ("net/tcp", "net/tcp6"):
        try:
            with open(os.path.join(procfs, name)) as fh:
                tables.append(list(parse_tcp_table(fh.read())))
        except OSError:
            continue
    return tables


def _read(path, binary=False):
    mode = "rb" if binary else "r"
    with open(path, mode) as fh:
        return fh.read()


def _cmdline(pid, procfs="/proc"):
    raw = _read(os.path.join(procfs, str(pid), "cmdline"), binary=True)
    return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()


def _is_user_manager(cmdline):
    """True for `systemd --user`, the manager a detached browser reparents onto."""
    argv = _argv(cmdline)
    return bool(argv) and os.path.basename(argv[0]) == "systemd" and "--user" in argv[1:]


def read_browsers(procfs="/proc", boot_ts=None):
    """Scan /proc for Chrome browser processes and the facts the rules need."""
    if boot_ts is None:
        boot_ts = _boot_ts()
    tcp_tables = read_tcp_tables(procfs)
    out = []
    for entry in os.listdir(procfs):
        if not entry.isdigit():
            continue
        pid = int(entry)
        base = os.path.join(procfs, entry)
        try:
            # comm is one short read and rejects everything that is not Chrome, so
            # the expensive reads never happen for the other few thousand processes.
            comm = _read(os.path.join(base, "comm")).strip()
            if not comm.startswith(("chrome", "chromium", "google-chrome")):
                continue
            cmdline = _cmdline(pid, procfs)
            if not is_browser_process(cmdline):
                continue
            profile = profile_dir(cmdline)
            cgroup = _read(os.path.join(base, "cgroup")).strip().rsplit(":", 1)[-1]
            stat = _read(os.path.join(base, "stat"))
            rss_pages = int(_read(os.path.join(base, "statm")).split()[1])
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
            continue
        except OSError as exc:
            if exc.errno in (errno.ESRCH, errno.EACCES, errno.EINVAL):
                continue
            raise
        # comm is field 2, parenthesised, and may itself contain spaces and ')'.
        # Everything positional has to be counted from the LAST ')'.
        fields = stat[stat.rfind(")") + 1:].split()
        ppid = int(fields[1])
        start_ts = boot_ts + int(fields[19]) / CLK_TCK
        spawner_alive = ppid > 1
        if spawner_alive:
            try:
                spawner_alive = not _is_user_manager(_cmdline(ppid, procfs))
            except OSError:
                spawner_alive = False  # the parent went away between the two reads
        listening, peered, readable = cdp_ports(pid, tcp_tables, procfs)
        out.append(Browser(pid=pid, cmdline=cmdline, cgroup=cgroup, profile=profile,
                           spawner_alive=spawner_alive, listen_ports=listening,
                           peer_ports=peered, sockets_readable=readable,
                           start_ts=start_ts, rss_kb=rss_pages * PAGE_KB))
    return out


def _boot_ts():
    with open("/proc/stat") as fh:
        for line in fh:
            if line.startswith("btime "):
                return float(line.split()[1])
    return time.time() - float(open("/proc/uptime").read().split()[0])


def reap(victims, dry_run, killer=os.kill, grace_term_sec=10):
    """SIGTERM, wait, then SIGKILL whatever is still there. Returns what was hit.

    Only the browser process is signalled. Its renderers exit with it — during the
    incident, killing 12 browsers took 163 Chrome processes down to 23 — and a
    renderer killed on its own would leave a live browser showing a crashed tab.
    """
    if dry_run:
        return list(victims)
    hit = []
    for b in victims:
        try:
            killer(b.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
        hit.append(b)
    if not hit:
        return hit
    if grace_term_sec:
        time.sleep(grace_term_sec)
    for b in hit:
        try:
            killer(b.pid, 0)  # still alive?
        except (ProcessLookupError, PermissionError):
            continue
        try:
            killer(b.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return hit


def purgeable_profile(profile, roots=DEFAULT_PURGE_ROOTS, in_use=(), globs=DEFAULT_PROFILE_GLOBS):
    """True when a dead browser's profile directory is safe to delete.

    Deleting by ownership rather than by age is the whole point: the reaper just
    killed the only process that used this directory, so there is nothing to guess
    about. The tmpfiles policy still ages the scratch root, but it measures days —
    during the incident that left 3.8 GB of dead profiles behind a 92%-full disk.
    """
    if not is_throwaway_profile(profile, globs):
        return False
    path = os.path.normpath(profile)
    if path in {os.path.normpath(p) for p in in_use if p}:
        return False
    for root in roots:
        root = os.path.normpath(root)
        # The root itself is never a victim, only something strictly inside it.
        if path != root and path.startswith(root + os.sep):
            return True
    return False


def purge_profiles(paths, dry_run=False, remover=shutil.rmtree, tree_size=None):
    """Remove the given profile trees. Returns (removed paths, bytes freed)."""
    sizer = tree_size or _tree_bytes
    removed = []
    freed = 0
    for path in paths:
        # A symlink here would make the delete land wherever it points. The dir is
        # created by puppeteer under a 0700 root, so this is defence, not a case
        # anyone has seen — which is exactly when it has to already be handled.
        if os.path.islink(path) or not os.path.isdir(path):
            continue
        size = sizer(path)
        if dry_run:
            removed.append(path)
            freed += size
            continue
        try:
            remover(path)
        except OSError as exc:
            print("[orphan-browser-reap] WARNING: cannot remove %s (%s)" % (path, exc), file=sys.stderr)
            continue
        removed.append(path)
        freed += size
    return removed, freed


def _tree_bytes(path):
    total = 0
    for dirpath, _dirnames, filenames in os.walk(path):
        for name in filenames:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                continue
    return total


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
    ap = argparse.ArgumentParser(description="Reap Chrome instances stranded by finished agent sessions.")
    ap.add_argument("--dry-run", action="store_true", help="report what would be killed and exit")
    ap.add_argument("--grace-sec", type=int, default=int(os.environ.get("BROWSER_REAP_GRACE_SEC", 900)),
                    help="how long a browser must be observed orphaned before it is killed")
    ap.add_argument("--state", default=os.environ.get("BROWSER_REAP_STATE", "/run/orphan-browser-reap/seen.json"))
    ap.add_argument("--profile-glob", action="append", default=None, metavar="GLOB",
                    help="throwaway profile pattern; repeatable, replaces the built-in set")
    ap.add_argument("--purge-profiles-under", action="append", default=None, metavar="DIR",
                    help="delete a reaped browser's profile when it sits under DIR; repeatable")
    ap.add_argument("--keep-profiles", action="store_true",
                    help="reap the browsers but leave their profile directories on disk")
    ap.add_argument("--procfs", default="/proc")
    args = ap.parse_args(argv)

    globs = tuple(args.profile_glob) if args.profile_glob else DEFAULT_PROFILE_GLOBS
    now = time.time()
    state = load_state(args.state)

    browsers = read_browsers(args.procfs)
    orphans = select_orphans(browsers, globs)
    # A browser the reaper is blind to is the failure worth saying out loud: the
    # sweep still exits 0, so nothing else would ever surface a lost capability.
    blind = [b for b in browsers if not b.sockets_readable]
    if blind:
        print("[orphan-browser-reap] WARNING: cannot read the fd table of %d browser(s) (%s) — "
              "they are spared; the unit needs CAP_SYS_PTRACE to judge them"
              % (len(blind), ", ".join(str(b.pid) for b in blind)), file=sys.stderr)
    for b in orphans:
        print("[orphan-browser-reap] orphan pid=%d rss=%dM listen=%s profile=%s"
              % (b.pid, b.rss_kb // 1024, sorted(b.listen_ports) or "-", b.profile))

    state, due = reconcile(state, orphans, now, args.grace_sec)

    purge_roots = () if args.keep_profiles else tuple(args.purge_profiles_under or DEFAULT_PURGE_ROOTS)

    if args.dry_run:
        live = [b.profile for b in browsers if b.pid not in {d.pid for d in due}]
        doomed = [b.profile for b in due if purgeable_profile(b.profile, purge_roots, live, globs)]
        for b in due:
            print("[orphan-browser-reap] would kill pid=%d rss=%dM profile=%s"
                  % (b.pid, b.rss_kb // 1024, b.profile))
        _, would_free = purge_profiles(doomed, dry_run=True)
        if doomed:
            print("[orphan-browser-reap] would remove %d profile dir(s), %dM"
                  % (len(doomed), would_free // 1048576))
        print("[orphan-browser-reap] dry run: %d browser(s), %d orphaned, %d past grace"
              % (len(browsers), len(orphans), len(due)))
        return 0

    hit = reap(due, dry_run=False)
    for b in hit:
        print("[orphan-browser-reap] reaped pid=%d rss=%dM profile=%s" % (b.pid, b.rss_kb // 1024, b.profile))
    # Whatever we just killed must not linger in state; the next pass would
    # otherwise carry a dead identity until it aged out on its own.
    for b in hit:
        state.pop(b.key, None)
    try:
        save_state(args.state, state)
    except OSError as exc:
        print("[orphan-browser-reap] WARNING: cannot persist state at %s (%s) — grace restarts each pass"
              % (args.state, exc), file=sys.stderr)
    # Only after the browser is gone, and only for a profile no surviving browser
    # names: the directory is the dead process's private mkdtemp, so once its owner
    # has been killed nothing else can want it.
    survivors = [b.profile for b in browsers if b.pid not in {h.pid for h in hit}]
    removed, freed = purge_profiles(
        [b.profile for b in hit if purgeable_profile(b.profile, purge_roots, survivors, globs)])
    for path in removed:
        print("[orphan-browser-reap] removed profile %s" % path)
    if hit:
        print("[orphan-browser-reap] reaped %d browser(s), %dM of memory and %dM of disk reclaimed"
              % (len(hit), sum(b.rss_kb for b in hit) // 1024, freed // 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
