"""Unit tests for the cgroup runaway guard.

Run: python3 -m unittest discover -s scripts -p 'test_*.py' -t scripts

Every number here is from the 2026-09-04/05 incidents on the shared box. The two rules
that keep this guard from making things worse are the ones to read first: a live agent
session or supervisor is never a victim, and nothing is killed on the pass that first
notices it.
"""
import importlib.util
import os
import pathlib
import shutil
import signal
import tempfile
import unittest


def _load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


guard = _load("cgroup_runaway_guard", "cgroup-runaway-guard.py")

GB = 1024 * 1024 * 1024
# The real watermarks on paseo-daemon.service.
HIGH = 34 * GB
MAX = 36 * GB
# The real pressure line while the fleet was stalled.
PRESSURE_STALLED = "some avg10=90.45 avg60=93.18 avg300=54.67 total=50004169186\nfull avg10=87.32 avg60=80.46 avg300=47.78 total=45691735806\n"
PRESSURE_CALM = "some avg10=0.23 avg60=2.63 avg300=42.83 total=42560038844\nfull avg10=0.22 avg60=2.38 avg300=41.76 total=38905127327\n"


def member(pid=3267599, comm="bun", rss_mb=24363, start_ticks=5000, cgroup="/cg/paseo-daemon.service"):
    return guard.Member(pid=pid, comm=comm, rss_kb=rss_mb * 1024, start_ticks=start_ticks, cgroup=cgroup)


class Protected(unittest.TestCase):
    """Processes the guard must never kill, however large they get."""

    def test_the_supervisor_and_daemon_are_protected(self):
        # comm is 15 bytes, so the daemon's own name arrives truncated.
        self.assertTrue(guard.is_protected("Paseo Daemon"))
        self.assertTrue(guard.is_protected("Paseo Superviso"))

    def test_agent_sessions_are_protected(self):
        # Killing one of these drops somebody's live conversation, which is strictly
        # worse than the stall it would relieve.
        for comm in ("omp", "omp daemon brok", "codex", "claude", "tmux"):
            self.assertTrue(guard.is_protected(comm), comm)

    def test_the_guard_never_targets_itself(self):
        self.assertTrue(guard.is_protected("cgroup-runaway-g"))

    def test_connectivity_and_session_plumbing_is_protected(self):
        for comm in ("sshd", "sshd-session", "dbus-daemon", "mosh-server", "hermes"):
            self.assertTrue(guard.is_protected(comm), comm)

    def test_the_runaways_from_the_incidents_are_not_protected(self):
        # 2026-09-05: `bun run src/index.ts` dev server at 24.4 GB.
        self.assertFalse(guard.is_protected("bun"))
        # 2026-09-04: `vite build` under node at 13.8 GB, and its esbuild children.
        self.assertFalse(guard.is_protected("node"))
        self.assertFalse(guard.is_protected("esbuild"))
        # A leaking workspace tab's renderer.
        self.assertFalse(guard.is_protected("chrome"))


class Pinned(unittest.TestCase):
    """Being at the wall is what makes a stall this guard's business."""

    def test_usage_at_the_watermark_counts(self):
        self.assertTrue(guard.is_pinned(34 * GB, HIGH, 0.98))

    def test_usage_just_below_the_watermark_still_counts(self):
        # The kernel holds usage a little under high while it reclaims, so equality
        # almost never lands on a sample boundary.
        self.assertTrue(guard.is_pinned(int(33.5 * GB), HIGH, 0.98))

    def test_a_cgroup_with_room_left_is_not_pinned(self):
        self.assertFalse(guard.is_pinned(24 * GB, HIGH, 0.98))
        self.assertFalse(guard.is_pinned(int(27.6 * GB), HIGH, 0.98))

    def test_missing_numbers_are_never_treated_as_pinned(self):
        self.assertFalse(guard.is_pinned(None, HIGH, 0.98))
        self.assertFalse(guard.is_pinned(34 * GB, None, 0.98))


