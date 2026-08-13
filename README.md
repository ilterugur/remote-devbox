# remote-devbox

Provision a cheap remote server into an **always-on development box shared by several
people**, with one Ansible run from your machine. Built for Bun / Turborepo / Vite /
container monorepos.

A **developer** is a real human with their own Linux account. Underneath that account,
four things are independent and each is chosen per project:

| Dimension | What it is | Example |
| --- | --- | --- |
| **git identity** | name, email and SSH key used to push | work vs. personal GitHub |
| **agent profile** | one login of one agent (Claude, Codex) | two Claude accounts side by side |
| **container engine** | rootless Podman, rootless Docker, or none | one legacy repo needs Docker |
| **memory space** | which long-term memory bank the agent uses | one shared bank, one private |

Nothing is implied by anything else: the agent driving a project does not decide which
account the commit is attributed to, and two agent profiles of the same person can share
one memory or keep separate ones.

Codex Desktop's managed code-mode host aggregates every Codex project for one developer.
When its measured peak needs more headroom than a single Remote Control server, set
`developers[].codex_host_resources`; it overrides only that developer's host and leaves
the per-project `remote_control.resources` limits unchanged.

Every agent owned by the same developer also shares one kernel-backed heavy-command
slot. Build, typecheck, generate and test commands queue instead of running in parallel;
lightweight toolchain commands remain concurrent. The gate is stale-lock safe because
the kernel releases its `flock` descriptor when the owning process exits. It defaults
on and can be overridden field-by-field for one Linux account. `categories` controls
which command families use the slot, `wait_timeout_sec: 0` waits forever (the default is
1800 seconds), and `warn_after_sec: 0` reports queuing immediately (the default is 5
seconds). Changed settings apply to newly launched agent processes. Claude profile
launchers pick them up on the next launch; an already-running managed Codex code-mode
host needs an explicit service restart before its inherited environment changes.

```yaml
host:
  heavy_job_gate:
    enabled: true
    categories:
      build: true
      typecheck: true
      generate: true
      test: true
    wait_timeout_sec: 1800
    warn_after_sec: 5

developers:
  - user: dev-a
    heavy_job_gate:
      categories:
        test: false # tests may run concurrently; other categories inherit host settings
```

Developers cannot read each other's homes, secrets, git keys, container sockets or even
each other's process command lines, and none of them can escalate to root.

## The flow

Everything comes from one file, `devbox.yml` (gitignored; start from
[devbox.example.yml](devbox.example.yml)). The CLI validates it, resolves every default,
and writes normalized variables that Ansible consumes — the roles contain no policy of
their own.

```bash
cp devbox.example.yml devbox.yml            # describe the box
cp devbox.secrets.example.yml devbox.secrets.yml
devbox plan                                 # validate + show what will happen
devbox apply                                # regenerate vars, then run the playbook
devbox apply containers --check             # one phase, dry run
```

`devbox plan` refuses to be vague. Two git identities with no default and no per-project
choice is an **error**, not a silent pick — that ambiguity is exactly how a commit ends
up on the wrong GitHub account. Run `devbox phases` to see the phases `apply` accepts.

On the box itself, `devbox doctor` emits the same versioned health model as
`devbox doctor --json`. On a configured client, the command also joins launchd/PID
ownership, mounts, sync, and the downstream box report:

```text
desktop.xrdp  healthy
client.rdp-tunnel.dev-a  healthy
profile.dev-a.isolation  healthy
```

Diagnosis is read-only. `devbox recover [component|all]` acts only on declared,
policy-eligible client failures and immediately re-probes them. It never resolves sync
conflicts, lazy/force-unmounts a busy mount, replaces a drifted launchd plist, or kills a
foreign port owner. Failed box services print an exact operator command; the client does
not gain root or accept raw systemd unit names.

> **Migrating from the profile-based layout?** `ansible/group_vars/all.yml` is the legacy
> format. `devbox migrate-config` converts it, warns about everything it cannot represent,
> and writes nothing unless you pass `--write`.

---

## What you get

- A hardened Ubuntu/Debian box: key-only SSH, UFW, Fail2Ban, Tailscale, swap.
- **mise** managing a shared toolchain — Node, Python, bun, uv — available even to
  Claude's non-interactive Bash tool (no hand-maintained PATH).
- **The GitHub CLI** (`gh`) from GitHub's own apt repo — PR and CI work is there for you
  and the agent out of the box (`gh auth login` once). Off with `host.github_cli: false`.
- **One Linux account per person**: private home, exact SSH key set, no sudo, no docker
  group, and `/proc` hidden so nobody sees anyone else's command lines.
- **Per-developer resource slices** (systemd): a runaway build slows down the person who
  started it and nobody else.
- **Rootless containers**, Podman or Docker, chosen per project; your repos cloned with
  the right identity's key and `bun install`ed.
- One **always-on Remote Control server per (profile, project)** — reachable from
  your phone, no inbound ports.
