# Multiple projects & per-profile git

Everything is driven by the `profiles` list in `group_vars/all.yml`. Each profile
(a Linux user) has its own projects, its own git identity, and its own
Remote Control servers.

```yaml
profiles:
  - user: work                       # Linux user = profile = one Claude account
    git_name: "Your Name"
    git_email: "you@work.example"
    projects:
      - name: app
        repo: "git@github.com:work-org/app.git"
        branch: main
        install: true                # run `bun install` after clone
        update: false                # don't git-pull over Claude's local edits
        ports: [5173, 3000]
    servers:                         # one Remote Control server per project
      - project: app
        name: "Work · app"
        spawn: worktree              # worktree | same-dir | session
        capacity: 4
```

## Per-profile git accounts (the clean case)

Because each profile is its **own Linux user**, a different GitHub account per
profile is automatic — no SSH host-aliases or `includeIf` gymnastics:

- The `users` role generates `/home/<user>/.ssh/id_ed25519` and **prints the public
  key**. Add it to *that profile's* GitHub account (deploy key or account key).
- `~/.gitconfig` is written with the profile's `git_name`/`git_email`.
- Use plain `git@github.com:org/repo.git` remotes — the right key/identity is used
  because there's exactly one per `$HOME`.

> Private repos clone **as that profile user** with its key. If the key isn't on
> GitHub yet, the first run reports the failed clone (it fails fast, doesn't hang) —
> add the key and re-run the playbook (idempotent). `update: false` means re-runs
> never clobber Claude's local edits.

## Projects

Cloned into `/home/<user>/projects/<name>`, `bun install`ed (via mise) when the repo
has a root `package.json` and `install: true`, and any `.env.example` scaffolded to
`.env` (you fill in real secrets).

## Remote-control servers

One server == **one project** (multi-root isn't supported). Each `servers` entry
becomes a systemd service `claude-rc-<user>-<project>` running as that profile's
user. `spawn: worktree` gives each phone session its own git worktree (parallel
tasks don't collide) — up to `capacity` concurrent sessions (this repo defaults to
**4**; Claude's own flag default is 32 — tune to your box's RAM).

## Running dev servers

Provisioning clones + installs but doesn't start long-running dev servers. Start
them persistently (so they survive a closed client):

```bash
ssh admin@<box>
sudo remote-devbox-dev work app                  # mise exec -- bun run dev
sudo remote-devbox-dev work app "bun run dev:web"
```

Preview from your client — see [realtime-sync.md](realtime-sync.md).

## Adding a project or profile later

**Easiest:** from inside the repo on your client, run `devbox add` (or the
`/devbox-add-project` slash command). It detects the repo and inserts BOTH a
`projects:` entry and an always-on Remote Control `servers:` entry into `all.yml`,
then prints the playbook command (`--tags projects,remote`). Pass `--no-server` for
a project with no phone-reachable RC service, or tune it with `--server-name`,
`--spawn`, `--capacity`. `install:` is auto-detected from a root `package.json` — a
repo without one (an Ansible/shell toolkit) gets `install: false`, so the clone
doesn't fail on `bun install`.

**By hand:** edit `all.yml`, re-run the playbook (idempotent + additive). A new
profile creates the user + SSH key (add it to GitHub); a new `servers` entry brings
up its `claude-rc-*` service (online once that profile is logged in). Existing repos
aren't touched (`update: false`).

**Targeted re-runs** (faster, on an already-provisioned box) via tags:

```bash
ansible-playbook playbook.yml --tags projects   # just clone/install new repos
ansible-playbook playbook.yml --tags runtime    # just apply a runtimes: version change
ansible-playbook playbook.yml --tags remote     # just (re)build the claude-rc services
```

## Per-project runtime versions

Beyond the shared `runtimes:`, **each repo's own pin is honored**. After cloning,
the `projects` role runs `mise trust` + `mise -C <repo> install`, so a repo's
`mise.toml`, `.tool-versions`, `.nvmrc`, or `.python-version` gets its versions
installed. mise's directory-aware shims then give that repo the right toolchain —
including for Claude's non-interactive Bash tool (shims resolve per directory).
(Idiomatic files `.nvmrc`/`.python-version` are enabled for node/python in the
system mise config; native `mise.toml`/`.tool-versions` always work.)

## Changing the shared runtime version

Edit `runtimes:` (e.g. `node: "22"`) and re-run (`--tags runtime` is enough). The
shared mise config is re-rendered and `mise install` fetches the new version; mise's
shims make it active immediately — even already-running services pick it up on their
next tool call, no restart. Old versions stay on disk unless you set
`mise_prune: true`.

## Removing a profile or project (opt-in)

Re-runs are **additive** — deleting a profile/server from `all.yml` does **not**
remove it on its own. To clean up, run the opt-in prune (it's excluded from normal
runs):

```bash
ansible-playbook playbook.yml --tags prune        # remove orphaned services only (safe)
ansible-playbook playbook.yml --tags prune -e prune_removed_users=true   # + delete the Linux users (homes KEPT)
ansible-playbook playbook.yml --tags prune -e prune_removed_users=true -e remove_profile_home=true  # + wipe homes (DESTROYS DATA)
```

The default prune removes only orphaned `claude-rc-*` services (re-creatable, no data
loss). Deleting users and especially their home directories (Claude logins, cloned
repos, possibly unpushed work) is gated behind the explicit flags above.

**It only ever touches resources remote-devbox created** — services by the
`claude-rc-*` naming convention, users by a `.remote-devbox-managed` marker. Your
admin user, system users, and hand-made units are invisible to it.

**It asks first.** Before removing anything it prints the exact list of services
(and users) it will remove and waits for you to type `yes`. For non-interactive runs
(e.g. Claude running it for you after you confirmed in chat), pass
`-e prune_assume_yes=true` to skip the prompt.
