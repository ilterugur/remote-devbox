#!/usr/bin/env bash
# Managed by remote-devbox. Boot/recovery orchestrator for one RC instance.
#
# After the Remote Control service comes up, scan this project's worktrees for
# sessions interrupted by a host crash/OOM and bring each one back: resumed from
# disk (full conversation), re-registered on the phone, and — for sessions that
# were running a Workflow when killed — instructed to resume that workflow from
# its on-disk journal (cached agents replay; only the aborted tail re-runs).
# Completed workflows are never re-run.
#
# Safe by design: idempotent (skips sessions already running), throttled (at most
# RC_RESUME_MAX_CONCURRENT brought up at once, with a settle delay + memory gate),
# and quarantined (a session that keeps crashing the box is skipped after
# RC_RESUME_MAX_ATTEMPTS within an hour, to avoid an OOM-restart loop).
#
# Reads worktrees + transcripts; never modifies them.
#
# Usage: agent-rc-resume <user>-<project>
# Env (from the systemd unit): HOME, CLAUDE_RC_PROJECT_DIR, CLAUDE_RC_NAME,
#   RC_RESUME_LOOKBACK_H, RC_RESUME_MAX_CONCURRENT, RC_RESUME_SETTLE_SEC,
#   RC_RESUME_MAX_ATTEMPTS, RC_RESUME_MIN_FREE_MB
set -uo pipefail

ID="${1:?instance id (<user>-<project>) required}"
SOCKET="agent-rc-${ID}"
DIR="${CLAUDE_RC_PROJECT_DIR:?CLAUDE_RC_PROJECT_DIR not set}"
PROJECT_NAME="${CLAUDE_RC_NAME:-${ID}}"

LOOKBACK_H="${RC_RESUME_LOOKBACK_H:-12}"
MAX_CONCURRENT="${RC_RESUME_MAX_CONCURRENT:-2}"
SETTLE_SEC="${RC_RESUME_SETTLE_SEC:-20}"
MAX_ATTEMPTS="${RC_RESUME_MAX_ATTEMPTS:-3}"
MIN_FREE_MB="${RC_RESUME_MIN_FREE_MB:-1200}"
SETTLE_MAX_SEC="${RC_RESUME_SETTLE_MAX_SEC:-180}"

SCAN="/usr/local/bin/agent-rc-resume-scan"
EXEC="/usr/local/bin/agent-rc-resume-exec"
SYSFILE="/usr/local/share/agent-devbox/agent-rc-resume-sys.txt"
RUNDIR="${HOME}/.cache/agent-devbox/resume"
STATE="${RUNDIR}/attempts.json"
BRIDGE_MAP="${RUNDIR}/bridge-map-${ID}.json"
# One definition for this script and the planner it embeds, so the pointer the
# planner accepts and the pointer this script reports can never drift apart. The
# launcher keeps its own copy on purpose: it is a separate process and re-checks
# what it is handed rather than trusting us.
BRIDGE_RE='^session_[A-Za-z0-9_-]{6,128}$'
mkdir -p "${RUNDIR}"

log() { echo "[agent-rc-resume] $*" >&2; }

export PATH="${HOME}/.local/bin:${PATH}"
command -v mise >/dev/null 2>&1 && eval "$(mise activate bash --shims)" || true
PYBIN="$(command -v python3 || echo python3)"
AGENT="${CLAUDE_RC_AGENT:-claude}"
ADAPTER="/usr/local/share/agent-devbox/adapters/${AGENT}.sh"
[ -r "${ADAPTER}" ] && . "${ADAPTER}" || { log "adapter ${ADAPTER} missing"; exit 0; }
RESUME_PAT="$(adapter_resume_pgrep_pattern '')"

# Wait for the RC tmux session to be ready (the service may still be registering).
for _ in $(seq 1 60); do
  tmux -L "${SOCKET}" has-session -t "${SOCKET}" 2>/dev/null && break
  sleep 2
done
tmux -L "${SOCKET}" has-session -t "${SOCKET}" 2>/dev/null || { log "RC tmux not up; nothing to resume"; exit 0; }
sleep "${SETTLE_SEC}"

PLAN="$(adapter_resume_scan "${DIR}" "${LOOKBACK_H}")"
[ "${PLAN}" = "[]" ] && { log "no interrupted sessions in last ${LOOKBACK_H}h"; exit 0; }

