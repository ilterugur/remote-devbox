# Connecting to the box

The box is the host; your client and phone are just front-ends to it. There are several ways to
reach it — they differ mainly in **UI** and in **what happens when the connection
drops**. Pick by situation.

## Coordinates

- **Address:** prefer the box's **Tailscale** name / `100.x` IP (private, stable).
  The public IP works too (SSH is open via UFW).
- **Which user?**
  - **A profile user** (e.g. `work`) — for *driving Claude / coding*.
    Its `$HOME`, its projects, its Claude login, its git identity.
  - **The operator** (`admin`) — for *maintenance only* (Ansible, `sudo`). Not a
    Claude account. Root SSH is disabled after hardening.

## The methods

### 1. Remote Control — phone / web (most resilient, zero setup)

An always-on `claude remote-control` server runs on the box per `(profile, project)`
(systemd + tmux). The agent runs **on the box**; the client is just a view.

- **Connect:** Claude mobile app (or `claude.ai/code`) → **Code** tab → switch to that
  **profile's Claude account** → tap the server → new/continue session.
- **Disconnect (network loss, lid close):** the agent **keeps running on the box**; reconnect
  resumes the same session. A long task continues with your phone off.
- Best for: phones, flaky connections, client closed. See [mobile.md](mobile.md).

### 2. mosh + tmux — terminal, roaming-resilient (best for flaky connections)

Drive the real `claude` TUI from a terminal that survives network drops. The `devbox`
command the box's installer puts on your machine does this (per profile):

```bash
devbox                      # connect to the default profile, tmux session "main"
devbox <profile>            # a specific profile; add a 2nd arg for a named session
devbox <profile> <session>  # e.g. devbox work scratch
#   then, once attached:
claude
```

It connects over **mosh** (auto-reconnects across network/IP changes) into a
persistent **tmux** session — so a reconnect lands exactly where you left off — and
falls back to `ssh` if mosh isn't available. Under the hood it's
`mosh <prefix>-<profile> -- tmux new -A -s <session>`.

- Installed by default (`mosh_enabled`); the box's mosh UDP range is open **only on
  tailscale0**, so mosh needs the alias to resolve to the box's **Tailscale** address.
  The generated ssh block already prefers the tailnet when it is up (and its `-ts`
  variant pins it); it uses the **100.x IP**, not the MagicDNS name, because mosh often
  cannot resolve MagicDNS. Clients: this machine on
  Tailscale + `brew install mosh` (client) or Blink / Termius (phone).
- Best for: mobile, switching cells/Wi‑Fi, a real terminal.

### 3. Claude Desktop — integrated SSH remote project (desk only)

The desktop app opens the project on the box over its own SSH connection.

