# Multiple accounts / profiles

> **A note on multiple accounts — please read first.**
> This is intended for **one situation only**: running **multiple Claude accounts
> that are each separately and legitimately paid for** — e.g. one subscription per
> client, or individual Team/Enterprise seats — on one machine. Each account's
> credentials must belong to and be used by its rightful owner; Anthropic's
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

## How isolation works (v2 — one Linux user per profile)

Each entry in `profiles` is a **separate Linux user**. That gives full OS-level
isolation for free — separate `$HOME`, processes, files, **SSH key + git identity**,
and a separate Claude login in that user's own `~/.claude`:

```
/home/work/.claude        ← profile "work"   (its own login)
/home/personal/.claude    ← profile "personal"
```

No `CLAUDE_CONFIG_DIR` juggling and no shared state — the OS keeps them apart, so
credentials and usage never cross-wire between accounts.

## Login is the one manual step

Remote Control needs a **full-scope claude.ai OAuth login** — `setup-token` /
`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` are **inference-only** and won't
establish Remote Control. So Ansible can't log in for you. After provisioning:

```bash
ssh admin@<box>
sudo remote-devbox-login            # or: sudo remote-devbox-login work personal
```

For each profile it switches to that user and opens `claude`; type `/login`, choose
the **Claude account** option, paste the code, `/exit`. The always-on servers detect
the login within ~15s and come online — no restart needed. (These env vars must not
be set or Remote Control refuses; the run script unsets them: `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/
FOUNDRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`.)

## Shared customizations across profiles

Identity stays per-profile, but you usually want the same skills, subagents,
commands, `CLAUDE.md`, and MCP defs everywhere — that's a separate, deliberate sync
into each profile's `~/.claude`. See [config-sync.md](config-sync.md).

## On your phone

Each profile's sessions appear **only in that account's** session list. In the
Claude mobile app, **switch accounts** to see each profile's servers under the Code
tab. Give each a clear `name:` in its `servers:` entry.

## References

- [Authentication / `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/authentication) · [Remote Control](https://code.claude.com/docs/en/remote-control)
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) · [Usage Policy](https://www.anthropic.com/legal/aup)
- [TechCrunch — 24/7 use & account-sharing as rate-limit targets (2025-07-28)](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/)
- [The Register — OAuth tokens barred from third-party tools (2026-02-20)](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)
