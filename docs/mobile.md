# Driving the box from your phone

Goal: client closed, you start and steer Claude Code tasks **on the box** from your
phone — including brand-new sessions.

## Why this works with the client off

The box is the host; your client and phone are only front-ends. Each profile's
`servers` entry runs an always-on `claude remote-control` server (in tmux, kept
alive by systemd, as that profile's user). Remote Control is **outbound HTTPS
only** — no inbound ports — so it reaches your phone through the firewall and
Tailscale untouched.

## One-time setup

1. Provision (`ansible-playbook playbook.yml`).
2. Log in each profile once (see [multi-account.md](multi-account.md)):
   ```bash
   ssh admin@<box>
   sudo remote-devbox-login
   ```

That's it — the servers come online within ~15s of login.

## Daily use from the phone

1. Open the **Claude mobile app** (or `claude.ai/code` in mobile Safari/Chrome).
2. Go to the **Code** tab. Your servers appear by their `name:` with a green dot.
   - Multiple accounts? **Switch account** in the app to see each one's servers.
3. Tap a server → **new session** → it spawns a fresh session **on the box**.
   With `spawn: worktree`, each session gets its own git worktree, so parallel
   tasks never clobber each other's files (up to `capacity`).
4. Type your task. It runs on the box, against your Docker services and real
   project files; output streams back to your phone.

## What does / doesn't work

| You want | Works? | How |
| --- | --- | --- |
| Start a new session from phone, runs on the box | ✅ | A `claude-rc-*` server must be running (it is, always-on) |
| Client fully off | ✅ | Box is the host; nothing depends on the client |
| Steer/continue a running session | ✅ | Same server, same phone UI |
| Spawn the box from zero with no server running | ❌ | At least one `claude-rc-*` server must be alive — that's what the always-on service guarantees |
| `claude.ai/code` web "new session" running on the box | ❌ | The web's own new-session runs on **Anthropic cloud**, not your box. Always connect to **your** server. |
| Dispatch (start tasks from phone) | ❌ here | Dispatch needs the **desktop app** running on a Mac/Windows — useless with the client off |
| A session survives a box OOM / crash / reboot | ✅ | The server self-heals (systemd auto-restart) and a companion auto-resumes interrupted sessions — and any Workflow they were running — from on-disk state. On by default; see the self-heal/resume block in `group_vars/all.example.yml`. |

## Caveats

- Remote Control is a **research preview** (Pro/Max; Team/Enterprise need an admin
  to enable it org-wide).
- A session times out after ~10 min of network loss; the box-side server keeps
  running and you reconnect.
- Approving tool calls from a phone is easy — don't rubber-stamp risky ones.
- Auto-resume reconnects a session under a **new** cloud id (the original transcript
  is loaded into it) and consumes quota as it continues — it does not revive the dead
  cloud session in place. Workflow resume replays completed agents from cache and
  re-runs only the aborted tail.

## Roaming-resilient terminal: mosh + tmux (flaky connections)

Remote Control is the easiest mobile path, but if you'd rather drive the real
`claude` TUI from a terminal on a flaky connection (switching cells/Wi‑Fi),
use **mosh + tmux** instead. mosh survives network drops and IP changes (auto‑reconnects
where plain SSH would die); tmux keeps the session — and the `claude` inside it —
alive on the box so a reconnect lands exactly where you left off.

Installed by default (`mosh_enabled`); the box opens mosh's UDP range **only on the
tailscale0 interface**, so connect over Tailscale:

The easiest entry point is the `devbox` command that `gen-editor-config.py` writes
into your shell rc (one command, profile as an argument):

```bash
# phone: Blink or Termius (both speak mosh) + the Tailscale app, OR client terminal
devbox                 # default profile → persistent tmux (mosh, ssh fallback)
devbox <profile>       # a specific profile; `devbox <profile> <session>` for a named one
#   inside the session:
claude            # drop signal / close the lid → reconnect resumes the same session
```

`devbox` is just `mosh <prefix>-<profile> -- tmux new -A -s <session>`; run
`gen-editor-config.py --host <tailscale-100.x-IP>` (the **100.x IP**, not the MagicDNS
name — mosh often can't resolve MagicDNS) so the alias resolves over Tailscale (mosh
UDP is tailscale-only). From the client you can also run
`scripts/connect.sh mosh <user>` (needs `brew install mosh` locally).

> **Why not Claude Desktop's integrated SSH for this?** Its remote‑project SSH mode
> drops the Claude Code session on disconnect with no resume, and times out after
> ~10 min of network loss (open feature request: anthropics/claude-code#49790). It
> can't be wrapped in mosh/tmux — the app drives `claude`'s stdio directly. For
> flaky connections use **Remote Control** or **mosh + tmux**; keep the Desktop
> integrated SSH for stable, at‑the‑desk work. (Your conversation is still persisted
> on the box either way — `claude --continue` resumes it after any drop.)

## References

- [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the web (runs on Anthropic cloud)](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Desktop SSH session persistence — feature request #49790](https://github.com/anthropics/claude-code/issues/49790)
