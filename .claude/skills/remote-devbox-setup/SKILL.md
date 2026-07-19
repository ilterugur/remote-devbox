---
name: claude-devbox-setup
description: >-
  Set up and drive the claude-devbox toolkit from the user's client — provision a
  remote, multi-profile, always-on Claude Code dev box (Ansible + mise + per-profile
  Linux users). Use this WHENEVER the user wants to set up, provision, configure,
  bootstrap, or deploy claude-devbox or "a remote Claude Code dev box / dev server";
  fill in or generate its Ansible inventory or group_vars; add a profile, account,
  project, or runtime to the box; run its playbook; or do the post-install steps
  (adding per-profile SSH keys to GitHub, `sudo claude-devbox-login`). Trigger even
  when they don't name the tool — e.g. "set up my remote dev box", "configure the
  claude server", "add a work profile to the box", or when they paste box IP / SSH /
  Tailscale details expecting provisioning.
---

# claude-devbox setup

Drive the local side of **claude-devbox**: gather inputs → generate the config →
run the playbook → guide the few manual steps. The repo already documents the
architecture; this skill is the interactive wizard that wires it up for the user.

Be a careful operator. Provisioning **hardens SSH and installs software on a real
remote box** — confirm before the run, never commit or echo secrets, and never
touch a GitHub account that isn't the user's.

## Step 0 — Locate the repo

`claude-devbox` is an Ansible repo. Find its checkout (call it `$REPO`):

- If the current directory (or an obvious sibling) contains `ansible/playbook.yml`
  and `ansible/roles/claude_remote/`, that's `$REPO`.
- Otherwise ask the user for the path, or offer to `git clone` it (ask for the URL).

Read `$REPO/README.md` and skim `$REPO/docs/` so your guidance matches the repo's
current behavior rather than your memory — the toolkit evolves.

## Step 1 — Prerequisites (on the client)

- `ansible --version` — if missing: `brew install ansible` or `pipx install ansible`.
- `cd $REPO/ansible && ansible-galaxy collection install -r requirements.yml`.
- An SSH keypair for logging into the box (the operator key). If absent, offer
  `ssh-keygen -t ed25519`.
- A **Tailscale auth key** — the user creates a *reusable, non-ephemeral* key at
  https://login.tailscale.com/admin/settings/keys . Ask them to paste it; treat it
  as a secret (see Secrets below).
- A VPS already created (Ubuntu 24.04 / Debian 12) with the operator key added, and
  its IP/hostname. If they haven't got one, point them at the README's cheap pick.

## Step 2 — Interview

Collect the values that drive `group_vars/all.yml`. Prefer a few grouped questions
over a long form. Gather:

- **Box**: `ansible_host` (IP/Tailscale name).
- **Operator** (admin user Ansible connects as): `operator_user` (default `admin`),
  `operator_ssh_pubkey` (read `~/.ssh/id_ed25519.pub` or ask), and
  `operator_private_key_path` (the matching private key, for the pre-hardening probe).
- **Networking**: `tailscale_authkey`.
- **Runtimes** (installed once via mise, shared): sensible defaults
  `node: lts, python: "3.12", bun: latest, uv: latest` — confirm or adjust.
