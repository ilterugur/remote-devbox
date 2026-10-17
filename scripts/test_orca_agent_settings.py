"""Preserve Orca profile state when reconciling managed agent launchers."""
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "orca_agent_settings", pathlib.Path(__file__).with_name("orca-agent-settings.py")
)
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


class ProfileSettings(unittest.TestCase):
    def test_reconfiguration_reaches_the_active_profile_after_orca_migration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            legacy = root / "orca-data.json"
            legacy.write_text('{"settings": {"theme": "light"}}')
            (root / "orca-profile-index.json").write_text(json.dumps({
                "schemaVersion": 1, "activeProfileId": "local-default",
                "profiles": [{"id": "local-default"}],
            }))
            active = root / "profiles/local-default/orca-data.json"
            active.parent.mkdir(parents=True)
            active.write_text(json.dumps({
                "settings": {"theme": "dark", "agentCmdOverrides": {"omp": "old-omp"}},
                "repos": [{"id": "existing-project"}],
            }))
            desired = root / "desired.json"
            desired.write_text(json.dumps({
                "agentCmdOverrides": {"omp": "/home/dev/.local/bin/omp-main"},
                "defaultTuiAgent": "omp",
            }))
            settings.configure(legacy, desired)
            updated = json.loads(active.read_text())
            self.assertEqual(updated["settings"]["agentCmdOverrides"]["omp"],
                             "/home/dev/.local/bin/omp-main")
            self.assertEqual(updated["settings"]["theme"], "dark")
            self.assertEqual(updated["repos"], [{"id": "existing-project"}])
            self.assertEqual(json.loads(legacy.read_text()), {"settings": {"theme": "light"}})


if __name__ == "__main__":
    unittest.main()
