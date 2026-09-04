"""Unit tests for the stranded-browser reaper.

Run: python3 -m unittest discover -s scripts -p 'test_*.py' -t scripts

Every case here is drawn from the 2026-09-04 incident on the shared box: 15 Chrome
instances left behind by finished agent sessions, 163 processes, 20.5 GB RSS, and a
box at load 84 with `memory.pressure` reporting `full avg10=51.7%`. The command
lines, cgroups, profile paths and socket tables below are the real ones.

The two rules that keep the reaper from making things worse are the ones to read
first: a browser with a client on its CDP port is never a victim no matter how idle
it looks, and no browser is killed on the pass that first notices it.
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


reap = _load("orphan_browser_reap", "orphan-browser-reap.py")

# The two throwaway profiles seen on the box, verbatim.
SCRATCH = "/var/tmp/devbox-scratch/ilterugur/puppeteer_dev_chrome_profile-P5LCT4"
OMP_PROFILE = "/home/ilterugur/.omp/run/daemons/fd140d5eb1f1a9cf/omp.browser.headless.profile"

# pid 2733901: stranded, 4.9% CPU, LISTEN on 41419 and no peer.
LEAKED = ("/opt/google/chrome/chrome --allow-pre-commit-input --disable-background-networking"
          " --disable-backgrounding-occluded-windows --enable-automation --remote-debugging-port=0"
          " --user-data-dir=" + SCRATCH + " about:blank")
# pid 2780437: live session, LISTEN on 36515 with two established peers.
DRIVEN = ("/opt/google/chrome/chrome --headless=new --user-data-dir=" + OMP_PROFILE
          + " --remote-debugging-port=0 --enable-automation")

APP_SCOPE = "/user.slice/user-1004.slice/user@1004.service/app.slice/app-com.google.Chrome-2733901.scope"
FALLBACK_SVC = "/system.slice/devbox-fallback-chrome.service"


def browser(pid=2733901, cmdline=LEAKED, cgroup=APP_SCOPE, profile=None, spawner_alive=False,
            listen_ports=(41419,), peer_ports=(), sockets_readable=True,
            start_ts=500.0, rss_kb=1_200_000):
    return reap.Browser(pid=pid, cmdline=cmdline, cgroup=cgroup,
                        profile=reap.profile_dir(cmdline) if profile is None else profile,
                        spawner_alive=spawner_alive, listen_ports=listen_ports,
                        peer_ports=peer_ports, sockets_readable=sockets_readable,
                        start_ts=start_ts, rss_kb=rss_kb)


class BrowserProcess(unittest.TestCase):
    """Only the browser process itself is ever a candidate."""

    def test_the_browser_process_is_recognised(self):
        self.assertTrue(reap.is_browser_process(LEAKED))
        self.assertTrue(reap.is_browser_process(DRIVEN))

    def test_a_renderer_is_not_a_browser(self):
        # 140 of the incident's 163 Chrome processes were these. They exit with
        # their browser; killing one on its own leaves a live browser with a
        # crashed tab, which is a worse outcome than the leak.
        self.assertFalse(reap.is_browser_process(
            "/opt/google/chrome/chrome --type=renderer --crashpad-handler-pid=1492129"
            " --enable-crash-reporter=, --user-data-dir=" + SCRATCH))

    def test_the_gpu_and_zygote_helpers_are_not_browsers(self):
        self.assertFalse(reap.is_browser_process("/opt/google/chrome/chrome --type=gpu-process"))
        self.assertFalse(reap.is_browser_process("/opt/google/chrome/chrome --type=zygote"))
        self.assertFalse(reap.is_browser_process("/opt/google/chrome/chrome --type utility"))

    def test_the_crashpad_handler_is_not_a_browser(self):
        self.assertFalse(reap.is_browser_process(
            "/opt/google/chrome/chrome_crashpad_handler --monitor-self --database=/tmp/x"))

    def test_chromium_counts_too(self):
        self.assertTrue(reap.is_browser_process("/usr/bin/chromium --user-data-dir=/tmp/x"))

    def test_something_that_merely_mentions_chrome_is_not_a_browser(self):
        self.assertFalse(reap.is_browser_process("npm exec chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222"))
        self.assertFalse(reap.is_browser_process(""))


class ProfileFlag(unittest.TestCase):
    def test_it_reads_the_joined_form(self):
        self.assertEqual(reap.profile_dir(LEAKED), SCRATCH)

    def test_it_reads_the_separated_form(self):
        self.assertEqual(reap.profile_dir("/usr/bin/chromium --user-data-dir /tmp/p --headless"), "/tmp/p")

    def test_a_browser_with_no_profile_flag_has_no_profile(self):
        self.assertIsNone(reap.profile_dir("/usr/bin/google-chrome https://example.com"))
        self.assertIsNone(reap.profile_dir("/usr/bin/google-chrome --user-data-dir="))

    def test_a_quoted_path_survives_the_split(self):
        self.assertEqual(reap.profile_dir("/usr/bin/chromium '--user-data-dir=/tmp/a b/prof'"), "/tmp/a b/prof")


class ThrowawayProfile(unittest.TestCase):
    """The profile is what separates automation from a person's own browser."""

    def test_the_scratch_puppeteer_profiles_from_the_incident_match(self):
        self.assertTrue(reap.is_throwaway_profile(SCRATCH))
        self.assertTrue(reap.is_throwaway_profile(
            "/var/tmp/devbox-scratch/tacarataberk/puppeteer_dev_chrome_profile-9XQ1aa"))

    def test_the_harness_browser_daemon_profile_matches(self):
        self.assertTrue(reap.is_throwaway_profile(OMP_PROFILE))
        self.assertTrue(reap.is_throwaway_profile(
            "/home/ilterugur/.omp/run/daemons/b6672c5203493828/omp.browser.profile"))

    def test_puppeteers_default_tmp_profile_matches(self):
        self.assertTrue(reap.is_throwaway_profile("/tmp/puppeteer_dev_chrome_profile-abc123"))

    def test_a_real_profile_is_never_throwaway(self):
        # The distinction the whole reaper rests on. A person's Chrome, and the
        # managed fallback browser's stable profile, both look like this.
        self.assertFalse(reap.is_throwaway_profile("/home/ilterugur/.config/google-chrome"))
        self.assertFalse(reap.is_throwaway_profile("/home/ilterugur/.local/share/devbox-chrome"))
        self.assertFalse(reap.is_throwaway_profile(None))
        self.assertFalse(reap.is_throwaway_profile(""))

    def test_a_lookalike_path_outside_the_scratch_root_does_not_match(self):
        self.assertFalse(reap.is_throwaway_profile(
            "/home/ilterugur/my-devbox-scratch/ilterugur/puppeteer_dev_chrome_profile-X"))
        self.assertFalse(reap.is_throwaway_profile("/var/tmp/devbox-scratch/ilterugur/chrome-profile"))

    def test_traversal_out_of_the_scratch_root_does_not_match(self):
        # A profile argument is attacker-adjacent: it is a path the session chose.
        # Normalising before matching is what stops a scratch-rooted string from
        # naming a real profile.
        self.assertFalse(reap.is_throwaway_profile(
            "/var/tmp/devbox-scratch/ilterugur/puppeteer_dev_chrome_profile-X/../../../../home/ilterugur/.config/google-chrome"))

    def test_the_glob_set_is_replaceable(self):
        self.assertFalse(reap.is_throwaway_profile(SCRATCH, globs=("/srv/only/*",)))
        self.assertTrue(reap.is_throwaway_profile("/srv/only/prof", globs=("/srv/only/*",)))


