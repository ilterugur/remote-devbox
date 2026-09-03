# File bridge

Make client files available to the box. Two mechanisms:

## Lazy mount (read-only, while the client is online)

Declare paths under the developer's `file_bridge` in `devbox.yml`:

```yaml
file_bridge:
  lazy_mounts:
    - { label: desktop, path: "~/Desktop" }
  lazy_mount_on_connect: true
```

Independent of the sync disk below — either works without the other. Each label becomes
the box directory `~/mnt/<label>`, so labels must be usable as filenames and must not
repeat, and two mounted paths may not nest inside one another.

Re-run `devbox apply` (or fetch a fresh client config from the box) to propagate them,
then:

```
devbox mount up        # serve + mount the configured paths
devbox mount status    # show live mounts
devbox mount down      # tear them down
```

On the box they appear read-only at `/home/<profile>/mnt/<label>/`, full-depth. They are a **live
window**: when the client sleeps they go away. For files that must survive the client being closed,
use the sync disk (below).

How it works: a client-side `rclone serve sftp` (jailed to the path, `--read-only`) is reached by
the box through an `ssh -R` reverse tunnel and mounted with `sshfs`. Nothing inbound is opened on
the client; an ephemeral per-mount SSH key keeps the localhost tunnel port private to your profile.

> `/mnt` = transient read-only window (don't author work there, may disappear).
> `/sync` and `/projects` = durable working copies.

## Sync disk (two-way, survives the client being closed)

Enable per profile in `group_vars`:

```yaml
sync_disk: true
sync_engine: mutagen     # default
```

Re-run `devbox apply`, install Mutagen on the client
(`brew install mutagen-io/mutagen/mutagen`), then:

```
devbox sync up        # start the two-way disk (~/devbox/<profile> <-> box /home/<profile>/sync)
devbox sync status    # sessions + conflict counts
devbox sync pause / devbox sync resume
devbox sync down      # stop syncing (box copy stays on disk)
```

Drag folders into `~/devbox/<profile>/` like a normal disk. They appear on the box at
`/home/<profile>/sync/` and stay there when the client sleeps. Conflicts are surfaced by
`devbox sync status` and resolved manually (no auto-merge). Never synced: VCS (`.git`), build/dep
dirs (`node_modules`, `dist`, `build`, `.next`, `target`), and OS/editor cruft (`.DS_Store`, `._*`,
`.Spotlight-V100`, `.Trashes`, `Thumbs.db`, `desktop.ini`, `*.swp`). Changing the ignore set means
recreating the session (`devbox sync down && devbox sync up`). Keep git history on the box as your
real undo.

`devbox sync up` also hands the client-side Mutagen daemon to launchd (`mutagen daemon
register` + `io.mutagen.mutagen`), so the disk syncs again after a reboot without anyone
typing a command. That matters because nothing complains when it is missing: an
unsupervised daemon simply stops at logout, and the next mutagen command starts one and
makes the gap invisible. `devbox doctor` therefore reports the supervisor as its own
evidence line — a session that is syncing right now but whose daemon is not registered
is `degraded` (`sync_autostart_unregistered`), and `devbox recover client.sync.<profile>`
installs it.

### Using Syncthing instead of Mutagen

Set `sync_engine: syncthing` for the profile, re-run the playbook with `--tags syncthing`
(provisions the per-profile box instance), install Syncthing on the client (`brew install
syncthing` + `brew services start syncthing`), then `devbox sync up` as usual. The CLI pairs the
two devices and shares the single folder over the REST API (client directly; box via an ephemeral
`ssh -L` tunnel). Peers connect over Tailscale only — global/local discovery, relays, and NAT are
disabled and the listener is pinned to the box's Tailscale IP.

Conflicts: Syncthing writes `*.sync-conflict-*` files and keeps deleted/replaced copies under
`.stversions` (Trash-Can versioning on both peers). `devbox sync status` shows folder state; use
the Syncthing GUI for per-file conflict detail.

## App configs (connection records)

Keep application connection records — FileZilla sites, `~/.ssh/config`, DB client
entries — identical on the client and the box. The real files move into the sync
disk (under `.app-configs/` at its root); the paths each app reads become links
into it. This rides on the sync disk above, so `file_bridge.sync_disk: true` is a
hard requirement.

```yaml
developers:
  - user: work
    file_bridge:
      sync_disk: true
    app_configs:
      enabled: true
      paths:
        - filezilla
        - ssh_config
        - label: dbeaver
          client: "~/Library/DBeaverData/workspace6/General/.dbeaver"
          box: "~/.local/share/DBeaverData/workspace6/General/.dbeaver"
          mode: dir
```

A string is a registry key; an object is a full definition (and overrides a registry
key of the same label). `app_configs.enabled: true` requires `file_bridge.sync_disk:
true` — `devbox plan` rejects it otherwise, since there is nowhere to link to. The
registry currently has two entries:

| key | client path | box path | mode | excludes |
| --- | --- | --- | --- | --- |
| `filezilla` | `~/.config/filezilla` | `~/.config/filezilla` | `dir` | `queue.sqlite3`, `lockfile`, `*.lock` |
| `ssh_config` | `~/.ssh/config` | `~/.ssh/config` | `ssh-include` | — |

`ssh_config` never symlinks `~/.ssh/config` itself: it inserts a marked `Include`
block at the top of the file, pointing at the synced copy, and leaves the rest of
the file (and everything else in `~/.ssh/`) alone. That is also why keys,
`authorized_keys` and `known_hosts` are never touched — they are not part of this
entry. A custom entry can also use `mode: file` for a single flat file.

Then, per profile:

```
devbox sync up            # the store lives in the sync disk
devbox config link        # links the declared paths into it
devbox config status      # per-entry client/box/store state, plus sync health
devbox config unlink      # restore real files on both sides, remove the links
```

`devbox config link` and `unlink` take `-p/--profile`. `link` also takes
`--from-client` (non-interactive: the client always wins when it has to ask);
`unlink` takes `--label <label>` to restore a single entry instead of everything
declared. `DEVBOX_DRYRUN=1 devbox config link` previews the per-entry decision
without touching either side.

### The link decision

`devbox config link` only proceeds silently when there is nothing to lose; the
moment a real choice exists, it stops and asks. Already-linked entries on both
sides are a no-op, and an existing link that points somewhere unexpected (not at
this feature's store) makes it refuse and tell you to resolve it by hand rather
than guess. Otherwise:

- **Fresh store, nothing to lose** — only one side has content, or neither does:
  it uses whichever side has content, or seeds an empty store if both are bare.
- **Fresh store, both sides already have unlinked content** — the ordinary case
  for anyone adopting this after already using FileZilla or SSH on both the Mac
  and the box: it stops and asks which side wins, since linking either way would
  silently make the other side's content unreadable by the app.
- **Store already seeded, and anything beyond a fully bare pair** — a real
  synced copy exists, and either side still has unlinked content of its own.
  This is what protects a **second client machine** joining an existing profile:
  a fully bare pair (nothing there, or already pointing at the store) links
  straight to the existing synced copy with nothing to choose, but any unlinked
  content on the new machine (or the box) makes it ask instead of silently
  overwriting the shared copy.

`--from-client` skips the prompt by always choosing the client, which is useful
in scripts but means you should only pass it when you are sure the client's copy
is the one you want to keep.

⚠️ **Do not run the same app on both sides at once.** These are whole-file XML/INI
configs — there is no merge. The last writer wins; conflicts surface in
`devbox sync status` (Syncthing also keeps `.stversions` copies, Mutagen does not).

⚠️ **`devbox sync down` stops propagation.** The links and their targets stay, so
apps keep working against the box-side copy; edits simply stop crossing.

### `devbox config status`

Reads state on both sides without changing anything, and calls out the failure
modes that otherwise look fine at a glance:

- **sync not running** — the session for this profile doesn't exist: edits are not
  propagating even though everything still looks linked (`devbox sync up`).
- **sync paused** — the session exists but is paused or disconnected, same effect
  (`devbox sync resume`).
- **a link whose target is missing** — the client-side link exists but the file it
  points at inside the store is gone, so the app would just write a fresh empty
  config the next time it starts.

### `devbox config unlink`

Restores real files on the client (and, via the box-side helper, on the box) and
removes the link — but the exact behavior when the store payload backing a link
is missing differs by mode, because for `dir`/`file` there might still be
something to put back later, while for `ssh-include` there provably is not:

- **`dir` / `file`** — leaves the link untouched and reports the failure, rather
  than deleting it and finding nothing to restore in its place.
- **`ssh-include`** — the host entries lived only in the missing payload, so
  there is nothing to recover either way, and leaving the `Include` line
  pointing at a nonexistent file would make OpenSSH fail to parse the rest of
  `~/.ssh/config`. It removes the managed block instead (the rest of the file is
  preserved) and reports the host entries as unrecoverable.

In both cases no success marker is printed for an entry that could not be fully
restored. The synced copies under `.app-configs/` in the sync disk are left
behind on purpose; delete them by hand once you're sure you don't need them.

Never synced: SSH private keys, `authorized_keys`, `known_hosts`. FileZilla's
`queue.sqlite3` (the machine-local transfer queue — syncing SQLite corrupts it) and its
`lockfile` (the single-instance marker) are excluded too.

An entry's `excludes` apply in two places: the first seed skips them, **and** they are
folded into the sync session's ignore list as `/.app-configs/<label>/<pattern>`. Both are
needed — once linked, the app writes straight into the store, so a seed-only exclude would
let the same file reappear and propagate on the next run. Changing the exclude set means
recreating the session: `devbox sync down && devbox sync up`.

**Passwords:** FileZilla stores site passwords base64-encoded in `sitemanager.xml` —
effectively plain text. On the box that file sits under `/home/<user>/sync` with
`umask 077`, so other developers cannot read it, but root can. Either enable
FileZilla's master password (same password on both sides) or use it without saved
passwords and share only the site list.

`mode: file` is allowed for custom entries but risky: an app that writes its config
atomically (temp file + rename, a common pattern) can end up replacing the symlink
itself with a plain file, silently breaking the link. Prefer `dir` when the app
supports pointing at a directory.

If `devbox config link` refuses an entry with "an existing link points somewhere
else", the client or box path is already a symlink to something outside this
feature's store (leftover from a different tool, or a stale manual symlink) —
resolve or remove it by hand, then re-run `link`.

## Troubleshooting: Mutagen "agent ... Permission denied" on a hardened box

On boxes whose OpenSSH 9+ `scp` transfers via SFTP, a plain `scp` drops the file's execute
bit (a 755 source lands 644), so Mutagen's auto-copied agent can't run:

```
unable to install agent: ... /bin/bash: line 1: ./.mutagen-agentXXXX: Permission denied
```

Fix: pre-stage the agent once (it matches the client's Mutagen version), then `devbox sync up`
works because Mutagen finds the existing agent and skips the copy. From the client:

```sh
ver=$(mutagen version)                       # e.g. 0.18.1
tmp=$(mktemp -d); tar xzf "$(brew --prefix)/Cellar/mutagen/$ver/libexec/mutagen-agents.tar.gz" -C "$tmp"
ssh <prefix>-<profile> "mkdir -p ~/.mutagen/agents/$ver"
scp "$tmp/linux_amd64" <prefix>-<profile>:~/.mutagen/agents/$ver/mutagen-agent
ssh <prefix>-<profile> "chmod +x ~/.mutagen/agents/$ver/mutagen-agent"   # scp dropped +x
```
