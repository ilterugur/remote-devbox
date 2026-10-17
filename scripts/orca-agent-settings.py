#!/usr/bin/env python3
"""Merge devbox agent launchers before Orca starts, preserving unrelated preferences."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


def configure(data_path: Path, desired_path: Path) -> None:
    desired = json.loads(desired_path.read_text())
    lock = data_path.parent / "SingletonLock"
    if lock.is_symlink():
        owner = os.readlink(lock)
        host, _, pid = owner.rpartition("-")
        if host != os.uname().nodename:
            raise RuntimeError("Orca profile is locked by another host")
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            pass
        else:
            raise RuntimeError("Stop Orca before applying agent settings")
    # Orca migrates the initial file into its selected profile on first startup.
    # Subsequent applies must update that file, not the now-unused legacy seed.
    index_path = data_path.parent / "orca-profile-index.json"
    if index_path.exists():
        index = json.loads(index_path.read_text())
        profile_id = index["activeProfileId"]
        if (not isinstance(profile_id, str) or profile_id in ("", ".", "..")
                or "/" in profile_id or "\\" in profile_id):
            raise RuntimeError("Invalid active Orca profile ID")
        if not any(profile.get("id") == profile_id for profile in index["profiles"]):
            raise RuntimeError("Active Orca profile is missing from its index")
        data_path = data_path.parent / "profiles" / profile_id / "orca-data.json"
    if data_path.is_symlink():
        raise RuntimeError("Refusing to replace a symlinked Orca data file")
    state = json.loads(data_path.read_text()) if data_path.exists() else {}
    settings = state.setdefault("settings", {})
    overrides = settings.setdefault("agentCmdOverrides", {})
    for agent, command in desired["agentCmdOverrides"].items():
        overrides[agent] = command
    settings.setdefault("defaultTuiAgent", desired["defaultTuiAgent"])
    # Keep Orca's first-run migration from silently adding approval-bypass flags.
    settings.setdefault("agentDefaultArgs", {})
    settings["agentYoloDefaultsMigrated"] = True
    content = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
    if data_path.exists() and data_path.read_text() == content:
        return
    data_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if data_path.exists():
        backup = data_path.with_name(data_path.name + ".before-devbox")
        shutil.copyfile(data_path, backup)
        backup.chmod(0o600)
    fd, temporary = tempfile.mkstemp(prefix=".orca-settings-", dir=data_path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, data_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    configure(Path(sys.argv[1]), Path(sys.argv[2]))