class ServiceCgroup(unittest.TestCase):
    """A browser that systemd runs is a managed endpoint and idles on purpose."""

    def test_the_managed_fallback_chrome_is_a_service(self):
        self.assertTrue(reap.is_service_cgroup(FALLBACK_SVC))

    def test_a_per_developer_playwright_mcp_browser_is_a_service(self):
        self.assertTrue(reap.is_service_cgroup("/system.slice/devbox-playwright-mcp-ilterugur.service"))

    def test_a_browser_spawned_by_a_session_is_not_in_a_service_cgroup(self):
        self.assertFalse(reap.is_service_cgroup(APP_SCOPE))
        self.assertFalse(reap.is_service_cgroup("/user.slice/user-1004.slice/session-122306.scope"))
        self.assertFalse(reap.is_service_cgroup(""))


class AttachedClient(unittest.TestCase):
    """The decisive rule: is anyone on the other end of the debugging port."""

    def test_a_browser_with_an_established_peer_is_in_use(self):
        # pid 2780437: LISTEN 0100007F:8EA3 plus two peers on the same port.
        self.assertTrue(reap.has_attached_client(browser(listen_ports=(36515,), peer_ports=(36515,))))

    def test_a_browser_with_only_a_listener_is_abandoned(self):
        # pid 2733901: LISTEN 0100007F:A1CB, nothing else. It was still burning
        # 4.9% CPU on an animating page, which is why CPU is not the signal.
        self.assertFalse(reap.has_attached_client(browser(listen_ports=(41419,), peer_ports=())))

    def test_a_connection_on_a_different_port_is_somebody_elses(self):
        # An outbound connection the browser itself made — telemetry, the page's
        # own traffic — is not a client attached to its debugging port.
        self.assertFalse(reap.has_attached_client(browser(listen_ports=(41419,), peer_ports=(36515,))))

    def test_a_browser_with_no_listener_publishes_nothing_to_be_attached_to(self):
        self.assertFalse(reap.has_attached_client(browser(listen_ports=(), peer_ports=())))