class PressureParsing(unittest.TestCase):
    def test_it_reads_the_full_averages(self):
        p = guard.parse_pressure(PRESSURE_STALLED)
        self.assertAlmostEqual(p["avg10"], 87.32)
        self.assertAlmostEqual(p["avg300"], 47.78)

    def test_a_calm_cgroup_reads_near_zero(self):
        self.assertLess(guard.parse_pressure(PRESSURE_CALM)["avg10"], 1.0)

    def test_a_malformed_line_is_skipped_not_fatal(self):
        self.assertEqual(guard.parse_pressure("full avg10=nonsense\n"), {})
        self.assertEqual(guard.parse_pressure(""), {})


class Candidate(unittest.TestCase):
    """Who gets picked when a cgroup is stalled."""

    def setUp(self):
        self.floor = 6144 * 1024  # 6 GiB, the configured default

    def test_the_biggest_unprotected_member_is_chosen(self):
        members = [
            member(pid=3267599, comm="bun", rss_mb=24363),
            member(pid=101501, comm="node", rss_mb=12205),
            member(pid=881250, comm="Paseo Daemon", rss_mb=1306),
        ]
        self.assertEqual(guard.select_candidate(members, self.floor).pid, 3267599)

    def test_a_protected_member_is_never_chosen_however_large(self):
        # The daemon itself has been the largest member of its own cgroup before now.
        members = [member(pid=881250, comm="Paseo Daemon", rss_mb=30000),
                   member(pid=999, comm="node", rss_mb=7000)]
        self.assertEqual(guard.select_candidate(members, self.floor).pid, 999)

    def test_nothing_is_chosen_when_the_weight_is_spread_across_sessions(self):
        # 15 sessions at ~500 MB each stall the cgroup just as effectively, and killing
        # the largest of them costs work while fixing nothing. That is a capacity
        # problem, and this guard must decline it.
        members = [member(pid=i, comm="omp", rss_mb=520) for i in range(1000, 1015)]
        self.assertIsNone(guard.select_candidate(members, self.floor))

    def test_a_member_below_the_floor_is_never_chosen(self):
        self.assertIsNone(guard.select_candidate([member(comm="node", rss_mb=6143)], self.floor))
        self.assertIsNotNone(guard.select_candidate([member(comm="node", rss_mb=6144)], self.floor))


class GracePeriod(unittest.TestCase):
    """Nothing is killed on the pass that first notices it."""

    def setUp(self):
        self.runaway = member(start_ticks=5000)

    def test_a_freshly_seen_runaway_is_recorded_but_not_killed(self):
        state, due = guard.reconcile({}, [self.runaway], now=1000.0, grace_sec=120)
        self.assertEqual(due, [])
        self.assertEqual(list(state), ["3267599:5000"])

    def test_it_is_killed_once_it_has_held_the_top_spot_for_the_grace(self):
        state, _ = guard.reconcile({}, [self.runaway], now=1000.0, grace_sec=120)
        _, due = guard.reconcile(state, [self.runaway], now=1120.0, grace_sec=120)
        self.assertEqual([m.pid for m in due], [3267599])

    def test_it_is_spared_while_still_inside_the_grace(self):
        state, _ = guard.reconcile({}, [self.runaway], now=1000.0, grace_sec=120)
        _, due = guard.reconcile(state, [self.runaway], now=1119.0, grace_sec=120)
        self.assertEqual(due, [])

    def test_a_spike_that_resolves_loses_its_record(self):
        # The cgroup came off its wall between two passes: a build that finished, a tab
        # that was closed. The earlier sighting must not count toward a later kill.
        state, _ = guard.reconcile({}, [self.runaway], now=1000.0, grace_sec=120)
        state, _ = guard.reconcile(state, [], now=1060.0, grace_sec=120)
        state, due = guard.reconcile(state, [self.runaway], now=1121.0, grace_sec=120)
        self.assertEqual(due, [])

    def test_a_recycled_pid_starts_its_own_clock(self):
        state, _ = guard.reconcile({}, [self.runaway], now=1000.0, grace_sec=120)
        _, due = guard.reconcile(state, [member(start_ticks=99999)], now=1120.0, grace_sec=120)
        self.assertEqual(due, [])

    def test_a_different_runaway_taking_the_top_spot_starts_its_own_clock(self):
        state, _ = guard.reconcile({}, [self.runaway], now=1000.0, grace_sec=120)
        other = member(pid=4058271, comm="node", rss_mb=9000, start_ticks=7000)
        state, due = guard.reconcile(state, [other], now=1120.0, grace_sec=120)
        self.assertEqual(due, [])
        self.assertEqual(list(state), ["4058271:7000"])


