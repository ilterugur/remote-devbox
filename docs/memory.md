# Long-term memory (Hindsight)

## What it is

**Hindsight** is a long-term memory layer for Claude Code. The `hindsight` role
wires [Vectorize Hindsight](https://github.com/vectorize-io/hindsight) into each
profile so the agent remembers things across sessions — context from past work,
decisions made, patterns it noticed — without any manual note-taking.

The role is **on by default**. To opt a profile out entirely, set:

```yaml
hindsight_enabled: false
```

in `group_vars/all.yml` (or per-profile in the `profiles` list).

---

## How it works

Three pieces cooperate once provisioning runs:

1. **Recall hook (UserPromptSubmit)** — before each prompt, the plugin queries
   the memory bank and injects relevant snippets as context. The agent sees
   what's relevant before it replies.

2. **Retain hook (Stop, custom)** — after each session, `/usr/local/bin/hindsight-retain-tagged`
   runs. It calls the plugin's retain path and stamps every saved memory with
   three automatic tags (see [Memory model](#memory-model) below). The plugin's
   own auto-retain is disabled so retention fires exactly once, via this hook.

3. **`agent_knowledge_*` tools** — `enableKnowledgeTools: true` exposes a small
   set of MCP tools the agent can call directly during a session: create, search,
   and delete memories. Useful for explicit "remember this" or "forget that"
   instructions, or for filtered recall (e.g. query restricted to a single project).

Underneath all of this runs a **local daemon** (`uvx hindsight-embed`, the plugin's default
port 9077), one per profile. It stores memories on disk. **By default only LLM extraction
and recall calls leave the box** — embeddings are computed **locally** with the daemon's
built-in model, so memory text stays on the box. This is the default and the recommended
posture. You *can* point the embedder (or reranker) at a remote provider — see
[Splitting providers](#splitting-providers) — but doing so sends memory text to that
provider, so it's a deliberate opt-in, not the default.

---

## Networking & access

By default the daemon is **loopback-only** (`127.0.0.1`). It is reachable only
by the agent process running on the same box — not reachable from the network,
not exposed on Tailscale, not public in any way.

### Per-profile ports (`hindsight_base_port`)

Each profile gets its own daemon instance. To avoid port collisions when
multiple profiles coexist on one box, ports are allocated as
`base + profile_index`:

| Profile index | Default port |
| ------------- | ------------ |
| 0 (first)     | 9077         |
| 1 (second)    | 9078         |
| …             | …            |

The base is controlled by:

```yaml
hindsight_base_port: 9077   # default
```

A single-profile setup simply stays on `9077` and never notices the scheme.

### Optional Tailscale exposure (`hindsight_expose_tailscale`)

If you want to query or browse the memory daemon from another machine on your
**tailnet** (e.g. your laptop browsing memory from the devbox), set:

```yaml
hindsight_expose_tailscale: true
hindsight_serve_https_port: 9443    # default; HTTPS port = serve_port + index
```

When enabled, provisioning publishes each profile's loopback daemon through
**Tailscale Serve**:

```
https://<node>.<tailnet>.ts.net:(serve_port + index)  ->  127.0.0.1:(base + index)
```

so it's reachable over your tailnet **by hostname with a valid TLS cert**
(e.g. `https://devbox.tail1234.ts.net:9443`). Tailscale Serve is tailnet-gated by
Tailscale itself — the daemon stays bound to `127.0.0.1` and nothing is opened on
a public interface (no `0.0.0.0` bind, no firewall rule needed).

Access is therefore **tailnet-only** — it relies on the user's Tailscale ACLs
for fine-grained control. The daemon itself has no authentication layer;
security comes entirely from Tailscale Serve's tailnet gating and your ACL policy.

This option is **off by default** (`hindsight_expose_tailscale: false`).

---

## Memory model

Each profile gets **one profile-wide memory bank** (the `bankId` is the profile's
Linux username). It's intentionally not per-project: Hindsight is meant as a
personal-assistant layer that accumulates continuity across all your projects over
time, not an isolated per-conversation scratchpad. This mirrors how a team
(example-monorepo) uses Hindsight — a single user-scoped bank with tag-based
filtering rather than per-project silos.

Every retained memory is auto-tagged:

| Tag | Value | Purpose |
| --- | --- | --- |
| `source` | `claude-code` / `hermes` / `codex` | identifies the origin client |
| `project` | `<repo name>` | which repo (worktree-aware; empty for cross-project facts) |

There is intentionally **no `profile` tag**: the bank is already per-profile (its `bankId`
is the profile's username), so a profile tag would just duplicate the bank identity. The
`source` tag is the useful discriminator inside the shared bank — it separates Claude Code,
Hermes, and Codex memories. These tags let you filter later using the `agent_knowledge_*`
tools: e.g. recall only a specific repo's memories by searching `project:<repo>`, or only
Hermes-written ones with `source:hermes`. The tools accept tag filters directly.

### Per-project isolation (escape hatch)

If you genuinely want a separate bank per project — sacrificing cross-project
continuity — set:

```yaml
hindsight_per_project: true
```

This switches the `bankId` to a per-project value and skips the custom tagging
hook. Default is `false`.

---

## Provider configuration

Hindsight needs an LLM for the extraction and recall steps. Configure it in
`group_vars/all.yml` via these knobs (they map to the `HINDSIGHT_API_LLM_*`
environment variables written to `~/.hindsight/llm.env`, mode 0600):

| Variable | Purpose |
| --- | --- |
| `hindsight_llm_provider` | Provider name: `openai`, `anthropic`, `gemini`, `groq`, `ollama`, `openrouter`, … |
| `hindsight_llm_api_key` | API key (required unless the provider is keyless or a `base_url` is set) |
| `hindsight_llm_model` | Model identifier, in the provider's format |
| `hindsight_llm_base_url` | Optional — custom OpenAI-compatible endpoint |

**Example — OpenRouter** (cheap, many models, one key):

```yaml
hindsight_llm_provider: openrouter
hindsight_llm_api_key: "sk-or-..."
hindsight_llm_model: "openai/gpt-oss-20b"
```

**Example — Ollama** (fully keyless, fully local):

```yaml
hindsight_llm_provider: ollama
hindsight_llm_base_url: "http://localhost:11434"
hindsight_llm_model: "llama3.2"
# hindsight_llm_api_key not needed
```

**Example — OpenAI Codex OAuth** (keyless — reuses the box's `~/.codex/auth.json`
session, no per-token spend):

```yaml
hindsight_llm_provider: openai-codex
hindsight_llm_model: "gpt-5.4-mini"
# hindsight_llm_api_key not needed
```

> **Codex OAuth covers the LLM only — not embeddings.** The same token is accepted by
> `api.openai.com/v1/embeddings` but a ChatGPT/Codex subscription carries no platform
> quota, so `HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai-codex` fails with
> `429 insufficient_quota` unless the account also has pay-as-you-go platform credit.
> Pair a codex LLM with the local embedder or a real embeddings provider (see below).

The playbook fails fast at provision time if `hindsight_enabled: true` but no
provider/key is configured (and there is no `base_url` to substitute) — better
to catch it early than have the daemon silently fail at runtime.

### Splitting providers

The default LLM above is used by **every** memory operation. Hindsight also lets each
capability run on a **different** provider — a cheap model for one operation and a strong
one for another, a dedicated embedder, an optional reranker. All of these render into the
same `~/.hindsight/llm.env` (0600) that the daemon inherits; everything is optional and
unset by default (single LLM, local embedder, no reranker). **Restart the daemon after
changing any of these on a live box** — it persists (`daemonIdleTimeout: 0`) and won't
re-read the env until restarted.

| Variable | Shape | Maps to | Purpose |
| --- | --- | --- | --- |
| `hindsight_llm_max_concurrent` | scalar | `HINDSIGHT_API_LLM_MAX_CONCURRENT` | concurrency cap for the default LLM |
| `hindsight_retain_llm` | `{provider, model, api_key, base_url}` | `HINDSIGHT_API_RETAIN_LLM_*` | override the LLM for the **retain** (extraction) step only |
| `hindsight_reflect_llm` | same | `HINDSIGHT_API_REFLECT_LLM_*` | override the LLM for the **reflect** (recall) step only |
| `hindsight_consolidation_llm` | same | `HINDSIGHT_API_CONSOLIDATION_LLM_*` | override the LLM for the **consolidation** (observations) step only |
| `hindsight_embeddings` | `{provider, model, api_key, base_url}` | `HINDSIGHT_API_EMBEDDINGS_PROVIDER` + `HINDSIGHT_API_EMBEDDINGS_<PROVIDER>_*` | swap the embedder. Empty = built-in **local** embedder (on-box). A remote provider **sends memory text off the box**. |
| `hindsight_reranker` | `{provider, model, api_key, base_url, max_candidates}` | `HINDSIGHT_API_RERANKER_PROVIDER` + `HINDSIGHT_API_RERANKER_<PROVIDER>_*` | add a reranker over recall candidates (e.g. Cohere) |
| `hindsight_text_search_extension` | scalar | `HINDSIGHT_API_TEXT_SEARCH_EXTENSION` | lexical-search backend (`native`/`pgroonga`/`pg_search`/…) |
| `hindsight_vector_extension` | scalar | `HINDSIGHT_API_VECTOR_EXTENSION` | vector backend (`pgvector`/`vchord`/…) |
| `hindsight_extra_env` | map | verbatim | raw `HINDSIGHT_API_*` key→value escape hatch for knobs without a dedicated var |

The `embeddings`/`reranker` keys are **provider-scoped** — Hindsight reads
`HINDSIGHT_API_EMBEDDINGS_<PROVIDER>_MODEL` (etc.), so the template emits the provider name
in the key. Hindsight ships first-class providers for both: embeddings via `local`, `onnx`,
`openai`, `openrouter`, `cohere`, `google`, `zeroentropy`, `tei`, `litellm`, `vertexai`;
rerankers via `local`, `cohere`, `openrouter`, `siliconflow`, `alibaba`, `google`,
`zeroentropy`, `jina-mlx`, `litellm`, `rrf`. **OpenRouter serves both** embeddings and
rerankers (`POST /api/v1/rerank`), so one OpenRouter key can drive the LLM, the embedder,
and the reranker. Providers with a different parameter shape — notably the **local `onnx`**
embedder (`HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID`, `_DIMENSIONS`, `_QUERY_PREFIX`, …) —
don't fit the model/key/url pattern; set those raw via `hindsight_extra_env`.

**Example — `text-embedding-3-small` via OpenRouter's native embeddings provider:**

```yaml
hindsight_embeddings:
  provider: openrouter
  api_key: "sk-or-..."                      # your OpenRouter key
  model: "openai/text-embedding-3-small"
```

**Example — native Cohere for both embedder and reranker** (one key drives both;
strong multilingual retrieval, zero on-box RAM — a good fit for small boxes and
non-English content):

```yaml
hindsight_embeddings:
  provider: cohere
  model: "embed-v4.0"
  api_key: "<cohere-key>"
hindsight_reranker:
  provider: cohere
  model: "rerank-v3.5"
  api_key: "<cohere-key>"                   # same key
```

Cohere's free trial tier (1,000 calls/month, no card) is enough for light personal
use; each recall costs ~2 calls (embed + rerank). Changing the embedder changes the
vector dimension — an existing bank needs a re-embed or reset (see the warning
above).

**Example — local multilingual embedder** (stays on the box; good for mixed TR+EN banks):

```yaml
hindsight_extra_env:
  HINDSIGHT_API_EMBEDDINGS_PROVIDER: "onnx"
  HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_ID: "intfloat/multilingual-e5-small"
  HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS: "384"
  HINDSIGHT_API_EMBEDDINGS_ONNX_QUERY_PREFIX: "query: "
  HINDSIGHT_API_EMBEDDINGS_ONNX_PASSAGE_PREFIX: "passage: "
```

**Example — reranker via OpenRouter** (same key; `cohere/rerank-v3.5` is multilingual,
Turkish included):

```yaml
hindsight_reranker:
  provider: openrouter
  api_key: "sk-or-..."
  model: "cohere/rerank-v3.5"
  max_candidates: 120
```

> Changing the **embedder** changes the vector space (and often the dimension). Existing
> memories were embedded with the old model, so after a swap you must re-embed — in
> practice, reset/rebuild the bank — for recall to stay consistent.

---

## Prerequisites

The daemon runs via `uvx`, so `uv` must be in your `runtimes` list:

```yaml
runtimes:
  uv: "latest"
  # ... other tools
```

If `uv` is absent the role will error during provisioning with a clear message.

---

## Tuning what gets remembered

By default the bank's missions are tightened to remember **important, durable things,
not everything** — they keep the user's preferences/conventions, project architecture,
final configuration state, and decisions (with rationale), and drop the dominant noise:
**skill/framework documentation** (brainstorming/plan/worktree/TDD/model-selection text
that gets injected into agent prompts and otherwise memorized + duplicated), git/commit/
branch/test/task-progress logs, transient errors, and per-session summaries.

These live in the role's `defaults/main.yml` and are overridable in `group_vars/all.yml`:

| Var | Applied via | Purpose |
|-----|-------------|---------|
| `hindsight_retain_mission` | `claude-code.json` (`retainMission`) — plugin sets it on first retain | what the extractor pulls from each conversation |
| `hindsight_bank_mission` | `claude-code.json` (`bankMission`) → bank `reflect_mission` | the bank's persona when surfacing memory |
| `hindsight_observations_mission` | daemon HTTP API (`PATCH …/config`), best-effort task | what consolidation turns into long-term observations; also enforces "one canonical fact" to fight duplicate paraphrases |
| `hindsight_retain_every_n_turns` | `claude-code.json` (`retainEveryNTurns`) | how often a session flushes a retain (higher = fewer, less noisy writes) |
| `hindsight_entity_labels` | daemon HTTP API (`PATCH …/config`), best-effort task | **entity-label auto-tagging** — the extractor classifies each memory from its content and writes a filterable tag (default: a `project:<name>` tag). Content-derived, so it works across **all** clients incl. Hermes (not just cwd-aware ones). Needs a daemon restart to take effect (the labels schema is cached). |
| `hindsight_dedup_threshold` | embed profile env (`HINDSIGHT_API_CONSOLIDATION_DEDUP_THRESHOLD`), best-effort task | consolidation dedup similarity — the cosine at/above which a candidate pair is sent to an LLM "merge or keep" call (it reads both texts; lower = more pairs reach the LLM, 1.0 = off). Hindsight ships 0.97; we use 0.95 to also catch close paraphrases while staying conservative. Dedup only compares within the same tag scope. |

`observations_mission` isn't a plugin config key, so the role sets it directly on the
bank via the daemon API — a **best-effort** task that no-ops when the daemon is down
(provision time) and converges on any later run while a session is up. Hermes/Codex
clients have their own retain frequency; the **bank missions apply centrally** to every
client writing to the shared bank. Changing a mission affects **future** retains only —
existing memory stays until you prune or reset the bank.

**Mixed-language banks.** If you work in more than one language (e.g. Turkish + English),
the thing that hurts recall and dedup is the **embedder**, not the stored language. The
daemon's default embedder (`BAAI/bge-small-en-v1.5`) is English-only, so non-English text
gets weak embeddings: a Turkish query recalls an English memory poorly, and the same fact
in two languages stays below the dedup threshold (so it never reaches the merge gate and
piles up). Per [Hindsight's multilingual guidance](https://hindsight.vectorize.io/developer/multilingual),
the fix is to **preserve the original language** and use a **multilingual embedder**. Two
ways to set one (see [Splitting providers](#splitting-providers)): a **remote** model such
as `openai/text-embedding-3-small` (or, stronger on Turkish, `cohere/embed-v4.0`) via the
`openrouter` provider — sends text off-box but no local model to host; or a **local** on-box
model `intfloat/multilingual-e5-small` (384-dim) via the `onnx` provider — free and private.
Optionally pair either with `hindsight_text_search_extension: pgroonga` for mixed-script
lexical search.
(Forcing every memory into one language via `HINDSIGHT_API_LLM_OUTPUT_LANGUAGE` is the
alternative, but it discards the natural language and goes against the default behavior.)

---

## Verifying / troubleshooting

After provisioning, confirm the plugin is active for each profile:

```bash
sudo -u <user> env HOME=/home/<user> /home/<user>/.local/bin/claude plugin list
```

`hindsight-memory` should appear in the output and be listed as enabled.

If memories are being **saved** but never **recalled** (i.e. nothing is injected into context at the start of a prompt), the most likely cause is that the plugin is installed but not enabled — or the installed Claude Code version does not auto-load plugin hooks. Re-enable the plugin (`claude plugin enable hindsight-memory` as the profile user) or update Claude Code, then re-test.

The custom tagged retain hook (`/usr/local/bin/hindsight-retain-tagged`) is registered directly in `~/.claude/settings.json` and runs independently of plugin enablement. This means **saving can work even when recall doesn't** — which is the tell-tale sign of this issue: memories accumulate but are never surfaced.

---

## References

- [Vectorize Hindsight — GitHub](https://github.com/vectorize-io/hindsight)
- [Claude Code plugin marketplace](https://www.anthropic.com/claude-code)
- [Runtimes (mise) & isolation](runtimes.md) — how `uv` ends up on PATH
