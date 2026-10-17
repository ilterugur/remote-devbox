# Multiple accounts / profiles

> **A note on multiple accounts — please read first.**
> This is intended for **one situation only**: running **multiple Claude accounts
> that are each separately and legitimately paid for** — e.g. one subscription per
> client, or individual Team/Enterprise seats. Each account's credentials must
> belong to and be used by its rightful owner; Anthropic's
> [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) prohibit sharing
> your login or credentials with anyone else.
>
> **Do not** use this to get around the rate limits of a single account, to pool or
> stretch one person's quota, or to resell/share access — Anthropic treats that as a
> usage-policy violation and actively enforces it. **Use Claude Code (or claude.ai)
> directly**; as of Feb 2026 OAuth tokens from Free/Pro/Max accounts may not be used
> in other tools/SDKs. Running Claude Code "continuously 24/7" has itself been cited
> as a rate-limit target. This is a summary, not legal advice — see the
> [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and
> [Usage Policy](https://www.anthropic.com/legal/aup).
>
> **The swap here is manual, and stays manual.** This repo ships no
> usage-triggered switching, no 429 fallback, no rotation hook, and nothing that
> reads a quota and picks an account. You name the account; the tool moves one
> credential. That is a deliberate, permanent boundary, not a missing feature.

## How isolation works (one config tree per profile)

Each agent profile gets its own config dir — `/home/<user>/.agent-profiles/<profile>` —
and the profile wrapper `/home/<user>/.local/bin/<profile>` exports the provider's
config-dir env into it (`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex,
`PI_CODING_AGENT_DIR` for omp).

The always-on Remote Control units now set that **same** env. Before that they fell
back to `$HOME/.claude`, so `/login` wrote the profile dir while the phone-facing
server read `~/.claude`: two trees, no bridge, and the phone ran a different account
than your terminal. One env line per unit fixed it — `/login`, interactive sessions
and the RC server share one tree.

**Upgrading an existing box:** the first `devbox apply` after this change repoints each
`agent-rc-claude-*` unit at its profile dir, so an RC server that was running on the old
`~/.claude` login now uses whatever `/login` put in the profile dir. If a unit reports
`not logged in — run: sudo remote-devbox-login`, that profile simply never had its own
login: do it once (`ssh -t <box> 'sudo remote-devbox-login <dev> <profile>'`) and the
server picks it up within ~15s. The stale `~/.claude` tree is left alone.

## Two accounts, one tree

Per (developer, Claude profile) there is exactly **one** config tree. MCP servers,
skills, settings, plugins and `projects/` session history live there once, so both
accounts share them — no copies, no sync machinery, and no symlinks (auto-update
wipes symlinked skill dirs, [#50052](https://github.com/anthropics/claude-code/issues/50052);
see [config-sync.md](config-sync.md) for why the portable subset is copied).

An account is only a small parked triple in `$HOME/.claude-accounts`:

- the account-scoped keys of `.claude.json` — `userID`, `oauthAccount`,
  `modelAccessCache`, `orgModelDefaultCache`, `passesEligibilityCache`,
  `s1mAccessCache`, `cachedStatsigGates`;
- the credential payload — `<cfg>/.credentials.json` on Linux, the login-keychain
  item `Claude Code-credentials` on macOS;
- a registry entry in `accounts.json` (label, email/org, which one is active).

Restore is **set-or-delete**: a key present in the target's `identity.json` is
written, a key *absent* there is removed from `.claude.json`. Copying
`oauthAccount` alone would leave the previous account's entitlement caches behind —
that is how a swapped session ends up with the wrong model access.

## Personal Max/Pro and Team workspace (same email)

Claude Code can bill a **Team or Enterprise** seat from the same claude.ai login you
use for a personal Max/Pro org. Anthropic still stores one global credential tree;
picking the org happens during `/login` when you authorize the Team workspace.

Park each org under its own label — `max` and `team` are common — then swap with
`devbox account use` **only when those orgs do not share a live Remote Control
tree**. Same-email personal Max and Team **with always-on RC** belong on **two
Claude profiles**, not two labels on one tree:

```yaml
agent_profiles:
  claude-main: { provider: claude }       # Team RC, default
  claude-personal: { provider: claude }   # personal Max; no projects → no RC unit
```

```bash
# Team stays the default launcher + phone RC:
ssh -t <box> 'sudo remote-devbox-login dev-a claude-main'     # pick the Team org
ssh -t <box> 'sudo remote-devbox-account dev-a claude-main add team'

# Personal is a second wrapper, its own CLAUDE_CONFIG_DIR and vault:
ssh -t <box> 'sudo remote-devbox-login dev-a claude-personal' # pick personal Max
ssh -t <box> 'sudo remote-devbox-account dev-a claude-personal add max'
# interactive personal:  claude-personal
```

Each profile vault is `$HOME/.claude-accounts/<profile>`. A relocated
`CLAUDE_CONFIG_DIR` uses the **file** credential store even on macOS, because the
login keychain is a single `Claude Code-credentials` item.

`devbox account ls` shows the org name and a `[team]` / `[max]` badge. The registry
tracks `organizationUuid` as well as `accountUuid`, so a `/login` that only changed
the Team org triggers the “tree holds … but registry says …” warning until you
`add team` (or `use max` if personal was already parked).

**Live Remote Control on a tree wins the org.** Always-on `claude remote-control`
writes `oauthAccount` from the cloud session into that profile's `.claude.json`
every few seconds. `devbox account use max` on the **same** profile then looks like
it worked (`now using 'max'`) and `/status` shows Team again. `--force` does not
change that race. Restarting the units is not enough either: they resume the
existing Team sessions and write Team back. That is why personal Max and Team RC
are two profiles.

omp / Paseo is a separate database. `devbox-account use` (and `sudo
remote-devbox-account`) **pins** omp to the parked label's email + org. Set
`DEVBOX_ACCOUNT_OMP_PIN=0` to leave omp alone — e.g. Team Claude RC with personal
omp. The pin only flips `disabled_cause`; it never writes a token.

## Setup walkthrough

On the box, log in as the first account, adopt it under a label, then `/login` again
as the second:

```bash
ssh -t <box> 'sudo remote-devbox-login dev-a claude-main'                 # /login, account #1
ssh -t <box> 'sudo remote-devbox-account dev-a claude-main add work'
ssh -t <box> 'sudo remote-devbox-login dev-a claude-main'                 # /login, account #2
ssh -t <box> 'sudo remote-devbox-account dev-a claude-main add personal'
ssh -t <box> 'sudo remote-devbox-account dev-a claude-main use personal'  # the swap
```

`use` restarts **that profile's** `agent-rc-*` units only. A personal profile with
no projects has nothing to restart; Team RC on `claude-main` is left alone. `add`
never drives OAuth — it captures whatever is logged in *now*.

**On the box, as the developer (no sudo, no laptop):**

```bash
devbox-account ls
devbox-account status
devbox-account use team          # Claude Code + omp → Verti (or whatever `team` is)
devbox-account use ugur          # Claude Code + omp → personal Max
devbox account use team          # same, once the box CLI has been applied
```

Quit any `claude` session that is using that profile first — a live session rewrites
the org back. A leftover `claude` on `~/.claude` does not block `claude-main`. omp is
pinned to the same email + org unless `DEVBOX_ACCOUNT_OMP_PIN=0`. Restarting phone
Remote Control still needs the operator (`sudo remote-devbox-account`).

On your Mac the same verbs run against your local `~/.claude` (and, with
`CLAUDE_CONFIG_DIR`, a second local tree):

```bash
devbox account add team            # adopt the account currently logged in
devbox account use team            # the swap on this tree
devbox account ls                  # labels, email/org, which is active
devbox account status              # active label + what the tree actually holds
devbox account rm work             # forget a parked account (the tree is untouched)
devbox account gc --keep 3         # prune old backups on demand
devbox account use team -p dev-a   # box claude-main (default --agent-profile)
devbox account ls -p dev-a --agent-profile claude-personal
```

macOS asks for keychain access the first time; answer **Always Allow** and later
swaps are silent.

## Guardrails and costs

- **Refused while `claude` runs** — `~/.claude.json` is rewritten constantly and
  concurrent writes corrupt it
  ([#28992](https://github.com/anthropics/claude-code/issues/28992)), so there is no
  mid-session swap. `--force` overrides for the operator who knows better.
- **Lock + atomic writes.** The whole swap runs under one lock; `.claude.json`,
  the credential file and the registry are written temp-then-rename.
- **A label only holds a token for its own org.** `add`, and the park step of
  `use`, ask the token which org it bills (read-only `GET /api/oauth/profile`)
  and compare it with the `organizationUuid` in `.claude.json`. Same-email
  personal Max + Team makes these drift apart: a live session or a half-finished
  `/login` leaves a Team token under the personal identity, and `use max` then
  restores Team every time. On a mismatch `add` refuses and parks nothing;
  `use` keeps the label's last good pair, moves the mismatched one to
  `.backups/<ts>-<label>-mismatch`, warns, and carries on with the swap. If the
  check cannot run (offline, expired token), it warns and parks anyway.
- **Backups are kilobytes.** Only the parked triple is snapshotted, never the
  `~/.claude` tree. Retention is count-based —
  `DEVBOX_ACCOUNT_BACKUP_KEEP`, default **3** — pruned on every swap.
- **No token refresh here.** Refresh stays with `claude` itself
  (`claude auth status`); no private OAuth endpoint is ever replayed.
- **One RC server, one account at a time.** The mobile app's session list is
  account-scoped, so the other account's sessions aren't listed until you swap
  back. Seeing both at once would mean two trees — i.e. giving up the shared
  config this exists to provide.
- **Usage/cost stats mix** in the single tree; per-account quota comes from
  `claude auth status` / `omp usage`, not local stats.

## omp profiles

omp is already multi-account: `~/.agent-profiles/<profile>/agent.db` holds one
`auth_credentials` row per `identity_key`, so several Anthropic logins sit side by
side. Add the second one with `/login anthropic` inside omp and list them with
`omp token anthropic --list`.

`devbox account use <label>` — locally, on the box (`devbox-account`), and via
`sudo remote-devbox-account` — **pins** the omp row matching the label's email +
`organizationUuid` and disables the others, unless `DEVBOX_ACCOUNT_OMP_PIN=0`.
The pin only flips `disabled_cause`; it never writes a token. omp logs each org
in itself (`omp login anthropic`, choosing the org on the consent screen), and
omp keys the row by the org the token was actually issued for. If that row is
missing, the Claude swap still succeeds and a warning tells you to log in, then
`use` again. Round-robin / quota rotation is still **not** used: you pick the
account.

Why no token copy: a parked label's `identity.json` and its credential are captured
separately, so with one email on personal Max and Team the label can say “personal”
while holding a Team token. Copied into omp, that token sat under the personal row
and billed Team. A refresh token held by both Claude Code and omp also dies on the
first rotation by either. `omp usage` prints the stored row's org name, not the
token's; ask the token which org it bills:

```bash
curl -s https://api.anthropic.com/api/oauth/profile \
  -H "Authorization: Bearer $(omp token anthropic)" -H 'anthropic-beta: oauth-2025-04-20' \
  | jq -r '.organization | "\(.name) \(.organization_type)"'   # want: … claude_max
```

## References

- [Authentication / `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/authentication) · [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) · [Usage Policy](https://www.anthropic.com/legal/aup)
- [TechCrunch — 24/7 use & account-sharing as rate-limit targets (2025-07-28)](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/)
- [The Register — OAuth tokens barred from third-party tools (2026-02-20)](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)
- Symlinked skills wiped by auto-update: [#50052](https://github.com/anthropics/claude-code/issues/50052) · `~/.claude.json` concurrent-write corruption: [#28992](https://github.com/anthropics/claude-code/issues/28992)
- Design: [specs/2026-09-04-claude-account-swap-design.md](superpowers/specs/2026-09-04-claude-account-swap-design.md) · shared config: [config-sync.md](config-sync.md)