# Planner: read the scan plan + attempt state, write per-session name/notice files,
# apply the quarantine cap, and emit a launch list (one TSV line per session:
# uuid <TAB> perm <TAB> namefile <TAB> noticefile <TAB> worktree <TAB> bridgefile).
LAUNCH_TSV="$(
  RC_PLAN="${PLAN}" RC_RUNDIR="${RUNDIR}" RC_STATE="${STATE}" \
  RC_MAX_ATTEMPTS="${MAX_ATTEMPTS}" RC_PROJECT="${PROJECT_NAME}" \
  RC_BRIDGE_MAP="${BRIDGE_MAP}" RC_BRIDGE_RE="${BRIDGE_RE}" \
  "${PYBIN}" - <<'PY'
# NOTE: this heredoc body sits inside LAUNCH_TSV="$( ... <<PY ... PY )", where the
# PY delimiter is quoted so the shell does not expand $vars in here. On macOS
# bash 3.2, though, an odd count of literal apostrophes in the body still breaks
# the outer $( ... ) command-substitution parse -- the quoting is heredoc-local,
# not substitution-local. Keep every apostrophe below paired: this comment block
# itself deliberately uses zero, so it can not tip an even body odd.
import os, json, time, re

BRIDGE_RE = re.compile(os.environ["RC_BRIDGE_RE"])
plan = json.loads(os.environ["RC_PLAN"])
rundir = os.environ["RC_RUNDIR"]; statef = os.environ["RC_STATE"]
maxatt = int(os.environ["RC_MAX_ATTEMPTS"]); project = os.environ["RC_PROJECT"]
now = time.time()
try:
    state = json.load(open(statef))
except Exception:
    state = {}

try:
    bmap = json.load(open(os.environ.get("RC_BRIDGE_MAP", "")))
except Exception:
    bmap = {}

# The map is written by a separate process (the monitor loop) that can be
# killed mid-write, so its top-level shape is not guaranteed even when the
# JSON itself parses. A resume cycle must survive that: one corrupt or
# wrong-shaped map must not cost sessions that have nothing to do with it.
if not isinstance(bmap, dict):
    bmap = {}

out = []
for p in plan:
    uuid = p["uuid"]; wt = p["worktree"]; perm = p["permissionMode"]
    kw = p.get("killedWorkflows") or []
    st = state.get(uuid, {"count": 0, "last": 0})
    # reset the counter if the last attempt was long ago (a fresh crash, not a loop)
    if now - st.get("last", 0) > 3600:
        st["count"] = 0
    if st["count"] >= maxatt:
        print(f"# quarantined {uuid} ({st['count']} attempts in <1h) — skipping", flush=True)
        continue
    st["count"] += 1; st["last"] = now
    state[uuid] = st

    # The name only reaches claude.ai when a fresh card has to be minted. The
    # scanner derives it from the conversation so that card is not called
    # "<project> · 393f13d9"; the fallback here is for a plan from an older scanner.
    name = str(p.get("name") or "").strip() or f"{project} · {uuid[:8]}"

    # per-session resume notice (system-framed); only mentions workflows that are
    # genuinely unfinished, so the agent never re-runs completed ones.
    if kw:
        wl = "; ".join(f'{w["name"]} resumeFromRunId="{w["runId"]}"' for w in kw)
        notice = ("[automated resume notice — system, not the user] The host OOM-killed this run "
                  "and it was restarted. Per your resume-context system guidance, resume the aborted "
                  f"workflow(s) now via the Workflow tool: {wl}. The completed agent prefix replays "
                  "from cache; only the aborted/remaining agents re-run. Do not re-run any workflow "
                  "that already finished. Then continue the user's work to completion, seamlessly, in "
                  "the conversation's language.")
    else:
        notice = ("[automated resume notice — system, not the user] The host OOM-killed this run and it "
                  "was restarted. Per your resume-context system guidance, silently continue any unfinished "
                  "work where it left off; if your last turn was already complete, just continue naturally or "
                  "wait for the user. Do not post a bare acknowledgment.")

    nf = os.path.join(rundir, uuid + ".name")
    cf = os.path.join(rundir, uuid + ".notice")
    open(nf, "w").write(name)
    open(cf, "w").write(notice)

    # Hand back the card this conversation already owns, when its identity was
    # captured before the crash. Without it the CLI mints a second card and the
    # original is orphaned for good.
    bf = os.path.join(rundir, uuid + ".bridge")
    # A wrong-shaped entry (torn write, future schema change) costs only the
    # pointer for this session, never the batch: bid falls back to "" instead
    # of raising, so the loop keeps going and out/state still get written below.
    entry = bmap.get(uuid)
    bid = str(entry.get("bridge") or "") if isinstance(entry, dict) else ""
    if BRIDGE_RE.match(bid):
        open(bf, "w").write(bid)
    else:
        try:
            os.remove(bf)
        except OSError:
            pass
    out.append("\t".join([uuid, perm, nf, cf, wt, bf]))