- **Not resilient:** on disconnect the remote Claude Code session **drops with no
  resume**, and it times out after ~10 min of network loss (open feature request:
  [anthropics/claude-code#49790](https://github.com/anthropics/claude-code/issues/49790)).
  It can't be wrapped in mosh/tmux — the app drives `claude`'s stdio directly.
- Best for: stable, at‑the‑desk work. For anything flaky, use #1 or #2.

### 4. VS Code / Cursor — Remote-SSH

The box's installer writes a `Host devbox-<user>` block into `~/.ssh/config`.

- **Connect:** Remote-SSH → Connect to Host → `devbox-<user>` → open
  `~/projects/<project>`. Editor + integrated terminal run on the box; auto
  port-forwarding for previews ([realtime-sync.md](realtime-sync.md)).
- Disconnects: the editor reconnects, but a `claude` in the integrated terminal is
  connection-tied — run it inside `tmux` if you need it to survive drops.

### 5. Plain SSH — terminal

```bash
ssh <user>@<box>            # profile user to code, admin to maintain
```

- Run `claude` directly and a dropped SSH **kills it** (SIGHUP). Wrap it in `tmux`
  (`tmux new -A -s main`) — or just use mosh+tmux (#2) — to survive disconnects.
- `scripts/connect.sh` wraps the common operator calls (`ssh`/`status`/`login`/
  `attach`/`mosh`/`devup`/`serve`); `export DEVBOX_HOST=admin@<box>` first.

### 6. Full desktop — RDP (XFCE, for the things a terminal can't do)

For a developer with `desktop.enabled`, the box runs XFCE behind xrdp. Point an RDP
client (macOS: Microsoft's **Windows App**) at **`localhost:<client_port>`** (3389
unless `desktop.client_port` says otherwise) and log in with the Linux username and the
PAM password whose hash is in `devbox.secrets.yml`.

- **The address is always `localhost:<client_port>`** (3389 unless `desktop.client_port`
  says otherwise). `devbox agent up` keeps an ssh tunnel to the box open under launchd,
  and because that tunnel dials the ssh alias it follows the same tailnet→public fallback
  every other ssh does — so the address in your RDP client is right whether Tailscale is
  up, down, or restarting. `devbox agent status` says whether the local end of that tunnel
  is up; it cannot tell you the box's xrdp answers, because the listener it connects to is
  ssh's own (ssh accepts the connection first and only then dials the box).
- **Reachability on the box follows `desktop.access`** — a list, defaulting to
  `[tunnel, tailnet]` with Tailscale on and `[tunnel]` without it. `tunnel` is what makes
  xrdp listen on 127.0.0.1, and it is the only entry the agent's tunnel can reach: drop it
  and the forward lands on a port with nothing behind it (`devbox agent up` says so when
  it writes the agent). `tailnet` additionally listens on the box's 100.x address. RDP is
  the one door here authenticated by a password rather than a key, which is why it is
  never public unless you spell out `unsafe-public`.
- **The keyboard comes from `desktop.keyboard`**, or from the machine that ran
  `devbox plan` when you leave it out. It is applied by teaching xrdp the layout id
  your client announces — setting it inside the session does not stick, because xrdp
  applies its own keymap when the client connects, after the session has started.
- **⌘W closes the whole connection** on macOS, and no in-app setting changes that:
  macOS routes it to the client's own "Close" menu item before the app can forward it.
  Free it with `devbox editors`, which moves that menu item
  to ⌥⌘W (quit and reopen the client afterwards — menu shortcuts are read at launch).
  Note the client maps Command to the **Windows** key and Control to Ctrl, so the key
  that reaches the session as Ctrl was always the physical Control key.
- **A restart of xrdp abandons open desktops.** `xrdp-sesman` keeps its session list in
  memory and is `BindsTo=xrdp.service`, so an apply that reloads xrdp leaves the running
  session unreachable — and XFCE allows one session manager per user, so the next login
  would exit a second after it starts. The session script reaps those abandoned sessions
  at login, so the recovery is simply to connect again.

## What runs on your own machine

Two things on the client are long-lived, and both are launchd agents written by
`devbox agent up` (macOS; on Linux the command prints the systemd --user equivalent):

| Agent | What it does |
| --- | --- |
| `com.devbox.<user>.desktop` | holds the RDP tunnel open — `127.0.0.1:<client_port>` → the box's 3389 |
| `com.devbox.<user>.mount` | re-runs `devbox mount up` every 60s, so the `mnt` bridge survives sleep and wake |

```bash
devbox agent status   # what is described, what launchd has loaded, what the local port does
devbox agent up       # install or update them, and remove any the config no longer describes
devbox agent down     # remove them
```

The mount agent only appears for a profile whose **lazy mounts are known**, and today that
means a checkout of the legacy `ansible/group_vars/all.yml` layout: `devbox.yml` has no
`lazy_mounts` field yet and the box does not publish one either, so on the canonical path
`devbox agent up` writes the desktop agent alone. The `mnt` bridge still works — it just
has no launchd reconciler behind it, so re-run `devbox mount up` yourself after a sleep or
a network drop.

Logs are in `~/.local/state/devbox/<label>.log`. Neither agent is required — they are
what makes a saved RDP entry and a mounted path keep working without you thinking about
it.

## At a glance

| Method | UI | Survives a disconnect? | Best for |
| --- | --- | --- | --- |
| Remote Control | phone / web | ✅ agent runs on the box | phone, flaky net, client off |
| mosh + tmux | terminal (`claude` TUI) | ✅✅ auto-reconnect + persistent | mobile, flaky connections, terminal lovers |
| Claude Desktop integrated SSH | desktop app | ❌ session drops, no resume | stable desk work |
| VS Code / Cursor Remote-SSH | editor | ⚠️ editor reconnects; `claude` only if in tmux | editing on the box |
| Plain SSH | terminal | ❌ unless you use tmux | quick ops, scripted access |
| RDP desktop | XFCE desktop | ⚠️ session survives a client drop; not an xrdp restart | browsers, GUI tools, anything not a terminal |

> **Your conversation is never lost.** Claude Code persists each session to disk on
> the box (`~/.claude/projects/<slug>/*.jsonl`). After any drop, `claude --continue`
> (resume the latest) or `claude --resume` (pick one) brings the conversation back —
> only an in‑flight turn is lost.
