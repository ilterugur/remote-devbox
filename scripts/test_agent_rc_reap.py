"""Unit tests for the Remote Control worktree-orphan reaper.

Run: python3 -m unittest discover -s scripts -p 'test_*.py' -t scripts

Every case here is drawn from the 2026-08-19 incident on the shared box, where a
single Remote Control unit sat above MemoryHigh for hours because build processes
from long-deleted `--spawn worktree` worktrees were never reaped. The two rules
that matter most are the ones that keep the reaper from making things worse: a
live agent session is never a victim, and a process is only killed after it has
been observed as an orphan across more than one pass.
"""
import importlib.util
import os
import pathlib
import tempfile
import unittest


def _load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


reap = _load("agent_rc_reap", "agent-rc-reap.py")

WT = "/home/ilterugur/projects/verti-monorepo/.claude/worktrees/bridge-cse_018JQEoTCnjYn2RqbJn6Wb6X"
WT2 = "/home/ilterugur/projects/verti-monorepo/.worktrees/controller-attachment-continuity"


def proc(pid, cwd, cmdline, start_ts=1000.0, rss_kb=1024):
    return reap.Proc(pid=pid, cwd=cwd, cmdline=cmdline, start_ts=start_ts, rss_kb=rss_kb)


class OrphanCwd(unittest.TestCase):
    """Only a *deleted* directory *under a worktree root* makes a process an orphan."""

    def test_deleted_dir_under_a_spawned_worktree_is_an_orphan(self):
        self.assertTrue(reap.is_orphan_cwd(WT + "/apps/api (deleted)"))

    def test_deleted_dir_under_the_dot_worktrees_root_is_an_orphan(self):
        self.assertTrue(reap.is_orphan_cwd(WT2 + "/apps/web (deleted)"))

    def test_the_worktree_root_itself_counts(self):
        self.assertTrue(reap.is_orphan_cwd(WT + " (deleted)"))

    def test_a_live_worktree_is_never_an_orphan(self):
        self.assertFalse(reap.is_orphan_cwd(WT + "/apps/api"))

    def test_a_deleted_dir_outside_any_worktree_is_not_our_business(self):
        # Plenty of things legitimately run with a deleted cwd. The reaper owns
        # exactly one failure mode and must not generalise into a process killer.
        self.assertFalse(reap.is_orphan_cwd("/tmp/build-xyz (deleted)"))
        self.assertFalse(reap.is_orphan_cwd("/home/ilterugur/projects/verti-monorepo (deleted)"))

    def test_a_path_merely_mentioning_worktrees_does_not_match(self):
        self.assertFalse(reap.is_orphan_cwd("/home/ilterugur/my-worktrees/thing (deleted)"))
        self.assertFalse(reap.is_orphan_cwd("/home/ilterugur/notes/.claude/worktrees.md (deleted)"))


class Protected(unittest.TestCase):
    """Processes the reaper must never kill, even when their cwd is gone."""

    def test_a_live_agent_session_is_protected(self):
        # PID 1880321 in the incident: a real Claude session whose worktree had
        # been removed underneath it. Killing it drops the user's conversation.
        self.assertTrue(reap.is_protected(
            'claude --resume ab91bf39-80d8-422d-8816-8647250501ae --permission-mode auto --remote-control'))

    def test_the_remote_control_relay_is_protected(self):
        self.assertTrue(reap.is_protected('claude remote-control --name "Verti Monorepo" --spawn worktree'))

    def test_a_codex_session_is_protected(self):
        self.assertTrue(reap.is_protected('codex --resume 1234'))

    def test_the_units_own_scaffolding_is_protected(self):
        self.assertTrue(reap.is_protected('tmux -L agent-rc-claude-ilterugur-verti-monorepo new-session -d'))
        self.assertTrue(reap.is_protected('bash /usr/local/bin/agent-rc-run'))
        self.assertTrue(reap.is_protected('bash /usr/local/bin/agent-rc-monitor claude-ilterugur-verti-monorepo'))

    def test_the_reaper_never_targets_itself(self):
        self.assertTrue(reap.is_protected('/usr/bin/python3 /usr/local/bin/agent-rc-reap'))

    def test_build_and_test_processes_are_not_protected(self):
        # The actual leak from the incident.
        self.assertFalse(reap.is_protected('/home/ilterugur/.local/share/mise/installs/bun/latest/bin/bun test apps/api'))
        self.assertFalse(reap.is_protected('/home/ilterugur/projects/x/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.25.5 --ping'))
        self.assertFalse(reap.is_protected('/home/ilterugur/.local/share/mise/installs/node/22/bin/node vite'))

    def test_a_path_containing_claude_is_not_an_agent_session(self):
        # The binary is what matters, not the string appearing somewhere in argv.
        self.assertFalse(reap.is_protected('/home/ilterugur/.claude/plugins/venv/bin/python mcp_server.py'))

    def test_merely_mentioning_an_agent_rc_path_grants_no_immunity(self):
        # Immunity has to come from BEING scaffolding, not from naming it. A shell
        # whose script happens to contain the string would otherwise be unkillable
        # — and a stale `bash -c` holding a deleted worktree is exactly the leak.
        self.assertFalse(reap.is_protected(
            'bash -c cd /tmp/wt && python3 /usr/local/bin/agent-rc-reap --dry-run'))
        self.assertFalse(reap.is_protected('bun test --reporter /usr/local/bin/agent-rc-run'))


