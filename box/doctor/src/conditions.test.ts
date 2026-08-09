import { expect, test } from "bun:test";
import { detectConditions } from "./conditions";
import type { ProcRef, RcUnit, Worktree } from "./types";

test("detectConditions: a failed RC unit => restart-failed-rc, guard pass", () => {
  const units: RcUnit[] = [
    { unit: "agent-rc-claude-x-example.service", loaded: true, active: "failed", sub: "failed" },
    { unit: "agent-rc-claude-x-ins.service", loaded: true, active: "active", sub: "running" },
  ];
  const conds = detectConditions({ units, worktrees: [], procs: [] });
  const failed = conds.filter((c) => c.candidateAction === "restart-failed-rc");
  expect(failed).toHaveLength(1);
  expect(failed[0].facts.unit).toBe("agent-rc-claude-x-example.service");
  expect(failed[0].guard).toBe("pass");
  expect(failed[0].severity).toBe("high");
});

test("detectConditions: orphan worktree (no proc ref) => prune-orphan-worktree, guard pass", () => {
  const worktrees: Worktree[] = [
    { path: "/w/bridge-cse_dead", branch: "b", locked: true, cse: "cse_dead" },
  ];
  const conds = detectConditions({ units: [], worktrees, procs: [] });
  const orphan = conds.find((c) => c.candidateAction === "prune-orphan-worktree");
  expect(orphan?.facts.path).toBe("/w/bridge-cse_dead");
  expect(orphan?.guard).toBe("pass");
});

test("detectConditions: worktree referenced by a live proc is NOT an orphan", () => {
  const worktrees: Worktree[] = [
    { path: "/w/bridge-cse_live", branch: "b", locked: true, cse: "cse_live" },
  ];
  const procs: ProcRef[] = [{ pid: 5, cmd: "bun build /w/bridge-cse_live/x" }];
  const conds = detectConditions({ units: [], worktrees, procs });
  expect(conds.find((c) => c.candidateAction === "prune-orphan-worktree")).toBeUndefined();
});