class Orphan(unittest.TestCase):
    def test_the_incidents_stranded_browser_is_an_orphan(self):
        self.assertTrue(reap.is_orphan(browser()))

    def test_a_driven_browser_is_never_an_orphan(self):
        self.assertFalse(reap.is_orphan(browser(cmdline=DRIVEN, listen_ports=(36515,), peer_ports=(36515,))))

    def test_a_browser_whose_spawner_is_alive_is_never_an_orphan(self):
        self.assertFalse(reap.is_orphan(browser(spawner_alive=True)))

    def test_a_managed_service_browser_is_never_an_orphan(self):
        self.assertFalse(reap.is_orphan(browser(cgroup=FALLBACK_SVC)))

    def test_a_real_profile_is_never_an_orphan(self):
        self.assertFalse(reap.is_orphan(browser(profile="/home/ilterugur/.config/google-chrome")))

    def test_a_browser_whose_fd_table_could_not_be_read_is_never_an_orphan(self):
        # The bug this rule closes, caught on the box: run under a unit without
        # CAP_SYS_PTRACE and every browser reads as socket-less, so "no client
        # attached" became vacuously true and a browser someone was driving over
        # CDP was a candidate. No evidence is not evidence of absence.
        self.assertFalse(reap.is_orphan(browser(sockets_readable=False, listen_ports=(), peer_ports=())))
        self.assertFalse(reap.is_orphan(browser(sockets_readable=False, listen_ports=(41419,))))

    def test_a_browser_that_publishes_no_cdp_port_is_left_alone(self):
        # Read the fd table, found no listener: this browser is not something an
        # agent session drives over CDP, whatever its profile looks like. Killing
        # it would be acting on a guess about what it is.
        self.assertFalse(reap.is_orphan(browser(listen_ports=(), peer_ports=())))

    def test_select_picks_the_stranded_ones_and_leaves_the_rest(self):
        browsers = [
            browser(pid=2733901),
            browser(pid=2780437, cmdline=DRIVEN, listen_ports=(36515,), peer_ports=(36515,), spawner_alive=True),
            browser(pid=2330385, cgroup=FALLBACK_SVC, profile="/home/ilterugur/.local/share/devbox-chrome"),
            browser(pid=4165043, start_ts=700.0),
            browser(pid=9001, profile="/home/someone/.config/google-chrome"),
        ]
        self.assertEqual([b.pid for b in reap.select_orphans(browsers)], [2733901, 4165043])