class SelectOrphans(unittest.TestCase):
    def test_it_picks_the_stale_build_and_leaves_everything_else(self):
        procs = [
            proc(3038329, WT + "/apps/api (deleted)", "bun test apps/api"),
            proc(1880321, WT + " (deleted)", "claude --resume ab91 --remote-control"),
            proc(1873430, "/home/ilterugur/projects/verti-monorepo", 'claude remote-control --name "Verti"'),
            proc(2327671, WT2 + "/apps/api", "node tsc -p tsconfig.json"),
            proc(9001, "/tmp/scratch (deleted)", "node something"),
        ]
        self.assertEqual([p.pid for p in reap.select_orphans(procs)], [3038329])


class GracePeriod(unittest.TestCase):
    """A process must survive more than one pass as an orphan before it is killed.

    There is no way to ask the kernel how long a cwd has been deleted, so the
    reaper earns that fact by observing: a worktree torn down while its process
    is still shutting down must not be raced.
    """

    def setUp(self):
        self.orphan = proc(3038329, WT + "/apps/api (deleted)", "bun test", start_ts=500.0)

    def test_a_freshly_seen_orphan_is_recorded_but_not_killed(self):
        state, due = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        self.assertEqual(due, [])
        self.assertEqual(list(state), ["3038329:500.0"])

    def test_it_is_killed_once_it_has_been_an_orphan_for_the_grace_period(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        state, due = reap.reconcile(state, [self.orphan], now=1000.0 + 900, grace_sec=900)
        self.assertEqual([p.pid for p in due], [3038329])

    def test_it_is_spared_while_still_inside_the_grace_period(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        _, due = reap.reconcile(state, [self.orphan], now=1000.0 + 899, grace_sec=900)
        self.assertEqual(due, [])

    def test_a_recycled_pid_starts_its_own_clock(self):
        # Same pid, different process. Without the start-time in the key the new
        # process would inherit the old one's elapsed grace and die immediately.
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        recycled = proc(3038329, WT + "/apps/api (deleted)", "bun test", start_ts=1500.0)
        state, due = reap.reconcile(state, [recycled], now=1000.0 + 900, grace_sec=900)
        self.assertEqual(due, [])

    def test_state_for_processes_that_are_gone_is_forgotten(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        state, due = reap.reconcile(state, [], now=1000.0 + 900, grace_sec=900)
        self.assertEqual(state, {})
        self.assertEqual(due, [])

    def test_a_worktree_restored_before_the_grace_expires_clears_the_record(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        state, due = reap.reconcile(state, [], now=1200.0, grace_sec=900)
        state, due = reap.reconcile(state, [self.orphan], now=1400.0, grace_sec=900)
        self.assertEqual(due, [])


class Procfs(unittest.TestCase):
    """Reading /proc, exercised against a synthetic tree."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))

    def write_proc(self, pid, cwd_target, cmdline, starttime_ticks=5000, rss_pages=256):
        d = pathlib.Path(self.root) / str(pid)
        d.mkdir(parents=True)
        os.symlink(cwd_target, d / "cwd")
        (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in cmdline) + b"\0")
        # field 2 is comm in parens and may itself contain spaces and parens;
        # everything is positional after the final ')'.
        (d / "stat").write_text(
            "%d (a name (odd)) S " % pid + " ".join(["0"] * 18) + " %d " % starttime_ticks
            + " ".join(["0"] * 30) + "\n")
        (d / "statm").write_text("1000 %d 0 0 0 0 0\n" % rss_pages)
        return d

    def test_it_reads_a_live_process(self):
        target = pathlib.Path(self.root) / "live-dir"
        target.mkdir()
        self.write_proc(4242, str(target), ["bun", "test", "apps/api"])
        (p,) = reap.read_procs([4242], procfs=self.root, boot_ts=100.0)
        self.assertEqual(p.pid, 4242)
        self.assertEqual(p.cwd, str(target))
        self.assertEqual(p.cmdline, "bun test apps/api")

    def test_a_deleted_cwd_is_read_verbatim_not_resolved(self):
        # Linux appends " (deleted)" to the /proc/PID/cwd link target itself. The
        # suffix IS the signal, so it has to survive the read — which it only does
        # if we readlink rather than resolve. (A real deletion cannot be staged
        # here: the marker comes from the kernel, not the filesystem.)
        self.write_proc(4243, WT + "/apps/api (deleted)", ["bun", "test"])
        (p,) = reap.read_procs([4243], procfs=self.root, boot_ts=100.0)
        self.assertEqual(p.cwd, WT + "/apps/api (deleted)")
        self.assertTrue(reap.is_orphan_cwd(p.cwd))

    def test_start_time_is_boot_relative_and_survives_a_parenthesised_comm(self):
        target = pathlib.Path(self.root) / "d2"
        target.mkdir()
        self.write_proc(4244, str(target), ["node"], starttime_ticks=200 * os.sysconf("SC_CLK_TCK"))
        (p,) = reap.read_procs([4244], procfs=self.root, boot_ts=100.0)
        self.assertAlmostEqual(p.start_ts, 300.0, places=3)

    def test_a_process_that_exits_mid_scan_is_skipped_not_fatal(self):
        self.assertEqual(reap.read_procs([999999], procfs=self.root, boot_ts=100.0), [])


class CgroupScope(unittest.TestCase):
    """The reaper only ever looks inside Remote Control unit cgroups."""

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))

    def unit(self, name, pids):
        d = self.root / "user.slice" / "user-1004.slice" / name
        d.mkdir(parents=True)
        (d / "cgroup.procs").write_text("".join("%d\n" % p for p in pids))
        return d

    def test_it_finds_remote_control_units(self):
        self.unit("agent-rc-claude-ilterugur-verti-monorepo.service", [10, 11])
        self.unit("agent-rc-claude-ilterugur-insurchat.service", [20])
        found = reap.find_rc_cgroups(str(self.root))
        self.assertEqual(
            {u: sorted(p) for u, p in found.items()},
            {"agent-rc-claude-ilterugur-verti-monorepo.service": [10, 11],
             "agent-rc-claude-ilterugur-insurchat.service": [20]})

    def test_pids_in_a_delegated_child_cgroup_still_count(self):
        # Nothing creates children under an RC unit today, but a delegated subtree
        # would put every process one level down. Reading only the unit's own
        # cgroup.procs would turn the reaper into a silent no-op exactly then.
        d = self.unit("agent-rc-claude-ilterugur-verti-monorepo.service", [10])
        (d / "session-a").mkdir()
        (d / "session-a" / "cgroup.procs").write_text("11\n12\n")
        found = reap.find_rc_cgroups(str(self.root))
        self.assertEqual(sorted(found["agent-rc-claude-ilterugur-verti-monorepo.service"]), [10, 11, 12])

    def test_it_ignores_everything_that_is_not_a_remote_control_unit(self):
        self.unit("session-122306.scope", [30])
        self.unit("user@1004.service", [31])
        self.unit("agent-rc-resume-claude-ilterugur-verti-monorepo.service", [32])
        self.assertEqual(reap.find_rc_cgroups(str(self.root)), {})


class Reaping(unittest.TestCase):
    def setUp(self):
        self.killed = []
        self.orphan = proc(3038329, WT + "/apps/api (deleted)", "bun test", start_ts=500.0)

    def kill(self, pid, sig):
        self.killed.append((pid, sig))

    def test_dry_run_reports_without_killing(self):
        killed = reap.reap([self.orphan], dry_run=True, killer=self.kill)
        self.assertEqual(self.killed, [])
        self.assertEqual([p.pid for p in killed], [3038329])

    def test_it_terminates_then_probes_then_kills(self):
        import signal
        reap.reap([self.orphan], dry_run=False, killer=self.kill, grace_term_sec=0)
        # signal 0 is the liveness probe between the two real signals: SIGKILL is
        # only spent on something that ignored SIGTERM.
        self.assertEqual(self.killed,
                         [(3038329, signal.SIGTERM), (3038329, 0), (3038329, signal.SIGKILL)])

    def test_a_process_that_exits_on_sigterm_is_not_signalled_again(self):
        import signal

        def kill(pid, sig):
            self.killed.append((pid, sig))
            if sig == 0:
                raise ProcessLookupError()

        reap.reap([self.orphan], dry_run=False, killer=kill, grace_term_sec=0)
        self.assertEqual(self.killed, [(3038329, signal.SIGTERM), (3038329, 0)])


if __name__ == "__main__":
    unittest.main()
