#!/usr/bin/env python3
"""Managed by remote-devbox. Deterministic resume scanner.

Given a Remote Control project dir (CLAUDE_RC_PROJECT_DIR), find the per-session
worktrees that were interrupted by a host crash/restart and emit a JSON plan the
orchestrator (agent-rc-resume.sh) consumes. Reads ONLY on-disk state — no LLM,
no network. The plan distinguishes:

  - permissionMode   : each session's last-used mode (resume with the same one)
  - killedWorkflows  : aborted/unfinished `Workflow` runs (status != completed,
                       result is null) -> resume via Workflow resumeFromRunId.
                       Completed workflows are NEVER re-run.
  - midResponse      : the transcript ended on an unanswered user message.

Worktrees + JSONL transcripts are read, never modified.

Usage: agent-rc-resume-scan.py <CLAUDE_RC_PROJECT_DIR> [lookback_hours]
Env:   HOME (transcripts live under $HOME/.claude/projects)
"""
import os
import sys
import json
import glob
import time

def encode_path(p):
    # Claude Code names transcript dirs by replacing / . _ with - in the path.
    return p.translate(str.maketrans("/._", "---"))

def latest_jsonl(d):
    js = glob.glob(os.path.join(d, "*.jsonl"))
    return max(js, key=os.path.getmtime) if js else None

def load(f):
    out = []
    with open(f) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out

def last_permission_mode(recs):
    pm = None
    for o in recs:
        v = o.get("permissionMode") or (o.get("message", {}) or {}).get("permissionMode")
        if v:
            pm = v
    return pm or "default"

def ended_mid_response(recs):
    for o in reversed(recs):
        t = o.get("type")
        if t == "assistant":
            return False
        if t == "user":
            return True
    return False

def _text_of(rec):
    m = rec.get("message")
    if not isinstance(m, dict):
        return ""
    c = m.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(b.get("text", "") for b in c
                        if isinstance(b, dict) and b.get("type") == "text")
    return ""


def last_custom_title(recs):
    """The title a rename wrote into the transcript, if this session ever had one."""
    title = None
    for o in recs:
        if o.get("type") == "custom-title":
            v = str(o.get("customTitle") or "").strip()
            if v:
                title = v
    return title


def first_user_line(recs, limit=60):
    """The first line the human actually typed -- the closest thing to a title on disk.

    Skips the machinery that also arrives as `user` records: meta records, the
    caveat banner, slash-command and system-reminder wrappers, and this feature's
    own resume notice.
    """
    for o in recs:
        if o.get("type") != "user" or o.get("isMeta"):
            continue
        text = _text_of(o).strip()
        if not text or text.startswith("<") or text.startswith("Caveat:"):
            continue
        if text.startswith("[automated resume notice"):
            continue
        line = "".join(ch for ch in text.splitlines()[0] if ch.isprintable()).strip()
        if line:
            return line[:limit].rstrip()
    return None


def resolve_name(recs, killed, project, uuid):
    """What a freshly minted card is called.

    Only reached when no reattach pointer survived the crash: a session that gets
    its own card back keeps the title that card already carries.
    """
    if killed:
        wf = str(killed[0].get("name") or "").strip()
        if wf:
            return wf
    for candidate in (last_custom_title(recs), first_user_line(recs)):
        if candidate:
            return candidate
    return "%s · %s" % (project, uuid[:8])

def killed_workflows(sess_dir):
    res = []
    for j in glob.glob(os.path.join(sess_dir, "workflows", "wf_*.json")):
        try:
            o = json.load(open(j))
        except Exception:
            continue
        if o.get("status") != "completed" and o.get("result") is None:
            res.append({
                "runId": o.get("runId"),
                "name": o.get("workflowName"),
                "scriptPath": o.get("scriptPath"),
                "status": o.get("status"),
                "agents": o.get("agentCount"),
            })
    return res

def main():
    if len(sys.argv) < 2:
        print("usage: agent-rc-resume-scan.py <project_dir> [lookback_h]", file=sys.stderr)
        return 2
    project_dir = os.path.abspath(sys.argv[1])
    lookback_h = float(sys.argv[2]) if len(sys.argv) > 2 else float(os.environ.get("RC_RESUME_LOOKBACK_H", "12"))
    home = os.environ.get("HOME", os.path.expanduser("~"))
    projects = os.path.join(home, ".claude", "projects")
    wt_base = os.path.join(project_dir, ".claude", "worktrees")
    slug = encode_path(wt_base + "/") + "bridge-cse-"
    now = time.time()
    project = os.environ.get("CLAUDE_RC_NAME") or os.path.basename(project_dir)

    plan = []
    for proj_dir in glob.glob(os.path.join(projects, slug + "*")):
        f = latest_jsonl(proj_dir)
        if not f:
            continue
        if (now - os.path.getmtime(f)) / 3600 > lookback_h:
            continue
        uuid = os.path.splitext(os.path.basename(f))[0]
        sess_dir = os.path.join(proj_dir, uuid)
        recs = load(f)
        cse = proj_dir.split("bridge-")[-1].replace("cse-", "cse_", 1)
        wt = os.path.join(wt_base, "bridge-" + cse)
        if not os.path.isdir(wt):
            continue
        kw = killed_workflows(sess_dir)
        plan.append({
            "cse": cse,
            "uuid": uuid,
            "worktree": wt,
            "permissionMode": last_permission_mode(recs),
            "ageHours": round((now - os.path.getmtime(f)) / 3600, 2),
            "killedWorkflows": kw,
            "midResponse": ended_mid_response(recs),
            "name": resolve_name(recs, kw, project, uuid),
        })

    plan.sort(key=lambda p: p["ageHours"])
    print(json.dumps(plan, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