- Your portable Claude config (skills, subagents, commands, `CLAUDE.md`, MCP defs)
  synced into **every profile**, identity kept separate.

`developers[].resources.memory_high` sets systemd `MemoryHigh`, a soft-backpressure
threshold that makes a developer's workloads reclaim memory before the host is exhausted.
It accepts a direct size (`32G` or `32GB`), a percentage (`20%`), or `{ weight: N }` for
proportional distribution. In weight mode, the declared weights divide physical RAM minus
`host.memory_reserve`. The reserve only changes that calculation; it does not reserve RAM
for the OS through systemd or another cgroup control. Every declared developer
`memory_high` must use a weight because direct and weight modes cannot be mixed:

```yaml
host:
  memory_reserve: 4G

developers:
  - user: dev-a
    resources:
      memory_high: { weight: 1 }
  - user: dev-b
    resources:
      memory_high: { weight: 5 }
```

See [`devbox.example.yml`](devbox.example.yml) for the direct-limit form and a complete
commented weight-mode alternative.

## Architecture

```
  Client (desktop app / VS Code Remote-SSH, as a profile user) ─┐
                                                                ├─► Box ─► Anthropic API
  Phone (Claude mobile app, Remote Control, per profile)       ─┘   profiles = isolated
                                                                     Linux users; Docker
                                                                     services; mise toolchain
```

The **box is the host**; client and phone are just front-ends (the phone works with the client
off). Billing is tied to each Claude **account**, not the machine.

## Cost

| Item | Monthly |
| --- | --- |
| A small VPS (e.g. Hetzner **CX33** — 4 vCPU / 8 GB / 80 GB NVMe) | ~€6.49 |
| Tailscale (personal) | €0 |
| Claude subscription (Pro or Max — whatever you have) | $20–$200 |

➡️ The only **new** cost is the ~€6.49 box; running Claude Code on it adds nothing
(billing is tied to your account, not the machine). Resize to **CX43** (16 GB) in
~1 min if profiles/builds need more RAM.

> Multiple profiles = multiple Claude accounts: read
> **[docs/multi-account.md](docs/multi-account.md)** first — it's for separately
> owned, legitimately paid subscriptions only, not for dodging rate limits.

---

## Let Claude set it up (skill)

This repo bundles a Claude Code **skill** that drives the whole local side for you —
it interviews you, generates `inventory.ini` + `group_vars/all.yml`, runs the
preflight + playbook (with your confirmation), and walks you through the manual steps
(GitHub SSH keys, `sudo remote-devbox-login`).

- **In this repo:** open it with Claude Code — the skill at
  `.claude/skills/remote-devbox-setup/` is auto-discovered. Say *"set up my dev box"*.
- **From anywhere:** install it globally —
  `cp -r .claude/skills/remote-devbox-setup ~/.claude/skills/` — then ask Claude to
  *"set up remote-devbox"* and it'll locate (or clone) the repo.

Or do it by hand with the Quickstart below.

## Prerequisites (on your client)

- `ansible` (`brew install ansible` / `pipx install ansible`)
- An SSH keypair (`ssh-keygen -t ed25519`)
- A small VPS running Ubuntu 24.04 / Debian 12 with your SSH key added at creation
  (any provider; Hetzner CX33 at ~€6.49 is the cheap pick)
