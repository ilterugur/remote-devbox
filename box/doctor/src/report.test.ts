import { expect, test } from "bun:test";
import { formatHuman, formatJson } from "./report";
import type { Health } from "./types";

const health: Health = {
  now: Math.floor(Date.parse("2026-06-18T09:34:00Z") / 1000),
  mem: { totalBytes: 8131299328, usedBytes: 6979321856, freeBytes: 811597824, availableBytes: 1073741824 },
  swap: [{ name: "/swapfile", type: "file", sizeBytes: 8589934592, usedBytes: 0, priority: -1 }],
  oom: [{ at: 1, atText: "Thu Jun 18 07:53:25 2026", process: "bun", pid: 273394, uid: 1001 }],
  units: [{ unit: "claude-rc-x-example.service", loaded: true, active: "failed", sub: "failed" }],
  sessions: [],
  worktrees: [],
  conditions: [
    { id: "rc-x-failed", severity: "high", facts: { unit: "claude-rc-x-example.service" }, candidateAction: "restart-failed-rc", guard: "pass" },
  ],
};

test("formatJson round-trips the Health object", () => {
  expect(JSON.parse(formatJson(health))).toEqual(health);
});

test("formatHuman includes a conditions section naming the candidate action", () => {
  const out = formatHuman(health);
  expect(out).toContain("restart-failed-rc");
  expect(out).toContain("claude-rc-x-example.service");
  expect(out).toContain("OOM");
});