class GracePeriod(unittest.TestCase):
    """No browser is killed on the pass that first notices it.

    A client that drops and reconnects — a resumed session, a restarted harness —
    has no CDP peer for as long as that takes. The reaper cannot ask how long the
    port has been unattended, so it earns the fact by observing across passes.
    """

    def setUp(self):
        self.orphan = browser(start_ts=500.0)

    def test_a_freshly_seen_orphan_is_recorded_but_not_killed(self):
        state, due = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        self.assertEqual(due, [])
        self.assertEqual(list(state), ["2733901:500.0"])

    def test_it_is_killed_once_it_has_been_an_orphan_for_the_grace_period(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        _, due = reap.reconcile(state, [self.orphan], now=1900.0, grace_sec=900)
        self.assertEqual([b.pid for b in due], [2733901])

    def test_it_is_spared_while_still_inside_the_grace_period(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        _, due = reap.reconcile(state, [self.orphan], now=1899.0, grace_sec=900)
        self.assertEqual(due, [])

    def test_a_reattached_browser_loses_its_record(self):
        # The client came back between two sweeps. Its earlier sighting must not
        # count toward a kill, or a long-lived session that idles overnight dies.
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        state, _ = reap.reconcile(state, [], now=1400.0, grace_sec=900)
        state, due = reap.reconcile(state, [self.orphan], now=1800.0, grace_sec=900)
        self.assertEqual(due, [])
        self.assertEqual(list(state), ["2733901:500.0"])

    def test_a_recycled_pid_starts_its_own_clock(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        _, due = reap.reconcile(state, [browser(start_ts=1500.0)], now=1900.0, grace_sec=900)
        self.assertEqual(due, [])

    def test_state_for_browsers_that_are_gone_is_forgotten(self):
        state, _ = reap.reconcile({}, [self.orphan], now=1000.0, grace_sec=900)
        state, due = reap.reconcile(state, [], now=1900.0, grace_sec=900)
        self.assertEqual(state, {})
        self.assertEqual(due, [])


# Real rows from the box, with the columns the parser reads in their real positions.
TCP_TABLE = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:A1CB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1004        0 51120001 1 0000 100 0 0 10 0
   1: 0100007F:8EA3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1004        0 51120002 1 0000 100 0 0 10 0
   2: 0100007F:8EA3 0100007F:D750 01 00000000:00000000 00:00000000 00000000  1004        0 51120003 1 0000 20 0 0 10 -1
   3: 0100007F:8EA3 0100007F:D752 01 00000000:00000000 00:00000000 00000000  1004        0 51120004 1 0000 20 0 0 10 -1
"""


class TcpTable(unittest.TestCase):
    def test_it_decodes_the_kernels_hex_ports_and_states(self):
        rows = list(reap.parse_tcp_table(TCP_TABLE))
        self.assertEqual(rows[0], (51120001, 0xA1CB, 0, "0A"))
        self.assertEqual(rows[2], (51120003, 0x8EA3, 0xD750, "01"))

    def test_the_header_and_short_rows_are_skipped_not_fatal(self):
        self.assertEqual(list(reap.parse_tcp_table("sl local\n  0: junk\n")), [])


class Procfs(unittest.TestCase):
    """Reading /proc, exercised against a synthetic tree."""

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        (self.root / "net").mkdir()
        (self.root / "net" / "tcp").write_text(TCP_TABLE)

    def write_proc(self, pid, cmdline, comm="chrome", ppid=1987, cgroup=APP_SCOPE,
                   socket_inodes=(), starttime_ticks=5000, rss_pages=256):
        d = self.root / str(pid)
        d.mkdir(parents=True)
        (d / "comm").write_text(comm + "\n")
        (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in cmdline) + b"\0")
        (d / "cgroup").write_text("0::" + cgroup + "\n")
        # field 2 is comm in parens and may itself contain spaces and parens;
        # everything is positional after the final ')'.
        (d / "stat").write_text(
            "%d (a name (odd)) S %d " % (pid, ppid) + " ".join(["0"] * 17)
            + " %d " % starttime_ticks + " ".join(["0"] * 30) + "\n")
        (d / "statm").write_text("1000 %d 0 0 0 0 0\n" % rss_pages)
        fd = d / "fd"
        fd.mkdir()
        for i, inode in enumerate(socket_inodes):
            os.symlink("socket:[%d]" % inode, fd / str(3 + i))
        return d

    def user_manager(self, pid=1987):
        self.write_proc(pid, ["/usr/lib/systemd/systemd", "--user", "--deserialize=14"], comm="systemd")

    def test_only_the_browser_is_returned_from_a_full_chrome_tree(self):
        self.user_manager()
        self.write_proc(2733901, reap._argv(LEAKED), socket_inodes=(51120001,))
        self.write_proc(2733902, ["/opt/google/chrome/chrome", "--type=renderer",
                                  "--user-data-dir=" + SCRATCH], ppid=2733901)
        self.write_proc(2733914, ["/opt/google/chrome/chrome_crashpad_handler", "--monitor-self"],
                        comm="chrome_crashpad", ppid=2733901)
        found = reap.read_browsers(procfs=str(self.root), boot_ts=100.0)
        self.assertEqual([b.pid for b in found], [2733901])

    def test_it_reads_the_facts_the_rules_are_decided_on(self):
        self.user_manager()
        self.write_proc(2733901, reap._argv(LEAKED), socket_inodes=(51120001,),
                        starttime_ticks=200 * os.sysconf("SC_CLK_TCK"), rss_pages=300_000)
        (b,) = reap.read_browsers(procfs=str(self.root), boot_ts=100.0)
        self.assertEqual(b.profile, SCRATCH)
        self.assertEqual(b.cgroup, APP_SCOPE)
        self.assertEqual(b.listen_ports, frozenset({0xA1CB}))
        self.assertEqual(b.peer_ports, frozenset())
        self.assertFalse(b.spawner_alive)
        self.assertAlmostEqual(b.start_ts, 300.0, places=3)
        self.assertEqual(b.rss_kb, 300_000 * (os.sysconf("SC_PAGE_SIZE") // 1024))
        self.assertTrue(reap.is_orphan(b))

    def test_a_browser_reparented_onto_the_user_manager_has_no_spawner(self):
        # Every detached browser on the box looks like this — including the live
        # ones — which is why reparenting alone can never be the kill signal.
        self.user_manager()
        self.write_proc(2733901, reap._argv(LEAKED), ppid=1987, socket_inodes=(51120001,))
        (b,) = reap.read_browsers(procfs=str(self.root), boot_ts=100.0)
        self.assertFalse(b.spawner_alive)

    def test_a_browser_with_a_live_spawner_is_reported_as_owned(self):
        self.write_proc(2615592, ["/home/ilterugur/.local/share/mise/installs/bun/1.4.0/bin/bun",
                                  "run", "src/index.ts"], comm="bun")
        self.write_proc(2780437, reap._argv(DRIVEN), ppid=2615592, socket_inodes=(51120002,))
        (b,) = reap.read_browsers(procfs=str(self.root), boot_ts=100.0)
        self.assertTrue(b.spawner_alive)
        self.assertFalse(reap.is_orphan(b))

    def test_a_peers_socket_belonging_to_another_browser_is_not_borrowed(self):
        # /proc/net/tcp is the whole namespace. Ownership has to come from the fd
        # table, or one live browser's connection would shield every other browser
        # listening on a port it does not own.
        self.user_manager()
        self.write_proc(2733901, reap._argv(LEAKED), socket_inodes=(51120001,))
        self.write_proc(2780437, reap._argv(DRIVEN), socket_inodes=(51120002, 51120003, 51120004))
        found = {b.pid: b for b in reap.read_browsers(procfs=str(self.root), boot_ts=100.0)}
        self.assertEqual(found[2733901].peer_ports, frozenset())
        self.assertEqual(found[2780437].peer_ports, frozenset({0x8EA3}))
        self.assertEqual([b.pid for b in reap.select_orphans(found.values())], [2733901])

    def test_a_process_that_exits_mid_scan_is_skipped_not_fatal(self):
        d = self.write_proc(2733901, reap._argv(LEAKED), socket_inodes=(51120001,))
        shutil.rmtree(d)
        self.assertEqual(reap.read_browsers(procfs=str(self.root), boot_ts=100.0), [])

    def test_a_browser_the_reaper_cannot_read_sockets_for_is_left_alone(self):
        # An unreadable fd table is what a missing CAP_SYS_PTRACE looks like from
        # inside the sweep, and it is reported as unreadable rather than as empty
        # so the "nothing is attached" rule cannot come out true by default.
        self.user_manager()
        d = self.write_proc(2733901, reap._argv(LEAKED))
        shutil.rmtree(d / "fd")
        (b,) = reap.read_browsers(procfs=str(self.root), boot_ts=100.0)
        self.assertFalse(b.sockets_readable)
        self.assertEqual(b.listen_ports, frozenset())
        self.assertFalse(reap.is_orphan(b))
        self.assertEqual(reap.select_orphans([b]), [])

    def test_an_empty_fd_table_is_read_as_empty_not_as_unreadable(self):
        self.user_manager()
        self.write_proc(2733901, reap._argv(LEAKED), socket_inodes=())
        (b,) = reap.read_browsers(procfs=str(self.root), boot_ts=100.0)
        self.assertTrue(b.sockets_readable)
        self.assertFalse(reap.is_orphan(b))

    def test_socket_inodes_distinguishes_unreadable_from_empty(self):
        self.write_proc(4242, reap._argv(LEAKED), socket_inodes=(51120001,))
        self.assertEqual(reap.socket_inodes(4242, procfs=str(self.root)), {51120001})
        self.assertIsNone(reap.socket_inodes(999999, procfs=str(self.root)))


class Reaping(unittest.TestCase):
    def setUp(self):
        self.killed = []
        self.orphan = browser()

    def kill(self, pid, sig):
        self.killed.append((pid, sig))

    def test_dry_run_reports_without_killing(self):
        hit = reap.reap([self.orphan], dry_run=True, killer=self.kill)
        self.assertEqual(self.killed, [])
        self.assertEqual([b.pid for b in hit], [2733901])

    def test_it_terminates_then_probes_then_kills(self):
        reap.reap([self.orphan], dry_run=False, killer=self.kill, grace_term_sec=0)
        # signal 0 is the liveness probe between the two real signals: SIGKILL is
        # only spent on something that ignored SIGTERM.
        self.assertEqual(self.killed,
                         [(2733901, signal.SIGTERM), (2733901, 0), (2733901, signal.SIGKILL)])

    def test_a_browser_that_exits_on_sigterm_is_not_signalled_again(self):
        def kill(pid, sig):
            self.killed.append((pid, sig))
            if sig == 0:
                raise ProcessLookupError()

        reap.reap([self.orphan], dry_run=False, killer=kill, grace_term_sec=0)
        self.assertEqual(self.killed, [(2733901, signal.SIGTERM), (2733901, 0)])

    def test_only_the_browser_is_signalled_not_its_renderers(self):
        reap.reap([self.orphan], dry_run=False, killer=self.kill, grace_term_sec=0)
        self.assertEqual({pid for pid, _ in self.killed}, {2733901})


class ProfilePurge(unittest.TestCase):
    """Deleting a dead browser's profile — by ownership, never by age."""

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.scratch = self.root / "var" / "tmp" / "devbox-scratch"
        self.roots = (str(self.scratch),)

    def profile(self, name="puppeteer_dev_chrome_profile-P5LCT4", user="ilterugur", size=4096):
        d = self.scratch / user / name
        d.mkdir(parents=True)
        (d / "Default").mkdir()
        (d / "Default" / "Cookies").write_bytes(b"x" * size)
        return d

    def globs(self):
        return (str(self.scratch) + "/*/puppeteer_dev_chrome_profile-*",)

    def test_a_dead_browsers_scratch_profile_is_purgeable(self):
        d = self.profile()
        self.assertTrue(reap.purgeable_profile(str(d), self.roots, (), self.globs()))

    def test_a_profile_a_surviving_browser_still_names_is_spared(self):
        # Two browsers cannot share a mkdtemp profile, but a reap racing a restart
        # can produce the same path twice. The survivor wins.
        d = self.profile()
        self.assertFalse(reap.purgeable_profile(str(d), self.roots, (str(d),), self.globs()))

    def test_the_scratch_root_itself_is_never_purgeable(self):
        self.assertFalse(reap.purgeable_profile(str(self.scratch), self.roots, (), self.globs()))
        self.assertFalse(reap.purgeable_profile(str(self.scratch) + "/ilterugur", self.roots, (), self.globs()))

    def test_a_profile_outside_the_purge_roots_is_left_to_its_owner(self):
        # The harness's own browser profiles live under $HOME. They match the
        # throwaway globs, so only the purge root keeps the reaper out of homes —
        # and the unit's ProtectHome=yes keeps it out even if this rule regressed.
        self.assertFalse(reap.purgeable_profile(OMP_PROFILE, self.roots, ()))
        self.assertFalse(reap.purgeable_profile("/tmp/puppeteer_dev_chrome_profile-x", self.roots, ()))

    def test_purging_is_off_when_no_root_is_configured(self):
        d = self.profile()
        self.assertFalse(reap.purgeable_profile(str(d), (), (), self.globs()))

    def test_a_path_that_only_looks_rooted_is_rejected(self):
        sibling = str(self.scratch) + "-other/ilterugur/puppeteer_dev_chrome_profile-X"
        self.assertFalse(reap.purgeable_profile(sibling, self.roots, (), self.globs()))

    def test_it_removes_the_tree_and_reports_what_it_freed(self):
        d = self.profile(size=8192)
        removed, freed = reap.purge_profiles([str(d)])
        self.assertEqual(removed, [str(d)])
        self.assertEqual(freed, 8192)
        self.assertFalse(d.exists())

    def test_a_dry_run_measures_without_deleting(self):
        d = self.profile(size=2048)
        removed, freed = reap.purge_profiles([str(d)], dry_run=True)
        self.assertEqual((removed, freed), ([str(d)], 2048))
        self.assertTrue(d.exists())

    def test_a_symlink_is_never_followed(self):
        real = self.profile(name="real-data")
        link = self.scratch / "ilterugur" / "puppeteer_dev_chrome_profile-LINK"
        link.symlink_to(real)
        removed, _ = reap.purge_profiles([str(link)])
        self.assertEqual(removed, [])
        self.assertTrue(real.exists())

    def test_a_profile_already_gone_is_not_an_error(self):
        self.assertEqual(reap.purge_profiles([str(self.scratch / "nope")]), ([], 0))

    def test_a_removal_that_fails_is_reported_and_skipped(self):
        d = self.profile()

        def boom(_path):
            raise PermissionError(13, "denied")

        removed, freed = reap.purge_profiles([str(d)], remover=boom)
        self.assertEqual((removed, freed), ([], 0))
        self.assertTrue(d.exists())


class StateFile(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.dir, ignore_errors=True))

    def test_a_missing_or_corrupt_state_file_starts_empty_rather_than_crashing(self):
        self.assertEqual(reap.load_state(str(self.dir / "nope.json")), {})
        bad = self.dir / "bad.json"
        bad.write_text("{not json")
        self.assertEqual(reap.load_state(str(bad)), {})

    def test_state_round_trips(self):
        path = str(self.dir / "sub" / "seen.json")
        reap.save_state(path, {"2733901:500.0": 1000.0})
        self.assertEqual(reap.load_state(path), {"2733901:500.0": 1000.0})


if __name__ == "__main__":
    unittest.main()
