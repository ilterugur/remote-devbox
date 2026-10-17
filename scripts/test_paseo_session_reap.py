"""Unit tests for the finished-Paseo-session reaper.

Run: python3 -m unittest discover -s scripts -p 'test_*.py' -t scripts

Every case here is drawn from the 2026-09-08 incident on the shared box: 57 live sessions
holding 14 GB in a 34 GB cgroup, 41 of them silent for 12-114 hours. The rules that matter
are the ones that keep a kill from landing on a live conversation.
"""
import importlib.util
import os
import pathlib
import tempfile
import time
import unittest


def _load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


reap = _load("paseo_session_reap", "paseo-session-reap.py")


def session(pid=100, status="idle", idle_hours=48.0, rss_kb=800 * 1024, title="t"):
    return reap.Session(pid=pid, agent_id="a-%d" % pid, status=status,
                        idle_hours=idle_hours, title=title, rss_kb=rss_kb, start_ts=1)


class Selection(unittest.TestCase):
    """Who is finished, and — much more important — who is not."""

    def test_an_idle_session_past_the_cutoff_is_released(self):
        picked = reap.select([session(pid=7, idle_hours=13.0)], 12)
        self.assertEqual([s.pid for s in picked], [7])

    def test_a_closed_session_is_released_too(self):
        picked = reap.select([session(pid=8, status="closed", idle_hours=13.0)], 12)
        self.assertEqual([s.pid for s in picked], [8])

    def test_a_running_agent_is_never_released_however_old(self):
        # The largest and oldest process on the box was a running session. Age is not the
        # signal; the daemon's status is.
        self.assertEqual(reap.select([session(status="running", idle_hours=500.0)], 12), [])

    def test_an_unknown_status_is_treated_as_running(self):
        # A status this script has never heard of must fail closed, not open.
        self.assertEqual(reap.select([session(status="suspended")], 12), [])

    def test_a_session_inside_the_cutoff_is_left_alone(self):
        self.assertEqual(reap.select([session(idle_hours=11.9)], 12), [])

    def test_the_cutoff_is_exclusive_at_the_boundary(self):
        self.assertEqual(reap.select([session(idle_hours=12.0)], 12), [])

    def test_an_unreadable_timestamp_never_becomes_a_kill(self):
        self.assertEqual(reap.select([session(idle_hours=None)], 12), [])


class Timestamps(unittest.TestCase):
    def test_records_are_read_as_utc(self):
        # The records are UTC and the box runs at +02:00. Parsing them locally shifted
        # every age by two hours, which silently moves the cutoff.
        stamp = "2026-09-08T00:00:00.000Z"
        now = 1788825600.0  # 2026-09-08T00:00:00Z
        self.assertAlmostEqual(reap.hours_since(stamp, now=now), 0.0, places=3)

    def test_a_malformed_timestamp_is_none_not_zero(self):
        self.assertIsNone(reap.hours_since("not-a-date"))
        self.assertIsNone(reap.hours_since(None))

    def test_age_is_measured_forward(self):
        now = 1788825600.0
        self.assertAlmostEqual(reap.hours_since("2026-09-07T00:00:00Z", now=now), 24.0, places=3)


