import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DISPATCH = join(import.meta.dir, "../../../ansible/roles/box_cli/files/devbox-dispatch");

/** A fake devbox-bin next to the dispatcher, so we can see what it was handed. */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "devbox-dispatch-"));
  const bin = join(dir, "devbox-bin");
  writeFileSync(bin, '#!/bin/sh\necho "BIN $*"\n');
  chmodSync(bin, 0o755);
  return dir;
}

const run = (dir: string, args: string[]) =>
  spawnSync("sh", [DISPATCH, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });

describe("devbox dispatcher", () => {
  test("passes an ordinary subcommand to the binary, arguments intact", () => {
    const dir = sandbox();
    const r = run(dir, ["mount", "up", "-p", "ilterugur"]);
    expect(r.stdout.trim()).toBe("BIN mount up -p ilterugur");
    expect(r.status).toBe(0);
  });

  test("handles tailnet-up itself, without touching the binary", () => {
    const dir = sandbox();
    // 203.0.113.1 is TEST-NET-3: never routed over a tunnel, so this must fail fast.
    const r = run(dir, ["tailnet-up", "203.0.113.1"]);
    expect(r.stdout).not.toContain("BIN");
    expect(r.status).not.toBe(0);
  });

  test("says what to do when the binary is missing, instead of failing obscurely", () => {
    const empty = mkdtempSync(join(tmpdir(), "devbox-empty-"));
    // Absolute path on purpose: an empty PATH is what this test needs to hide devbox-bin,
    // but spawnSync also uses PATH to find the interpreter itself — bare "sh" would make
    // Node/Bun fail to launch the process at all, and the assertions below would never
    // reach the dispatcher's own error branch.
    const r = spawnSync("/bin/sh", [DISPATCH, "ls"], { encoding: "utf8", env: { ...process.env, PATH: empty } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("devbox-bin");
    expect(r.stderr).toContain("installer");
    // Pinned verbatim: the installer greps this exact phrase to tell a dispatcher from a
    // compiled binary before promoting one to devbox-bin. Reword it there and here
    // together — a silent drift promotes the dispatcher onto itself, and `exec` then
    // hands it back to itself forever.
    expect(r.stderr).toContain("devbox-bin not found on PATH");
  });
});