json.dump(state, open(statef, "w"), indent=2)
for line in out:
    print(line)
PY
)"

launched=0
warned=0
while IFS=$'\t' read -r uuid perm namefile noticefile worktree bridgefile; do
  [ -z "${uuid:-}" ] && continue
  case "${uuid}" in \#*) log "${uuid} ${perm}"; continue;; esac

  # idempotency: never double-resume a session that is already running
  if pgrep -f "$(adapter_resume_pgrep_pattern "${uuid}")" >/dev/null 2>&1; then
    log "already running: ${uuid}"; continue
  fi

  # The reattach variable is read out of the CLI bundle, not a documented API. If an
  # upgrade drops it, resumes silently go back to minting a second card per session --
  # so say so in the journal instead of letting it rot unnoticed. Checked at most once
  # per cycle (not once per session), and only once a session that is actually about
  # to be launched has a readable pointer -- a leftover .bridge file from a uuid no
  # longer in this plan must not trigger it. The check reads the *resolved* binary
  # (readlink -f); a future thin-wrapper install that execs a separate bundle would
  # resolve to something that never contains the string even though reattach still
  # works, so this is phrased as "could not confirm", not "is broken", and only runs
  # when the resolved path is a plain file to begin with. Best-effort only: never
  # allowed to fail the script under set -uo pipefail.
  if [ "${warned}" -eq 0 ] && [ -n "${bridgefile}" ] && [ -r "${bridgefile}" ]; then
    warned=1
    CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
    if [ -n "${CLAUDE_BIN}" ]; then
      CLAUDE_RESOLVED="$(readlink -f "${CLAUDE_BIN}" 2>/dev/null || echo "${CLAUDE_BIN}")"
      if [ -f "${CLAUDE_RESOLVED}" ] && \
         ! grep -qa CLAUDE_BRIDGE_REATTACH_SESSION "${CLAUDE_RESOLVED}" 2>/dev/null; then
        log "WARNING: could not confirm CLAUDE_BRIDGE_REATTACH_SESSION in ${CLAUDE_RESOLVED} — either this claude no longer supports reattach (resumed sessions will mint new claude.ai cards) or it is a wrapper around a separate bundle"
      fi
    fi
  fi

  win="resume:$(basename "${namefile}" .name | cut -c1-8)"
  # Pass the command as separate argv entries (not one string): tmux execs it
  # directly without a second shell parse, so on-disk values can't be re-split or
  # interpreted as shell metacharacters.
  tmux -L "${SOCKET}" new-window -t "${SOCKET}:" -n "${win}" \
    "${EXEC}" "${uuid}" "${perm}" "${worktree}" "${namefile}" "${noticefile}" "${SYSFILE}" "${bridgefile}"
  launched=$((launched + 1))
  # Say which path the launcher will take, where it can actually be read: the
  # launcher runs under the tmux server, so its own stderr lands in a pane the
  # agent's TUI overwrites within seconds, while this line reaches journald.
  # Validate the content rather than the file's existence — the planner writes the
  # pointer non-atomically, so a kill mid-write leaves a readable file the launcher
  # will reject, and a journal that claimed "reattaching" would be lying about the
  # one outcome this feature exists to guarantee.
  bridge=""
  if [ -n "${bridgefile}" ] && [ -r "${bridgefile}" ]; then
    bridge="$(tr -d '\r\n' < "${bridgefile}" 2>/dev/null || true)"
  fi
  if [ -n "${bridge}" ] && printf '%s' "${bridge}" | grep -Eq "${BRIDGE_RE}"; then
    log "launched ${uuid} (perm=${perm}, reattaching to ${bridge})"
  elif [ -n "${bridge}" ]; then
    log "launched ${uuid} (perm=${perm}, unusable pointer — a fresh claude.ai card will be minted)"
  else
    log "launched ${uuid} (perm=${perm}, no pointer — a fresh claude.ai card will be minted)"
  fi

  # throttle: settle, then wait for memory + concurrency headroom before the next
  sleep "${SETTLE_SEC}"
  waited=0
  while :; do
    running="$(pgrep -fc "${RESUME_PAT% }" 2>/dev/null || echo 0)"
    free_mb="$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"; free_mb="${free_mb:-9999}"
    { [ "${running}" -lt "${MAX_CONCURRENT}" ] && [ "${free_mb}" -ge "${MIN_FREE_MB}" ]; } && break
    [ "${waited}" -ge "${SETTLE_MAX_SEC}" ] && { log "settle timeout (running=${running} free=${free_mb}MB) — proceeding"; break; }
    sleep 5; waited=$((waited + 5))
  done
done <<< "${LAUNCH_TSV}"

log "done — ${launched} session(s) resumed for ${ID}"
exit 0
