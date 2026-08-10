"""Unit tests for the bridge-identity snapshotter.

Run: python3 -m unittest discover -s scripts -p 'test_*.py' -t scripts
"""
import importlib.util
import pathlib
import unittest


def _load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


snap = _load("agent_rc_bridge_snapshot", "agent-rc-bridge-snapshot.py")


class LiveEntries(unittest.TestCase):
    def test_keeps_only_this_units_sessions(self):
        states = [
            {"sessionId": "393f13d9-46d0-4dba-8f77-e9bc02a630a3",
             "bridgeSessionId": "session_01Qn4NdzWv487VXyn39ufuWn",
             "cwd": "/home/dev/projects/p/.claude/worktrees/bridge-cse_01A",
             "tmux": "agent-rc-claude-dev-p:@5.%5"},
            {"sessionId": "0a1d8a5e-557f-455a-8f53-7654f20e42a7",
             "bridgeSessionId": "session_01Xm4qwiy8U8T29FZWgDNy68",
             "cwd": "/home/dev/projects/other",
             "tmux": "agent-rc-claude-dev-other:@1.%1"},
        ]
        got = snap.live_entries(states, "claude-dev-p")
        self.assertEqual(list(got), ["393f13d9-46d0-4dba-8f77-e9bc02a630a3"])
        self.assertEqual(got["393f13d9-46d0-4dba-8f77-e9bc02a630a3"]["bridge"],
                         "session_01Qn4NdzWv487VXyn39ufuWn")

    def test_skips_a_session_with_no_bridge_id(self):
        states = [{"sessionId": "eb4769a8-1da6-4223-9ebe-21a030d5ec52",
                   "bridgeSessionId": None,
                   "tmux": "agent-rc-claude-dev-p:@1.%1"}]
        self.assertEqual(snap.live_entries(states, "claude-dev-p"), {})

    def test_rejects_a_malformed_bridge_id(self):
        states = [{"sessionId": "eb4769a8-1da6-4223-9ebe-21a030d5ec52",
                   "bridgeSessionId": "../../etc/passwd",
                   "tmux": "agent-rc-claude-dev-p:@1.%1"}]
        self.assertEqual(snap.live_entries(states, "claude-dev-p"), {})

    def test_a_unit_name_is_not_matched_by_prefix_alone(self):
        states = [{"sessionId": "eb4769a8-1da6-4223-9ebe-21a030d5ec52",
                   "bridgeSessionId": "session_01aaaaaaaa",
                   "tmux": "agent-rc-claude-dev-p-extra:@1.%1"}]
        self.assertEqual(snap.live_entries(states, "claude-dev-p"), {})


class Merge(unittest.TestCase):
    def test_keeps_an_entry_whose_session_is_no_longer_running(self):
        existing = {"u1": {"bridge": "session_01aaaaaaaa", "cwd": "/w", "seen": 1000.0}}
        got = snap.merge(existing, {}, 1000.0 + 3600, 14)
        self.assertEqual(got["u1"]["bridge"], "session_01aaaaaaaa")

    def test_drops_an_entry_past_the_ttl(self):
        existing = {"u1": {"bridge": "session_01aaaaaaaa", "cwd": "/w", "seen": 0.0}}
        self.assertEqual(snap.merge(existing, {}, 15 * 86400, 14), {})

    def test_a_live_session_refreshes_seen(self):
        existing = {"u1": {"bridge": "session_01aaaaaaaa", "cwd": "/w", "seen": 0.0}}
        live = {"u1": {"bridge": "session_01aaaaaaaa", "cwd": "/w"}}
        got = snap.merge(existing, live, 15 * 86400, 14)
        self.assertEqual(got["u1"]["seen"], 15 * 86400)

    def test_ignores_corrupt_stored_records(self):
        existing = {"u1": "not-a-dict", "u2": {"bridge": "nope", "seen": 1.0}}
        self.assertEqual(snap.merge(existing, {}, 2.0, 14), {})


if __name__ == "__main__":
    unittest.main()
