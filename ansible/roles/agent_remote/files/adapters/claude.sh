#!/usr/bin/env bash
# Managed by remote-devbox. Claude adapter for the agent-rc engine. Holds every
# Claude-specific detail so the engine stays provider-agnostic. Sourced (not exec'd).

AGENT_CFG_DEFAULT=".claude"

# Logged in? Claude keeps creds at <cfg>/.credentials.json (or credentials.json).
adapter_creds_ok() {
  local cfg="$1"
  [ -f "${cfg}/.credentials.json" ] || [ -f "${cfg}/credentials.json" ]
}

# Always-on launch: claude remote-control. Claude refuses when API/OAuth-token env
# is set, so clear it here (moved verbatim from the old claude-rc-run.sh).
adapter_launch() {
  local dir="$1" name="$2" spawn="$3" capacity="$4"
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
    CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_TELEMETRY 2>/dev/null || true
  claude remote-control --name "${name}" --spawn "${spawn}" --capacity "${capacity}"
}

# Resume discovery: Claude scans on-disk JSONL transcripts (deterministic).
adapter_resume_scan() {
  local dir="$1" lookback_h="$2"
  "${PYBIN:-python3}" /usr/local/bin/agent-rc-resume-scan "${dir}" "${lookback_h}" 2>/dev/null || echo '[]'
}

# "Already running" check for idempotent resume.
adapter_resume_pgrep_pattern() {
  local uuid="$1"; printf 'claude --resume %s' "${uuid}"
}
