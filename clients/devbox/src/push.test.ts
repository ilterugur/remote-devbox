import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd, firstHumanPrompt } from "./config";

describe("encodeCwd", () => {
  test("project root: / and . both become -", () => {
    expect(encodeCwd("/Users/dev/Documents/Projects/dev-a/claude-devbox")).toBe(
      "-Users-dev-Documents-Projects-dev-a-claude-devbox",
    );
  });

  test("worktree '/.claude-worktrees/' collapses to a double dash", () => {
    expect(
      encodeCwd("/Users/dev/Projects/example-org/example-app/.claude-worktrees/feature-branch"),
    ).toBe("-Users-dev-Projects-example-org-example-app--claude-worktrees-feature-branch");
  });

  test("remote root", () => {
    expect(encodeCwd("/home/devbox/projects/claude-devbox")).toBe("-home-devbox-projects-claude-devbox");
  });

  test("worktree dir underscore becomes - (matches Claude Code's ~/.claude/projects encoding)", () => {
    expect(encodeCwd("/home/dev-a/projects/example-monorepo/.claude/worktrees/bridge-cse_01Nn7vs4")).toBe(
      "-home-dev-a-projects-example-monorepo--claude-worktrees-bridge-cse-01Nn7vs4",
    );
  });

  test("every non-alphanumeric (_ @ etc.) maps to -, like the real project dir name", () => {
    expect(encodeCwd("/home/x/node_modules/@mastra/core")).toBe("-home-x-node-modules--mastra-core");
  });
});

describe("firstHumanPrompt", () => {
  test("skips SDK / meta / command-injection records", () => {
    const dir = mkdtempSync(join(tmpdir(), "devbox-test-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "queue-operation", operation: "x" }),
        JSON.stringify({ type: "user", promptSource: "sdk", message: { content: "sdk boot" } }),
        JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory…" }] } }),
        JSON.stringify({ type: "user", message: { content: "<command-name>foo</command-name>" } }),
        JSON.stringify({ type: "user", message: { content: "the real first question" } }),
      ].join("\n") + "\n",
    );
    expect(firstHumanPrompt(file)).toBe("the real first question");
  });

  test("handles array text-block content", () => {
    const dir = mkdtempSync(join(tmpdir(), "devbox-test-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello there" }] } }) + "\n",
    );
    expect(firstHumanPrompt(file)).toBe("hello there");
  });
});
