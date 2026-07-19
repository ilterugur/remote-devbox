# Moving a session from your client to the box (`devbox push`)

Start a Claude Code conversation on your client, then continue it **on the box**.
`devbox push` copies the session transcript to the box and rewrites the
client-local absolute paths embedded in it so `claude --resume <id>` works there.

## TL;DR

```bash
# from inside the project, on your client:
devbox push                 # pushes the current session ($CLAUDE_CODE_SESSION_ID)
devbox push --pick          # or fuzzy-pick a recent session
devbox push --go            # push, then jump onto the box and resume in one step
```

Or, from inside an active Claude Code session, run the **`/devbox-push`** slash
command — it previews the target, asks you to confirm, then pushes.

Then on the box:

```bash
devbox <project> --shell
claude --resume <id>
```

## How a session is stored (why a plain copy isn't enough)

A session is `~/.claude/projects/<encoded-cwd>/<id>.jsonl` — plus a sibling
`<id>/` directory (subagent transcripts, workflow scripts, large tool outputs)
when the session spawned subagents. The encoded dir name is the absolute working
directory with every `/` and `.` turned into `-`.

The transcript embeds your client's absolute paths (the project root, file reads,
the encoded-dir token in shell commands). On the box those paths don't exist, so
`devbox push` rewrites them:

- the **project root** `…/<project>` → `/home/<profile>/projects/<project>` (and
  its dash-encoded form), always;
- extra mappings via `--map OLD=NEW` (repeatable);
- the client home `/Users/<you>` → `/home/<profile>` only with `--remap-home`
  (off by default — your client username differs from the profile name, and
  `~/.claude` paths differ on the box).

The matching box profile/project is derived from your git `origin` (the same way
`devbox` auto-opens a project).

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <id>` | session to push (default: `$CLAUDE_CODE_SESSION_ID`, else the newest in `$PWD`) |
| `--pick` | fuzzy-pick a recent session for this project |
| `-p, --profile <p>` `[project]` | target explicitly (required when `origin` isn't in config or matches several profiles) |
| `--remote-cwd <dir>` | override the remote project root (required for a git **worktree** source) |
| `--map OLD=NEW` | extra path rewrite (repeatable) |
| `--remap-home` | also remap `/Users/<you>` → `/home/<profile>` |
| `--no-sidecar` | don't transfer the `<id>/` sidecar dir |
| `--go` | after push, connect and `claude --resume` on the box |
| `--yes` | skip the confirmation prompt |
| `--force` | overwrite even if the remote copy is live or newer |

`DEVBOX_DRYRUN=1 devbox push …` prints the resolved target, the full mapping list,
a rewrite preview, and the remote commands — and writes nothing.

## Safety

- **Confirmation** — push prints the target (`host:remote-path`) and the mapping
  and asks before writing (`--yes` to skip). Targeting **fails closed**: if your
  `origin` isn't in any profile's config, or matches more than one, push refuses
  and asks for `--profile`. It never falls back to the active profile (that would
  leak a session into the wrong account).
- **Backup** — an existing remote `<id>.jsonl` is copied to `<id>.jsonl.bak-<ts>`
  before it's overwritten.
- **Liveness** — push refuses if a tmux session for the project is attached on the
  box, or if the remote copy is newer than your local one (it diverged). Use
  `--force` to override.
- The pushed file is written `chmod 600` under the profile's own `~/.claude`. It
  is **not** part of config-sync (which deliberately never touches `projects/`),
  so a later `remote-config-apply` / playbook run won't delete it.

## ⚠️ It's a fork, not a sync

After a push, the client copy and the box copy are **independent**. Your client
session keeps growing on its own; edits on the box don't flow back, and vice
versa. Pick one place to continue. `--go` resumes on the box immediately — treat
the client session as read-only afterwards. (For a live shared workspace instead
of a handoff, use Remote-SSH — see [realtime-sync.md](realtime-sync.md).)

For the box to be useful after resume, the project must already be checked out
there (`/home/<profile>/projects/<project>`) — `devbox push` moves the
conversation, not the working tree.
