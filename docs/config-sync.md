# Syncing your Claude config to the box (multi-account)

This page is about the **Claude** config. For application configs — FileZilla
sites, `~/.ssh/config`, DB clients — see
[file-bridge.md](file-bridge.md#app-configs-connection-records).

Mirror the **portable** parts of your local `~/.claude` (skills, subagents, slash
commands, `CLAUDE.md`, MCP definitions, hook scripts) to the box and into **every
account**, while keeping each account's **credentials and identity separate**.

## The core constraint

`CLAUDE_CONFIG_DIR` relocates the **entire** config root — including the sibling
`~/.claude.json` state file. So per-account isolation isolates your customizations
too. To get "one shared set across all accounts" we deliberately **copy the
portable subset into each account dir**, and never touch the per-account identity.

## What syncs, what doesn't (verified)

| Class | Items | Handling |
| --- | --- | --- |
| **Per-account — NEVER sync** | `.credentials.json` (the login), **`~/.claude.json`** (identity `oauthAccount`/`userID` + per-project **cost/usage** + caches) | Left untouched per account. Sharing `~/.claude.json` **cross-wires accounts and pools usage** — and it's atomically rewritten, so a symlink to it breaks anyway. |
| **Shared — synced** | `CLAUDE.md` (+ its `@`-included files), `skills/`, `agents/`, `commands/`, `output-styles/`, `rules/`, `workflows/`, `themes/`, `keybindings.json`, `hooks/` scripts, `mcp.json`, `statusline-command.sh` | Bundled from your client → `/opt/remote-shared` on the box → **copied** into each profile's `~/.claude`. |
| **Machine/session state — never sync** | `projects/`, `sessions/`, `history.jsonl`, `todos/`, `statsig/`, `telemetry/`, caches, `plugins/` payload, daemon/lock/log files | The bundle ships a **whitelist only**; the push and apply additionally enforce a shared exclude list (`roles/claude_config/files/sync-excludes.txt`). |
| **Special — opt-in** | `settings.json` (holds hooks/permissions/env) | **Not deployed by default** — see caveats. |

> **Why copy, not symlink:** Claude Code's auto-update **wipes symlinked skill
> dirs** (issue #50052) and `/skills` ignores symlinked dirs (#14836). Copying real
> files survives auto-update.

## How it works

```
client ~/.claude  --bundle-->  repo claude-config/shared/  --rsync-->  box /opt/remote-shared/
                                                                            |
                                          remote-config-apply  --copy (excl. credentials/.claude.json)-->
                                                                            |
                       /home/work/.claude    /home/personal/.claude    ...  (each keeps its own login)
```

1. **Bundle** (client): `./scripts/bundle-local-config.sh` curates the portable
   subset into `claude-config/shared/` and flags non-portable content.
2. **Deploy**: `cd ansible && ansible-playbook playbook.yml` pushes it to
   `/opt/remote-shared` and fans it into every profile's `~/.claude`. Both the push
   and the per-profile copy share one exclude list
   (`roles/claude_config/files/sync-excludes.txt`), so identity/state never leak.
3. **Re-sync after changes**: re-run the playbook, or on the box
   `sudo remote-config-apply`.

Config: `sync_claude_config: true`, `claude_config_src`, `claude_sync_settings`
in `group_vars/all.yml`.

## ⚠️ Caveats — read before trusting the sync

Your customizations are **definitions**; the things they invoke must exist on the
box. A naive "sync everything" will break the box. Specifics:

### settings.json + hooks are machine-coupled (off by default)
Real `settings.json` typically carries:
- `env.ANTHROPIC_BASE_URL` pointing at a **local proxy** (e.g. `http://127.0.0.1:<port>`) — deployed to the box this reroutes **every** API call to a port that isn't there.
- **Absolute hook paths** (`/Users/<you>/.claude/hooks/...`, `/opt/homebrew/...`) that don't exist on Linux — a failing hook degrades every tool call.

So `claude_sync_settings: false` by default. To share settings, curate a
box-portable version (`claude-config/settings.shared.example.json`): no absolute
macOS paths, no localhost `ANTHROPIC_BASE_URL`, hook commands resolved via
`$CLAUDE_CONFIG_DIR`/`$PATH`. Then set `claude_sync_settings: true`.

### Hooks/skills/MCPs that call LOCAL binaries
If your hooks/skills/MCP servers shell out to local tools (a custom CLI, a memory
server, a code-search MCP, `uv`/`uvx`, …), those **binaries must be installed on
the box** or the hook/skill/server fails. Install them (Linux builds, on `PATH`)
or drop those entries from the box config.

### MCP servers
- **Runtime**: a server using `npx`/`uvx`/`docker` needs that runtime on the box's
  `PATH` (headless shells often miss it → `spawn npx ENOENT`).
- **Absolute command paths**: e.g. `/opt/homebrew/bin/<tool>` won't exist —
  rewrite to the Linux path or a bare `PATH`-resolved name.
- **Secrets**: keep keys out of `mcp.json`; use `${VAR}` and export them on the
  box. A `${VAR}` with no default makes Claude **fail to parse the whole config** if
  the var is missing.
- **Interactive/OAuth MCPs** (claude.ai connectors; hosted M365/Gmail/Calendar)
  generally **don't work headless**. Prefer HTTP + Bearer-token servers.
- **User-scope MCPs** added via `claude mcp add -s user` live in `~/.claude.json`
  (NOT bundled). Re-add them into `claude-config/shared/mcp.json`, or run
  `claude mcp add` per account on the box.

### Don't sync credentials or `~/.claude.json`
Each profile logs in with `sudo remote-devbox-login` (see
[multi-account.md](multi-account.md)). The sync never copies `.credentials.json`
or `~/.claude.json`.

## References

- [Settings & precedence](https://code.claude.com/docs/en/settings) · [Authentication / `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/authentication) · [MCP](https://code.claude.com/docs/en/mcp) · [Skills](https://code.claude.com/docs/en/skills) · [Hooks](https://code.claude.com/docs/en/hooks)
- No built-in sync (closed, not planned): [claude-code#57678](https://github.com/anthropics/claude-code/issues/57678)
- Symlinked skills wiped by auto-update: [#50052](https://github.com/anthropics/claude-code/issues/50052) · `/skills` ignores symlinks: [#14836](https://github.com/anthropics/claude-code/issues/14836)
- `~/.claude.json` concurrent-write corruption: [#28992](https://github.com/anthropics/claude-code/issues/28992) · user-scope MCP location: [#37165](https://github.com/anthropics/claude-code/issues/37165)
- Curated `~/.claude` `.gitignore` (community): [ZacheryGlass/.claude](https://github.com/ZacheryGlass/.claude/blob/master/.gitignore)