class Assess(unittest.TestCase):
    """The whole verdict, against a synthetic cgroup and procfs."""

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.cg = self.root / "cgroup" / "paseo-daemon.service"
        self.cg.mkdir(parents=True)
        self.procfs = self.root / "proc"
        self.procfs.mkdir()

    def write_cgroup(self, current, high=HIGH, pressure=PRESSURE_STALLED, pids=()):
        (self.cg / "memory.current").write_text("%d\n" % current)
        (self.cg / "memory.high").write_text("max\n" if high is None else "%d\n" % high)
        (self.cg / "memory.max").write_text("%d\n" % MAX)
        (self.cg / "memory.pressure").write_text(pressure)
        (self.cg / "cgroup.procs").write_text("".join("%d\n" % p for p in pids))

    def write_proc(self, pid, comm, rss_mb, start_ticks=5000):
        d = self.procfs / str(pid)
        d.mkdir(parents=True)
        (d / "comm").write_text(comm + "\n")
        (d / "statm").write_text("1000 %d 0 0 0 0 0\n" % (rss_mb * 1024 // 4))
        # field 2 is comm in parens and may itself contain spaces and parens; everything
        # is positional after the final ')'.
        (d / "stat").write_text("%d (a name (odd)) S " % pid + " ".join(["0"] * 18)
                                + " %d " % start_ticks + " ".join(["0"] * 30) + "\n")

    def assess(self, floor_mb=6144):
        return guard.assess(str(self.cg), 0.98, 25, floor_mb * 1024, procfs=str(self.procfs))

    def test_the_incident_is_diagnosed_and_the_dev_server_named(self):
        self.write_cgroup(current=34 * GB, pids=[3267599, 881250])
        self.write_proc(3267599, "bun", 24363)
        self.write_proc(881250, "Paseo Daemon", 1306)
        verdict, candidate = self.assess()
        self.assertEqual(verdict, "stalled")
        self.assertEqual((candidate.pid, candidate.comm), (3267599, "bun"))

    def test_a_cgroup_with_room_left_is_not_touched(self):
        self.write_cgroup(current=24 * GB, pids=[3267599])
        self.write_proc(3267599, "bun", 24363)
        self.assertEqual(self.assess(), ("below-wall", None))

    def test_at_the_wall_but_calm_is_left_alone(self):
        # A fleet that lives at its watermark without stalling is a healthy steady
        # state, and killing its largest member would be pure damage.
        self.write_cgroup(current=34 * GB, pressure=PRESSURE_CALM, pids=[3267599])
        self.write_proc(3267599, "bun", 24363)
        self.assertEqual(self.assess(), ("pinned-no-stall", None))

    def test_an_unbounded_cgroup_has_no_wall_to_be_pinned_against(self):
        self.write_cgroup(current=34 * GB, high=None, pids=[3267599])
        self.write_proc(3267599, "bun", 24363)
        self.assertEqual(self.assess(), ("unbounded", None))

    def test_a_stall_with_no_single_runaway_is_reported_not_acted_on(self):
        pids = list(range(1000, 1015))
        self.write_cgroup(current=34 * GB, pids=pids)
        for p in pids:
            self.write_proc(p, "omp", 520)
        self.assertEqual(self.assess(), ("stalled-no-candidate", None))

    def test_a_process_that_exits_mid_pass_is_skipped_not_fatal(self):
        self.write_cgroup(current=34 * GB, pids=[3267599, 999999])
        self.write_proc(3267599, "bun", 24363)
        verdict, candidate = self.assess()
        self.assertEqual(verdict, "stalled")
        self.assertEqual(candidate.pid, 3267599)

    def test_cmdline_is_never_read(self):
        # Load-bearing: reading /proc/<pid>/cmdline faults the target's pages back in
        # from swap, and under the stall this guard exists for that blocks for minutes.
        # A cmdline that cannot be read at all must not affect the verdict.
        self.write_cgroup(current=34 * GB, pids=[3267599])
        self.write_proc(3267599, "bun", 24363)
        cmdline = self.procfs / "3267599" / "cmdline"
        cmdline.mkdir()  # any read attempt would raise IsADirectoryError
        verdict, candidate = self.assess()
        self.assertEqual(verdict, "stalled")
        self.assertEqual(candidate.pid, 3267599)


class Discovery(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))

    def test_it_finds_the_agent_cgroups_and_nothing_else(self):
        base = self.root / "user.slice" / "user-1004.slice" / "user@1004.service" / "app.slice"
        for name in ("paseo-daemon.service", "agent-rc-claude-ilterugur-verti-monorepo.service",
                     "app-com.google.Chrome-2780437.scope", "dbus.service"):
            (base / name).mkdir(parents=True)
        found = [os.path.basename(p) for p in guard.find_cgroups(
            (str(self.root) + "/**/paseo-daemon.service", str(self.root) + "/**/agent-rc-*.service"))]
        self.assertEqual(sorted(found),
                         ["agent-rc-claude-ilterugur-verti-monorepo.service", "paseo-daemon.service"])


class Reaping(unittest.TestCase):
    def setUp(self):
        self.killed = []
        self.runaway = member()

    def kill(self, pid, sig):
        self.killed.append((pid, sig))

    def test_dry_run_reports_without_killing(self):
        hit = guard.reap([self.runaway], dry_run=True, killer=self.kill)
        self.assertEqual(self.killed, [])
        self.assertEqual([m.pid for m in hit], [3267599])

    def test_it_terminates_then_probes_then_kills(self):
        # The dev server measured on 2026-09-05 ignored SIGTERM outright, so the escalation
        # is not optional.
        guard.reap([self.runaway], dry_run=False, killer=self.kill, grace_term_sec=0)
        self.assertEqual(self.killed,
                         [(3267599, signal.SIGTERM), (3267599, 0), (3267599, signal.SIGKILL)])

    def test_a_process_that_exits_on_sigterm_is_not_signalled_again(self):
        def kill(pid, sig):
            self.killed.append((pid, sig))
            if sig == 0:
                raise ProcessLookupError()

        guard.reap([self.runaway], dry_run=False, killer=kill, grace_term_sec=0)
        self.assertEqual(self.killed, [(3267599, signal.SIGTERM), (3267599, 0)])


class StateFile(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.dir, ignore_errors=True))

    def test_a_missing_or_corrupt_state_file_starts_empty_rather_than_crashing(self):
        self.assertEqual(guard.load_state(str(self.dir / "nope.json")), {})
        bad = self.dir / "bad.json"
        bad.write_text("{not json")
        self.assertEqual(guard.load_state(str(bad)), {})

    def test_state_round_trips(self):
        path = str(self.dir / "sub" / "seen.json")
        guard.save_state(path, {"3267599:5000": 1000.0})
        self.assertEqual(guard.load_state(path), {"3267599:5000": 1000.0})


if __name__ == "__main__":
    unittest.main()