class FakeProcfs(unittest.TestCase):
    """read_sessions against a synthetic /proc, because the real one cannot be staged."""

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))

    def write_proc(self, pid, ppid, agent_id, rss_kb=1024, comm="omp"):
        d = self.root / str(pid)
        d.mkdir(parents=True, exist_ok=True)
        env = "PATH=/usr/bin\0%s=%s\0HOME=/home/dev\0" % (reap.AGENT_ENV_KEY, agent_id) \
            if agent_id else "PATH=/usr/bin\0"
        (d / "environ").write_bytes(env.encode())
        pages = rss_kb // (os.sysconf("SC_PAGE_SIZE") // 1024)
        (d / "statm").write_text("1000 %d 0 0 0 0 0\n" % pages)
        # Field 2 is comm in parentheses; the parser must count from the LAST ')'. The
        # slice it splits therefore begins at the state field, so `state` is index 0,
        # ppid is index 1 and starttime is index 19 - the layout written here.
        after_state = ["0"] * 30
        after_state[0] = str(ppid)
        after_state[18] = "5000"  # starttime, index 19 once "S" is counted
        (d / "stat").write_text("%d (%s) S %s\n" % (pid, comm, " ".join(after_state)))

    def records(self, **by_id):
        return {aid: {"id": aid, "lastStatus": st, "lastActivityAt": ts, "title": aid}
                for aid, (st, ts) in by_id.items()}

    def test_only_the_session_root_is_returned_not_its_children(self):
        # A provider's children inherit the agent id. Signalling one of them would leave
        # the heap resident and break the session anyway.
        self.write_proc(10, 1, "agent-a")
        self.write_proc(11, 10, "agent-a")
        self.write_proc(12, 11, "agent-a")
        recs = self.records(**{"agent-a": ("idle", "2026-01-01T00:00:00Z")})
        found = reap.read_sessions(recs, procfs=str(self.root))
        self.assertEqual([s.pid for s in found], [10])

    def test_two_sessions_under_one_parent_are_both_roots(self):
        self.write_proc(20, 1, "agent-b")
        self.write_proc(21, 1, "agent-c")
        recs = self.records(**{"agent-b": ("idle", "2026-01-01T00:00:00Z"),
                               "agent-c": ("idle", "2026-01-01T00:00:00Z")})
        found = reap.read_sessions(recs, procfs=str(self.root))
        self.assertEqual(sorted(s.pid for s in found), [20, 21])

    def test_a_process_with_no_record_is_not_a_session(self):
        self.write_proc(30, 1, "agent-gone")
        found = reap.read_sessions({}, procfs=str(self.root))
        self.assertEqual(found, [])

    def test_processes_without_the_agent_variable_are_ignored(self):
        self.write_proc(40, 1, None)
        recs = self.records(**{"agent-d": ("idle", "2026-01-01T00:00:00Z")})
        self.assertEqual(reap.read_sessions(recs, procfs=str(self.root)), [])

    def test_a_comm_containing_parens_does_not_break_the_parse(self):
        # Load-bearing: a mis-parsed stat line yields the wrong ppid, and the wrong ppid
        # turns a child into a root — a kill on the wrong process.
        self.write_proc(50, 1, "agent-e", comm="omp (worker)")
        recs = self.records(**{"agent-e": ("idle", "2026-01-01T00:00:00Z")})
        found = reap.read_sessions(recs, procfs=str(self.root))
        self.assertEqual([s.pid for s in found], [50])


class Release(unittest.TestCase):
    """The signal sequence. omp ignores SIGTERM, so SIGKILL has to actually arrive."""

    def setUp(self):
        self.sent = []
        self.alive = set()

    def killer(self, pid, sig):
        if sig == 0:
            if pid not in self.alive:
                raise ProcessLookupError()
            return
        self.sent.append((pid, sig))
        if sig == 9:
            self.alive.discard(pid)

    def test_a_process_ignoring_sigterm_is_killed(self):
        self.alive = {1}
        out = reap.release([session(pid=1)], dry_run=False,
                           killer=self.killer, sleeper=lambda _s: None)
        self.assertEqual(self.sent, [(1, 15), (1, 9)])
        self.assertEqual([s.pid for s in out], [1])

    def test_a_process_that_honours_sigterm_is_not_killed_again(self):
        self.alive = set()  # gone by the time the liveness probe runs
        out = reap.release([session(pid=2)], dry_run=False,
                           killer=self.killer, sleeper=lambda _s: None)
        self.assertEqual(self.sent, [(2, 15)])
        self.assertEqual([s.pid for s in out], [2])

    def test_dry_run_signals_nothing(self):
        out = reap.release([session(pid=3)], dry_run=True, killer=self.killer)
        self.assertEqual(self.sent, [])
        self.assertEqual([s.pid for s in out], [3])

    def test_a_process_that_exits_between_scan_and_signal_is_not_claimed(self):
        def gone(pid, sig):
            raise ProcessLookupError()
        out = reap.release([session(pid=4)], dry_run=False, killer=gone,
                           sleeper=lambda _s: None)
        self.assertEqual(out, [])


class Records(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.home, ignore_errors=True))

    def test_records_are_read_from_every_developer_home(self):
        for user, aid in (("dev-a", "id-a"), ("dev-b", "id-b")):
            d = self.home / user / ".paseo" / "agents" / "some-worktree"
            d.mkdir(parents=True)
            (d / ("%s.json" % aid)).write_text(
                '{"id": "%s", "lastStatus": "idle", "lastActivityAt": "2026-01-01T00:00:00Z"}'
                % aid)
        found = reap.read_records(str(self.home / "*"))
        self.assertEqual(sorted(found), ["id-a", "id-b"])

    def test_a_corrupt_record_does_not_abort_the_sweep(self):
        d = self.home / "dev-c" / ".paseo" / "agents"
        d.mkdir(parents=True)
        (d / "broken.json").write_text("{ not json")
        (d / "good.json").write_text('{"id": "id-c", "lastStatus": "idle"}')
        self.assertEqual(sorted(reap.read_records(str(self.home / "*"))), ["id-c"])

    def test_a_home_without_paseo_is_skipped(self):
        (self.home / "dev-d").mkdir()
        self.assertEqual(reap.read_records(str(self.home / "*")), {})


if __name__ == "__main__":
    unittest.main()
