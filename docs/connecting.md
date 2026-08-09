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

### 6. Web UIs on the box — `devbox ui`

Anything the box runs with a web interface — an agent dashboard, a memory control plane —
listens on **loopback**. That is deliberate: a loopback service has no door of its own, so
the SSH key that got you onto the box is the only credential in play, and a service that
never learned to authenticate is not a hole in the box.

```bash
devbox ui                 # what is listening right now, and which needs a tunnel
devbox ui hindsight       # tunnel it and open the browser
devbox ui 9077            # by port, when the name is ambiguous or unhelpful
devbox ui desktop         # the RDP port; prints an address instead of opening a browser
```

Which ports exist is **asked of the box**, not declared in `devbox.yml`: a list in the
config is one more thing to keep true, and it would be wrong in exactly the case that
matters — a service that moved, or died. Both ends of the tunnel bind `127.0.0.1`, so it
never re-publishes a box service to whatever network your laptop is on.

A listener that is *not* on loopback is shown as such. On a box where the firewall is the
only thing keeping it private, that line is the warning.

### 7. Full desktop — RDP (XFCE, for the things a terminal can't do)

For a developer with `desktop.enabled`, the box runs XFCE behind xrdp. Point an RDP
client (macOS: Microsoft's **Windows App**) at **`localhost:<client_port>`** (3389
unless `desktop.client_port` says otherwise) and log in with the Linux username and the
PAM password whose hash is in `devbox.secrets.yml`.

- **The address is always `localhost:<client_port>`** (3389 unless `desktop.client_port`
  says otherwise). `devbox agent up` keeps an ssh tunnel to the box open under launchd,
  and because that tunnel dials the ssh alias it follows the same tailnet→public fallback
  every other ssh does — so the address in your RDP client is right whether Tailscale is
  up, down, or restarting. `devbox agent status` remains a fast local view. Use
  `devbox doctor` for the end-to-end answer: it requires both the exact launchd SSH PID
  to own the local listener and the box's `desktop.xrdp` component to be healthy.
- **Reachability on the box follows `desktop.access`** — a list, defaulting to
  `[tunnel, tailnet]` with Tailscale on and `[tunnel]` without it. `tunnel` is what makes
  xrdp listen on 127.0.0.1, and it is the only entry the agent's tunnel can reach: drop it
  and the forward lands on a port with nothing behind it (`devbox agent up` says so when
  it writes the agent). `tailnet` additionally listens on the box's 100.x address. RDP is
  the one door here authenticated by a password rather than a key, which is why it is
  never public unless you spell out `unsafe-public`.
- **`devbox ui desktop` is the one-off version of the same thing** — it opens a tunnel
  for as long as it runs and prints the address. Reach for it on a machine you have not
  set agents up on; the agent is what makes the address survive a reboot.
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

## Browser failover — isolated client browser

Browser failover gives the box's browser MCP endpoint a client-browser primary and a
box-local Chrome fallback. Enable `browser.failover` with a `chrome_user` that names
one real developer, then have the operator provision both the endpoint and the current
client binary:

```bash
devbox apply browser
```

This also publishes the current client CLI: the `box_cli` Ansible role is tagged
`always`, so it runs with the browser phase.

On that named client's machine, fetch the generated installer through the profile SSH
alias into a local temporary file. Inspect it before running it; do **not** pipe a remote
command directly to a shell. The installer refreshes both the client binary and the
client configuration that carries the browser-failover owner slice.

```bash
installer=$(mktemp "${TMPDIR:-/tmp}/devbox-installer.XXXXXX")
ssh devbox-<chrome_user> 'devbox client-config --installer' > "$installer"
less "$installer"                         # inspect before execution
sh "$installer"                           # refresh the binary and client config
```

Only after that refresh, start and inspect the profile-scoped lifecycle:

```bash
devbox agent up -p <chrome_user>       # isolated local Chrome plus reverse CDP tunnel
devbox agent status -p <chrome_user>   # local agents and their state
devbox agent down -p <chrome_user>     # stop and remove them
```

### Browser execution mode and Devbox project ports

The failover endpoint is a CDP TCP proxy, not an HTTP navigation proxy. Choose
which machine should resolve browser `localhost` explicitly:

```bash
devbox browser mode server -p <chrome_user>  # Devbox Chrome: localhost is the Devbox
devbox browser mode client -p <chrome_user>  # isolated client Chrome: localhost is your Mac
devbox browser status -p <chrome_user>
```

`server` unloads only the client browser supervisor and its owned port
forwards; RDP, mounts, and sync agents stay untouched. `client` restores the
isolated Chrome/reverse CDP tunnel. Start a fresh browser MCP connection after
switching so it attaches to the selected backing Chrome.

When client mode needs a Devbox development server in your Mac browser, bind
only the port(s) you mean to expose. Each binding is loopback-only and fails if
the same local port is already in use; the command never stops or hijacks the
existing process.

```bash
devbox browser bind insurchat -p <chrome_user>  # ports declared on one project
devbox browser bind --all -p <chrome_user>      # all declared project ports
devbox browser bind --port 5173 -p <chrome_user>
devbox browser unbind insurchat -p <chrome_user>
```

The default is manual binding. To bind all declared `projects[].ports` whenever
you select client mode, set this in `devbox.yml`, apply it, then refresh the
client installer:

```yaml
browser:
  failover:
    enabled: true
    chrome_user: <chrome_user>
    autobind: true
```

Use only a dedicated, low-risk account as `chrome_user`. CDP has browser-control
authority, so the local Chrome uses its own Devbox data directory and the reverse tunnel
binds at `127.0.0.1` on both the client and box; it is not a LAN or public browser
endpoint. The CLI exposes this lifecycle only to the configured owner, not every local
profile.

## What runs on your own machine

Client-side services are launchd agents written by
`devbox agent up` (macOS; on Linux the command prints the systemd --user equivalent):

| Agent | What it does |
| --- | --- |
| `com.devbox.<user>.desktop` | holds the RDP tunnel open — `127.0.0.1:<client_port>` → the box's 3389 |
| `com.devbox.<user>.mount` | re-runs `devbox mount up` every 60s, so the `mnt` bridge survives sleep and wake |
| `com.devbox.<user>.browser` | ownership-coupled browser supervisor: starts the isolated Chrome, validates its loopback CDP, and holds the reverse tunnel only while that Chrome runs |

```bash
devbox agent status   # what is described, what launchd has loaded, what the local port does
devbox agent up       # install or update them, and remove any the config no longer describes
devbox agent down     # remove them
devbox doctor         # join local ownership with the versioned downstream box report
devbox recover all    # recover only allowlisted failures; refusals stay non-destructive
```

Each agent appears only when its profile asks for it: the desktop one for a developer with
`desktop.enabled`, the mount one for a developer with `file_bridge.lazy_mounts`, and the
browser supervisor only for the named `browser.failover.chrome_user`. A profile with none
gets nothing, and `devbox agent up` says so rather than writing an empty agent.

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