- **Profiles** — each is its own Linux user = one Claude account = one git identity.
  For each: `user`, `git_name`, `git_email`, `projects` (each `name` / `repo` /
  `branch` / optional `ports`), and `servers` (each `project` / `name` / `spawn` /
  `capacity`). For the profile `user`, don't default to a generic name like `work` —
  **propose a username derived from the project's git identity** (e.g. the current
  repo's `git config user.name`, lowercased/sanitized to `[a-z0-9-]`) so it's
  meaningful; let the user confirm or override. Pull `git_name`/`git_email` and the
  project's `repo` (convert an `https://github.com/...` remote to its `git@github.com:...`
  SSH form for private clones) / `branch` straight from the target repo's `git config`
  and `git remote` when it's available, rather than asking the user to type them.
  Note the **operator** user is separate infrastructure (sudo/Ansible only, root SSH
  is disabled after hardening so it can't be skipped) and **cannot** be the same Linux
  user as a profile — if the user balks at "admin", explain that, don't merge them.

If they want **more than one profile**, surface the multi-account rule up front:
it's only for separately-owned, legitimately-paid subscriptions, never to dodge one
account's rate limits. Point to `docs/multi-account.md` and let them confirm.

Don't invent repos or emails — ask. Mirror the exact field names/shape in
`group_vars/all.example.yml` (read it first; it's the source of truth for the schema).

## Step 3 — Generate the config

- **`ansible/inventory.ini`** from `inventory.example.ini`: set `ansible_host`, and
  `ansible_user=root` for the **first** run (root is disabled after hardening — leave
  a clear comment to switch it to `operator_user` for later runs).
- **`ansible/group_vars/all.yml`** from the interview, matching the example's
  structure. If `all.yml` already exists, show a diff / back it up and confirm before
  overwriting — it may hold the user's real secrets.
- Sanity-check it parses: `cd $REPO/ansible && ansible-playbook --syntax-check -i inventory.ini playbook.yml`.

## Step 4 — Optional: stage the user's Claude config

Offer to mirror their portable `~/.claude` (skills, subagents, commands, CLAUDE.md,
MCP defs) into every profile via `scripts/bundle-local-config.sh`. **First** read
`docs/config-sync.md` to them in brief — settings.json/hooks and local-tool-dependent
MCPs need box-side work and are off by default. Don't force it.

## Step 5 — Run the playbook (CONFIRM FIRST)

This step has real, hard-to-reverse side effects: it creates users, **disables root
SSH**, installs Docker/mise/Claude Code, and starts services on the named box. Before
running, summarize *exactly* what it will do and to *which* host, and get an explicit
go-ahead.

```bash
cd $REPO/ansible && ansible-playbook playbook.yml
```

Stream the output. **Capture the per-profile SSH public keys it prints** (the "Public
keys to add to each profile's GitHub account" task) — you'll hand these to the user
next. Note any clone that failed (that's expected if a key isn't on GitHub yet).

## Step 6 — Guide the manual steps

These can't be fully automated; walk the user through them:

1. **Add each profile's SSH public key to *that profile's* GitHub account** (the keys
   from Step 5), then verify access *before* re-running so the clone can't fail twice.
   - **One key per profile, reused across all its repos.** The keypair is generated
     once per profile (`/home/<user>/.ssh/id_ed25519`, guarded by `creates:`), so the
     SAME key serves every project that profile clones. You add it to GitHub **once**
     per profile — adding more projects to an existing profile needs **no** new key.
     Only a brand-new *profile* generates (and needs you to add) a new key.
   - **Prefer the proactive `gh` path** when `gh` is installed and the user confirms:
     for each profile's repo, first check the active account can reach it —
     `gh api user -q .login` (is this the profile's intended GitHub identity?) and
     `gh repo view <owner/repo> --json viewerPermission` (does it return access, not
     404?). If good, add the key with `gh ssh-key add <pubfile> --title claude-devbox-<user>`
     and re-check `gh repo view`. Adding an SSH key changes GitHub account settings, so
     confirm each one, make sure the correct account is active, and **never** do this
     for an account that isn't the user's. Doing this access check up front means you
     know the next playbook run will clone cleanly instead of waiting for it to fail.
   - Otherwise give the exact manual steps (Settings → SSH and GPG keys → New SSH key).
   - The first run's clone is non-fatal (`failed_when: false`) — it just skips and the
     `claude-rc-*` service polls until the repo appears. After the key is on GitHub and
     `gh repo view` confirms access, **re-run the playbook** to clone + `bun install`.
2. **Switch `inventory.ini`** `ansible_user` to the `operator_user` for all future
   runs (root login is now disabled).
3. **One `/login` per profile** — Remote Control needs interactive OAuth:
   ```bash
   ssh <operator_user>@<box>
   sudo claude-devbox-login
   ```
   Follow the prompts (`/login` → Claude account → paste code → `/exit`). Servers come
   online within ~15s; no restart needed.

## Step 7 — Verify & hand off

- Check services: `ssh <operator>@<box> "systemctl status 'claude-rc-*' --no-pager"`
  (or `scripts/connect.sh status` with `DEVBOX_HOST` set).
- **Register the box as an SSH host (so the Claude desktop app + editors see it):**
  run `python3 scripts/gen-editor-config.py`. It **idempotently adds a `Host
  devbox-<user>` block per profile to `~/.ssh/config` if not already present** (its own
  managed block, backed up first) — that's the SSH-host entry the **Claude desktop app**,
  VS Code / Cursor Remote-SSH, plain `ssh`, and Zed all read. For Zed it also merges an
  `ssh_connections` entry pre-listing each profile's projects (if Zed's settings has
  comments it prints the snippet to paste instead — paste it yourself). It also writes
  a one-word **`devbox`** shell command (`devbox` = default profile, `devbox <profile>
  [session]` otherwise) that connects over mosh+tmux for a drop-proof terminal — pass
  `--host <tailscale-100.x-IP>` so mosh resolves over Tailscale (its UDP is tailscale-only;
  use the **100.x IP, not the MagicDNS name** — mosh often can't resolve MagicDNS),
  `--default <profile>` to set the bare-`devbox` target, and `--launch claude` to auto-start
  Claude on a fresh session (the command pins LANG/LC_ALL/LC_CTYPE so a macOS region locale
  like en_TR.UTF-8 doesn't break mosh-server). Re-running is safe:
  existing blocks are updated in place, not duplicated.
  - **`--cli`** (when the client has **bun**): installs the Bun/TS CLI at
    `clients/devbox/` instead of the shell function — a fuzzy picker (`@clack/prompts`,
    no fzf), git-auto-open of the matching local repo, and an argv-array launch (no
    shell-quoting pitfalls). It writes `~/.config/claude-devbox/config.json`, drops a
    `~/.local/bin/<prefix>` wrapper, and removes the shell function so it isn't shadowed.
    Omit `--cli` for clients without bun (e.g. the phone) to keep the shell function.
- Point the user to daily use: connect the **desktop app / VS Code Remote-SSH /
  Zed as a profile** (e.g. `devbox-work`), drive from the **mobile app** per
  profile, and preview dev servers (`docs/realtime-sync.md`, `docs/mobile.md`).

## Adding a profile / project / runtime later

Edit `group_vars/all.yml`, re-run the playbook (idempotent). A new **profile** prints
a new SSH key (add it to GitHub once) and needs its own `/login`. A new **project**
under an *existing* profile reuses that profile's key — **no new GitHub key** — just
make sure the profile's account can reach the new repo (`gh repo view`). A new
`servers` entry brings up its own `claude-rc-<user>-<project>` service (services are
per-profile-per-project: one always-on Remote Control server per project, which is the
right granularity — you attach to each project independently from the phone).

## Connecting local agents to the box's Hindsight memory (optional)

The `hindsight` role provisions long-term memory ON THE BOX (per profile: a local
`uvx hindsight-embed` daemon, the `hindsight-memory` Claude Code plugin, a
profile-wide bank named after the profile, and — when `hindsight_expose_tailscale:
true` — a Tailscale-Serve HTTPS API at `https://<node>.<tailnet>.ts.net:<serve_port>`).
**The playbook owns the BOX only.** To make a *client-side* agent (the user's laptop
Claude Code / Codex, Hermes Desktop, etc.) share that same memory, wire it in
**shared mode** — point it at the box's served API and reuse the same `bankId` so the
box stays the **single source of truth** (never a local daemon/bank).

Read `docs/memory.md` first. Core rule: set `hindsightApiUrl` to the served URL and
`bankId` to the profile name (e.g. `ilterugur`). With `hindsightApiUrl` set, the
plugin is external-only and can NEVER fall back to a local store. No LLM key is needed
client-side (the box does extraction). Confirm the client is on the tailnet and can
reach the URL (`curl .../health`).

**Per-agent wiring:**

- **Claude Code (CLI on PATH):** clone the marketplace LOCALLY first (Claude Code
  ≥2.1's `plugin marketplace add <owner/repo>` network clone is buggy —
  `ERR_STREAM_PREMATURE_CLOSE` — even though plain `git clone` works), then add by path:
  `git clone --depth 1 https://github.com/vectorize-io/hindsight.git ~/.claude/plugins/marketplaces/hindsight`,
  `claude plugin marketplace add ~/.claude/plugins/marketplaces/hindsight`,
  `claude plugin install hindsight-memory`. Then write `~/.hindsight/claude-code.json`:
  `{"hindsightApiUrl":"https://<node>.<tailnet>.ts.net:<serve_port>","bankId":"<profile>","dynamicBankId":false,"autoRecall":true,"autoRetain":true,"enableKnowledgeTools":true,"retainTags":["source:claude-code"]}`
  (no `profile:` tag — the bank is already per-profile, so it would just duplicate `bankId`).

- **Claude Code (desktop app):** it runs Claude Code in a Linux VM, so the `claude`
  binary isn't host-runnable — but it READS host `~/.claude`. Register the plugin by
  hand: add a `hindsight` entry to `~/.claude/plugins/known_marketplaces.json` and a
  `hindsight-memory@hindsight` entry to `~/.claude/plugins/installed_plugins.json`
  (mirror an existing custom-marketplace entry; `installPath` →
  `~/.claude/plugins/cache/hindsight/hindsight-memory/<ver>` with the plugin files
  copied there), set `enabledPlugins."hindsight-memory@hindsight": true` +
  `extraKnownMarketplaces.hindsight` in `~/.claude/settings.json`, and write the same
  `~/.hindsight/claude-code.json` as above. BACK UP each JSON first; takes effect next
  session.

- **Codex (CLI/desktop fork with the plugin system):** the OFFICIAL Hindsight Codex
  installer (`curl …/get-codex | bash`) writes a global `~/.codex/hooks.json` +
  `codex_hooks` — a customized Codex fork (e.g. codex-cli 0.13x) IGNORES global
  hooks.json and only runs PLUGIN hooks (`plugin_hooks` feature). So package the
  official codex scripts (`hindsight-integrations/codex/scripts`) as a LOCAL Codex
  plugin: a marketplace dir + a plugin with `.claude-plugin/plugin.json` and
  `hooks/hooks.codex.json` (SessionStart/UserPromptSubmit/Stop →
  `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/*.py"`), then `codex plugin marketplace add
  <dir>` + `codex plugin add hindsight-memory@<marketplace>`. Write `~/.hindsight/codex.json`
  (same shared keys, `retainTags` source:codex). The user must approve the one-time
  **hook-trust** prompt on the next Codex session. (For a STANDARD Codex CLI, just run
  the official installer and set `~/.hindsight/codex.json` — no plugin needed.)
  - **Mid-turn knowledge tools (`agent_knowledge_*`) for Codex:** the plugin above is
    HOOKS-ONLY (auto recall/retain) — it does NOT give the agent the on-demand memory
    tools. Codex supports MCP servers (`[mcp_servers.*]` in `~/.codex/config.toml`), so add
    Hindsight's MCP server. The official codex plugin's bundled `lib` is OLDER than the
    Claude Code plugin's `mcp_server.py` (its `HindsightClient` lacks `request`/`retain` and
    the `request_timeout_override` arg), so DON'T import the codex lib — **vendor** the CC
    plugin's matched files into a separate dir, e.g. `<codex-plugin>/mcp/`: copy
    `scripts/mcp_server.py`, `scripts/run_mcp.sh`, `scripts/lib/`, and `requirements.txt`
    from `~/.claude/plugins/cache/hindsight/hindsight-memory/<ver>/`, then patch the vendored
    `lib/config.py` so `user_config_path` reads `~/.hindsight/codex.json` (not
    `claude-code.json`) → bankId resolves to the shared bank. Register it:
    `[mcp_servers.hindsight]` `command="bash"`, `args=["…/mcp/scripts/run_mcp.sh"]`,
    `enabled=true`, `startup_timeout_ms=60000`, and `[mcp_servers.hindsight.env]`
    `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` → the `mcp/` dir. Needs `enableKnowledgeTools:true`
    in `codex.json` (mcp_server.py no-ops otherwise). Pre-warm once (first run pip-installs
    `mcp` into a venv under `CLAUDE_PLUGIN_DATA`); verify with `codex mcp list` (server
    `hindsight`, enabled) and an stdio `tools/list` (9 `agent_knowledge_*` tools).

- **Hermes Agent:** `hermes memory setup hindsight` → mode **`local_external`**,
  api_url `http://127.0.0.1:9077` (if Hermes runs ON the box) or the served URL
  (remote), bank the profile name. NEVER cloud/local_embedded if you want the shared
  box bank. Hermes Desktop in remote-backend mode uses the server's config — no
  client-side Hermes setup needed.

**Bank tuning (shared across all clients):** the bank's missions are tightened to keep
durable, user-specific knowledge and drop noise (skill/framework docs, git/test/task
logs, transient detail) — set centrally in the role's `defaults/main.yml`
(`hindsight_retain_mission` / `_bank_mission` / `_observations_mission` /
`_retain_every_n_turns`). See `docs/memory.md` → "Tuning what gets remembered". To
(re)apply on a fresh/reset bank, run `--tags hindsight` while the daemon is up, or
`PATCH http://127.0.0.1:9077/v1/default/banks/<profile>/config` with the missions.

**Safety:** never run `codex exec --dangerously-bypass-approvals-and-sandbox` inside a
repo to "test" hooks — the agent can edit/commit files unprompted. Test with a
disposable cwd, and clean up any test memories via the control plane.

## Remote browser failover — client wiring

The `browser` role can optionally expose a **CDP (Chrome DevTools Protocol) failover
endpoint** so the box's per-profile **`playwright`** and **`chrome-devtools`** MCP
servers attach to the operator's **client browser** when online — residential IP,
isolated profile, observable — and fall back to a server-side headless Chrome when
offline.

### Step 1 — Enable server side

In `ansible/group_vars/all.yml` set:

```yaml
browser_remote_failover: true
```

(Requires `browser_automation: true`, which is the default.)

Then re-run the playbook with the `browser` tag:

```bash
cd $REPO/ansible && ansible-playbook playbook.yml --tags browser
```

This provisions a HAProxy load-balancer on the box that listens on port 9222, checks
the `client` pool (reverse-tunnelled client browser on `127.0.0.1:9322`) first, and
falls back to a local headless Chrome on `127.0.0.1:9422`.

### Step 2 — Client: isolated Chrome profile (macOS launchd agent)

Create a launchd agent that starts an **isolated** Chrome profile with remote debugging
enabled. Save as `~/Library/LaunchAgents/com.devbox.agent-chrome.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.devbox.agent-chrome</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</string>
    <string>--remote-debugging-port=9222</string>
    <string>--remote-allow-origins=*</string>
    <string>--user-data-dir=/Users/[operator]/agent-chrome-profile</string>
    <string>--no-first-run</string>
    <string>--no-default-browser-check</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Replace `[operator]` with your macOS username. The `--user-data-dir` path must be
absolute (launchd does not expand `$HOME`).

> **Security — use low-stakes accounts only.** The agent has full programmatic control
> of whatever is logged into this profile. Prompt injection is an unsolved risk in
> agentic workflows: a malicious page or document could instruct the agent to act on
> any account open in the browser. Community best practice: **log only low-stakes
> accounts into the agent profile** — never banking, primary email, or anything with
> sensitive personal data. Keep agent tasks low-stakes. The isolated `--user-data-dir`
> ensures the agent profile is completely separate from your main browser session.

**KeepAlive caveat:** if you quit Chrome from the Dock, launchd will relaunch it
automatically. To stop the agent browser, bootout the agent (see Step 4).

### Step 3 — Client: SSH reverse tunnel (macOS launchd agent)

First add the box's host key to avoid interactive prompts:

```bash
ssh-keyscan -T 8 [box].[tailnet].ts.net >> ~/.ssh/known_hosts
```

Then create `~/Library/LaunchAgents/com.devbox.cdp-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.devbox.cdp-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string>
    <string>BatchMode=yes</string>
    <string>-o</string>
    <string>ServerAliveInterval=15</string>
    <string>-o</string>
    <string>ServerAliveCountMax=3</string>
    <string>-o</string>
    <string>ExitOnForwardFailure=yes</string>
    <string>-R</string>
    <string>127.0.0.1:9322:localhost:9222</string>
    <string>[operator]@[box].[tailnet].ts.net</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Replace `[operator]` with the operator username and `[box].[tailnet].ts.net` with your
box's Tailscale hostname. The tunnel forwards the box's `127.0.0.1:9322` to the
client's `localhost:9222`, making the client browser reachable from the box.

### Step 4 — Load / unload the agents

Load both agents (takes effect immediately, persists across reboots):

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.devbox.agent-chrome.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.devbox.cdp-tunnel.plist
```

To disable (stops the process and removes from boot):

```bash
launchctl bootout gui/$(id -u)/com.devbox.agent-chrome
launchctl bootout gui/$(id -u)/com.devbox.cdp-tunnel
```

### Step 5 — Verify

From the box, check which backend is active:

```bash
# When client Mac is online and tunnel is up → returns client browser build info
curl -sS http://127.0.0.1:9222/json/version

# When client is offline → returns the server-side headless Chrome build info
curl -sS http://127.0.0.1:9222/json/version
```

Confirm HAProxy sees the client pool as healthy:

```bash
journalctl -u haproxy | grep cdp_pool
# Healthy: cdp_pool/client is UP
# Offline: cdp_pool/client is DOWN — falling back to local headless
```

## Secrets & safety (non-negotiable)

- `inventory.ini` and `group_vars/all.yml` hold the Tailscale key and other secrets
  and are **gitignored** — keep them so. Never commit them, never paste their
  contents into a chat/PR/external service, never `echo` the Tailscale key.
- Confirm with the user before the playbook run (side effects) and before any change
  to a GitHub account.
- **Pruning is destructive and opt-in.** If the user removed a profile/server and
  wants cleanup, run `--tags prune` and show them the exact list it reports; only
  pass `-e prune_assume_yes=true` (and the user/home flags) AFTER they confirm in
  chat. Never wipe a home directory without explicit, specific approval.
- If anything in the repo contradicts this skill, trust the repo (`README.md`,
  `docs/`, `group_vars/all.example.yml`) — it's the live source of truth.