- A [Tailscale](https://tailscale.com) account + a reusable auth key

## Quickstart

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml

cp inventory.example.ini inventory.ini             # ansible_host (+ ansible_user=root for first run)
cp group_vars/all.example.yml group_vars/all.yml   # operator, ssh key, tailscale key, runtimes, profiles

../scripts/bundle-local-config.sh                  # optional: stage your portable ~/.claude config

ansible-playbook playbook.yml                      # ~15–25 min, idempotent
```

The playbook **prints an SSH public key per profile** — add each to that profile's
GitHub account (so its private repos clone; re-run the playbook to clone any that
failed the first pass). Then the one manual Claude step:

```bash
ssh admin@<box>            # your operator_user + box IP/Tailscale name
sudo remote-devbox-login   # one /login per profile (Remote Control needs OAuth)
```

Done. Servers come online within ~15s. Open the Claude mobile app → Code tab →
switch to that profile's account → your server → new session.

> **Re-runs:** after the first run, root SSH is disabled — change `ansible_user`
> in `inventory.ini` to your `operator_user`.

## What's automated vs. manual

| Automated (Ansible) | Manual (one-time) |
| --- | --- |
| Hardening, Tailscale, Docker, **mise + toolchain** | Add each profile's SSH key to its GitHub account |
| Per-profile users, **SSH keys + git identity** | One `/login` per profile (`sudo remote-devbox-login`) |
| Clone repos, `bun install`, `.env` scaffold | Fill in real `.env` secrets |
| Per-profile always-on Remote Control + config sync | (that's it) |

## Daily use

- **Client — Claude desktop app / VS Code Remote-SSH:** connect **as a profile
  user** (`ssh work@box`) → that profile's Claude, projects, and git identity.
  Auto port-forwarding for previews. See [docs/realtime-sync.md](docs/realtime-sync.md).
- **Phone — Claude mobile app:** Code tab → switch to the profile's account → its
  server → new session, runs on the box. See [docs/mobile.md](docs/mobile.md).
- **Flaky connection (mobile, switching networks) — `devbox`:** the box's installer
  writes a one-word command — `devbox` (default profile) or `devbox <profile> [session]` —
  that connects over mosh into a persistent tmux (ssh fallback), then run `claude`
  inside. Survives network drops / IP changes and resumes on reconnect — the resilient
  alternative to Claude Desktop's integrated SSH (which drops the session on
  disconnect). On by default (`mosh_enabled`); see [docs/mobile.md](docs/mobile.md).
- **Dev servers / preview:** `sudo remote-devbox-dev <user> <project>` on the box,
  then Tailscale Serve or VS Code forward.
- **Web UIs on the box — `devbox ui`:** dashboards and control planes listen on
  loopback, so the SSH key that got you onto the box is the only credential involved.
  `devbox ui` asks the box what is listening and tunnels the one you pick; the ports are
  discovered rather than declared, so the list cannot go stale.
- **`scripts/connect.sh`** runs locally and wraps the common ssh/attach/mosh/login/serve
  calls — `export DEVBOX_HOST=admin@<box>` first.

## Isolation & runtimes

- **Isolation:** each profile is a separate Linux user — own home, processes, files,
  SSH key, and git identity. Strong isolation without Docker's overhead. (Want hard
  network/resource isolation or to run untrusted code? That's where containers earn
  their keep — out of scope here.)
- **Runtimes:** declared in `group_vars` `runtimes:` and installed by **mise**. mise
  owns the shell env (`mise activate`); the only glue is `mise activate --shims` in
  the Remote Control wrapper so the agent's non-interactive Bash tool sees the tools.
  See [docs/runtimes.md](docs/runtimes.md).

## Repo layout

```
ansible/
  inventory.example.ini   group_vars/all.example.yml   playbook.yml
  requirements.yml        ansible.cfg
  roles/
    base  security  tailscale  mosh  docker  runtime(mise)  users  projects
    agent_remote  agent_config  browser
claude-config/   README.md  settings.shared.example.json  shared/ (gitignored)
scripts/
  remote-devbox-login.sh  remote-config-apply.sh  remote-devbox-dev.sh
  claude-rc-wrapper.sh  claude-rc-run.sh   (box)
  bundle-local-config.sh  connect.sh        (client)
docs/
  multi-account.md  multi-project.md  config-sync.md  runtimes.md
  mobile.md  realtime-sync.md  session-handoff.md
```

## Docs

- [Connecting to the box (Remote Control · mosh+tmux · Desktop SSH · Remote-SSH)](docs/connecting.md)
- [Multiple accounts / profiles (+ Anthropic ToS)](docs/multi-account.md)
- [Multiple projects + per-profile git](docs/multi-project.md)
- [Runtimes (mise) & isolation](docs/runtimes.md)
- [Syncing your Claude config (MCPs/skills/hooks)](docs/config-sync.md)
- [Driving the box from your phone](docs/mobile.md)
- [Real-time sync & preview on your client](docs/realtime-sync.md)
- [Moving a session client → box (`devbox push`)](docs/session-handoff.md)
- [Long-term memory (Hindsight)](docs/memory.md)

## Security notes

- Key-only SSH (admin + profile users), root login disabled, UFW default-deny,
  Fail2Ban — all by default. Prefer reaching the box over Tailscale.
- Each profile's git key is its own; Remote Control is outbound-HTTPS only.
- `inventory.ini` and `group_vars/all.yml` hold secrets and are **gitignored**.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| RDP or another forwarded service will not connect | Run `devbox doctor -p <user>`; a healthy local listener alone is not downstream proof. |
| A policy-eligible client component failed | Run `devbox recover <component> -p <user>`; inspect any refusal instead of forcing it. |
| Profile clone failed | Add that profile's printed SSH key to its GitHub account, re-run. |
| Server not on phone | `systemctl status 'agent-rc-*'`; did you run `sudo remote-devbox-login`? Switch to that account in the app. |
| `not logged in` in logs | Run `sudo remote-devbox-login`. |
| `node`/`python` missing for the agent | `mise activate --shims` runs in the wrapper; check the service env and `mise ls` for that user. |
| Re-run fails as root | Set `ansible_user` to your operator in `inventory.ini` (root login is off). |
| Attach a service's tmux | `sudo -u <user> tmux -L agent-rc-<agent>-<user>-<project> attach`. |
| A failed box service needs recovery | Use only the exact command printed by `devbox recover`; healthy/session-bearing services refuse automatic restart. |

## License

MIT — see [LICENSE](LICENSE).
