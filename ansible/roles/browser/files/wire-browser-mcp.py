#!/usr/bin/env python3
"""Reconcile the browser MCP entries in one developer's ~/.claude.json.

Managed by Ansible (remote-devbox) — do not edit by hand.

Only the browser entries are touched. Everything else in the file belongs to the
agent and to the developer, so it is read and written back untouched: this is a
shared file, not one this role owns.

chrome-devtools is retired rather than configured. It drove the same browser as
playwright through the same CDP endpoint, duplicated its process set once per
session, and has no HTTP transport to share, so it cost roughly 2.5 GiB on this box
to duplicate a capability already present. It can return once upstream ships a
transport that lets one server serve every session.
"""

import argparse
import json
import os
import stat
import sys
import tempfile

PLAYWRIGHT_PACKAGE = "@playwright/mcp@latest"


def playwright_entry(playwright_url, cdp_endpoint):
    """The playwright entry for the mode the box is running in.

    A URL means a shared server is listening and every session connects to it.
    A CDP endpoint means each session spawns its own client against a shared
    browser. Neither means each session spawns its own client AND its own browser.
    """
    if playwright_url:
        return {"type": "http", "url": playwright_url}
    if cdp_endpoint:
        return {"command": "npx", "args": ["-y", PLAYWRIGHT_PACKAGE, "--cdp-endpoint", cdp_endpoint]}
    return {
        "command": "npx",
        "args": ["-y", PLAYWRIGHT_PACKAGE, "--browser", "chrome", "--headless", "--no-sandbox"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="path to the agent's JSON config")
    parser.add_argument("--playwright-url", default="", help="shared HTTP endpoint to attach to")
    parser.add_argument("--cdp-endpoint", default="", help="shared CDP endpoint to attach to")
    args = parser.parse_args()

    path = os.path.expanduser(args.config)
    original_mode = None
    if os.path.exists(path):
        original_mode = os.stat(path).st_mode
        with open(path) as handle:
            raw = handle.read()
        if raw.strip():
            try:
                config = json.loads(raw)
            except json.JSONDecodeError as exc:
                # Content that fails to parse might still be worth something to
                # someone; only a genuinely empty file is safe to treat as absent.
                sys.exit(f"{path}: exists but is not valid JSON, refusing to overwrite ({exc})")
            # `null`, a list and a bare number all parse. None of them is an agent
            # config, and all of them belong to someone, so they are refused the same
            # way unparseable content is rather than silently replaced.
            if not isinstance(config, dict):
                sys.exit(f"{path}: exists but is not a JSON object, refusing to overwrite")
        else:
            config = {}
    else:
        config = {}

    servers = config.setdefault("mcpServers", {})
    servers.pop("chrome-devtools", None)
    servers["playwright"] = playwright_entry(args.playwright_url, args.cdp_endpoint)

    # Write to a temp file in the same directory and rename it into place, so a
    # process death mid-write (Ansible timeout, OOM kill, full disk, reboot)
    # leaves either the old config or the new one — never a truncated file. This
    # config is shared with the agent and the developer; it is not ours to lose.
    directory = os.path.dirname(path) or "."
    handle = tempfile.NamedTemporaryFile("w", dir=directory, delete=False)
    temp_path = handle.name
    try:
        with handle:
            json.dump(config, handle, indent=2)
            handle.write("\n")
        # S_IMODE, not the raw st_mode: the rest of st_mode is the file type, which
        # chmod would reject or misread.
        if original_mode is not None:
            os.chmod(temp_path, stat.S_IMODE(original_mode))
        os.replace(temp_path, path)
    except BaseException:
        # delete=False means nothing else takes this file back. A full disk mid-dump,
        # a chmod that is refused, an interrupt — each would otherwise leave a stray
        # tmpXXXXXX next to the config in someone's home, forever.
        os.unlink(temp_path)
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
