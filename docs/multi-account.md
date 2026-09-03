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

`use` also restarts that developer's `agent-rc-*` units, so the phone follows the
new account. `add` never drives OAuth — it captures whatever is logged in *now*.

On your Mac the same verbs run against your local `~/.claude`:

```bash
devbox account add work            # adopt the account currently logged in
devbox account use personal        # the swap
devbox account ls                  # labels, email/org, which is active
devbox account status              # active label + what the tree actually holds
devbox account rm work             # forget a parked account (the tree is untouched)
devbox account gc --keep 3         # prune old backups on demand
devbox account use personal -p dev-a    # same verbs on the box (--agent-profile
                                        #   defaults to claude-main)
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

A `devbox account use <label>` then **pins** omp to the matching email: it
clears `disabled_cause` on that Anthropic OAuth row and sets it on the others.
Local `use` pins local `~/.agent-profiles/omp-*/agent.db`; `-p` pins the
developer's omp trees on the box. No token is copied — Anthropic forbids driving
a Claude Code subscription token from another tool, so omp must have logged that
account in itself. If the email is not in `agent.db`, the Claude swap still
succeeds and a warning tells you to `/login anthropic` then `use` again.
`DEVBOX_ACCOUNT_OMP_PIN=0` skips the pin. Round-robin / quota rotation is still
**not** used: you pick the account.

## References

- [Authentication / `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/authentication) · [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) · [Usage Policy](https://www.anthropic.com/legal/aup)
- [TechCrunch — 24/7 use & account-sharing as rate-limit targets (2025-07-28)](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/)
- [The Register — OAuth tokens barred from third-party tools (2026-02-20)](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)
- Symlinked skills wiped by auto-update: [#50052](https://github.com/anthropics/claude-code/issues/50052) · `~/.claude.json` concurrent-write corruption: [#28992](https://github.com/anthropics/claude-code/issues/28992)
- Design: [specs/2026-09-04-claude-account-swap-design.md](superpowers/specs/2026-09-04-claude-account-swap-design.md) · shared config: [config-sync.md](config-sync.md)
