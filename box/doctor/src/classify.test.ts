import { expect, test } from "bun:test";
import { classifySession, isWorktreeProtected } from "./classify";
import type { ProcRef } from "./types";

const NOW = Math.floor(Date.parse("2026-06-18T09:34:00Z") / 1000);
const ACTIVITY_WINDOW = 10 * 60;
const IDLE_AFTER = 30 * 60;

test("classifySession: live pid + recent activity => active", () => {
  const s = classifySession(
    { pid: 279938, lastActivity: NOW - 3 * 60 },
    { now: NOW, activityWindowSec: ACTIVITY_WINDOW, idleAfterSec: IDLE_AFTER },
  );
  expect(s).toBe("active");
});

test("classifySession: live pid but stale activity => idle", () => {
  const s = classifySession(
    { pid: 278447, lastActivity: NOW - 43 * 60 },
    { now: NOW, activityWindowSec: ACTIVITY_WINDOW, idleAfterSec: IDLE_AFTER },
  );
  expect(s).toBe("idle");
});

test("classifySession: no pid => dead", () => {
  const s = classifySession(
    { pid: null, lastActivity: NOW - 100 * 60 },
    { now: NOW, activityWindowSec: ACTIVITY_WINDOW, idleAfterSec: IDLE_AFTER },
  );
  expect(s).toBe("dead");
});

test("isWorktreeProtected: another live process referencing the path protects it", () => {
  const wtPath =
    "/home/dev-a/projects/example-monorepo/.claude/worktrees/bridge-cse_01XYmhZXmWvZ8hXg9nj2dQXZ";
  const procs: ProcRef[] = [
    {
      pid: 289264,
      cmd: `/bin/bash -c cd ${wtPath}/packages/eden && bun run prepare-types`,
    },
  ];
  expect(isWorktreeProtected(wtPath, procs)).toBe(true);
});

test("isWorktreeProtected: no process references the path => not protected", () => {
  const wtPath = "/home/dev-a/projects/example-monorepo/.claude/worktrees/bridge-cse_dead";
  const procs: ProcRef[] = [
    { pid: 1, cmd: "/sbin/init" },
    { pid: 279938, cmd: "claude --print --session-id cse_other" },
  ];
  expect(isWorktreeProtected(wtPath, procs)).toBe(false);
});

test("classifySession: activity in the middle band (between window and idle) => active", () => {
  const s = classifySession(
    { pid: 1, lastActivity: NOW - 20 * 60 },
    { now: NOW, activityWindowSec: ACTIVITY_WINDOW, idleAfterSec: IDLE_AFTER },
  );
  expect(s).toBe("active");
});

test("isWorktreeProtected: a trailing slash on the worktree path still matches", () => {
  const wt = "/home/dev-a/projects/x/.claude/worktrees/bridge-cse_z";
  const procs: ProcRef[] = [{ pid: 5, cmd: `bun build --cwd ${wt}/src` }];
  expect(isWorktreeProtected(wt + "/", procs)).toBe(true);
});

test("classifySession: live pid with unknown activity => active (conservative)", () => {
  const s = classifySession(
    { pid: 100, lastActivity: null },
    { now: NOW, activityWindowSec: ACTIVITY_WINDOW, idleAfterSec: IDLE_AFTER },
  );
  expect(s).toBe("active");
});
