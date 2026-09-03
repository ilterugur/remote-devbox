import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import { ACCOUNT_VERBS, accountArgs, engineScriptPath, remoteArgv } from "./account";
import type { Config } from "./config";

// Built literally, never read from disk: these tests must not depend on (or reveal) the
// operator's own config.
const cfg: Config = {
  prefix: "devbox",
  default: "alice",
  locale: "en_US.UTF-8",
  launch: "claude",
  profiles: [{ user: "alice", projects: [] }, { user: "bob", projects: [] }],
};

describe("accountArgs", () => {
  test("passes the verb through for the label-less verbs", () => {
    expect(accountArgs("ls")).toEqual(["ls"]);
    expect(accountArgs("status")).toEqual(["status"]);
    expect(accountArgs("gc")).toEqual(["gc"]);
  });

  test("puts the label straight after the verb", () => {
    expect(accountArgs("add", "work")).toEqual(["add", "work"]);
    expect(accountArgs("use", "personal")).toEqual(["use", "personal"]);
    expect(accountArgs("rm", "old.one_2")).toEqual(["rm", "old.one_2"]);
  });

  test("emits flags in --json, --force, --keep order", () => {
    expect(accountArgs("use", "work", { force: true })).toEqual(["use", "work", "--force"]);
    expect(accountArgs("ls", undefined, { json: true })).toEqual(["ls", "--json"]);
    expect(accountArgs("gc", undefined, { keep: 5 })).toEqual(["gc", "--keep", "5"]);
    expect(accountArgs("gc", undefined, { keep: "2" })).toEqual(["gc", "--keep", "2"]);
    expect(accountArgs("use", "work", { json: true, force: true, keep: 1 })).toEqual([
      "use", "work", "--json", "--force", "--keep", "1",
    ]);
  });

  test("every verb the engine has is accepted", () => {
    for (const verb of ACCOUNT_VERBS) {
      const label = verb === "add" || verb === "use" || verb === "rm" ? "work" : undefined;
      expect(accountArgs(verb, label)[0]).toBe(verb);
    }
  });

  test("rejects an unknown verb", () => {
    expect(() => accountArgs("switch")).toThrow(/unknown account action "switch"/);
    expect(() => accountArgs("")).toThrow(/unknown account action/);
  });

  test("rejects a missing label on the verbs that name an account", () => {
    expect(() => accountArgs("add")).toThrow(/account add needs a label/);
    expect(() => accountArgs("use")).toThrow(/account use needs a label/);
    expect(() => accountArgs("rm", "")).toThrow(/account rm needs a label/);
  });

  test("rejects a label the engine would refuse, before spawning anything", () => {
    expect(() => accountArgs("add", "work acct")).toThrow(/may only contain/);
    expect(() => accountArgs("use", "work;rm -rf /")).toThrow(/may only contain/);
    expect(() => accountArgs("rm", "../escape")).toThrow(/may only contain/);
  });
});

describe("engineScriptPath", () => {
  test("materialises the embedded engine as an executable 0700 script, once", async () => {
    const path = engineScriptPath();
    const st = statSync(path);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect((await Bun.file(path).text()).startsWith("#!/usr/bin/env bash")).toBe(true);
    // A second call must hand back the same file rather than litter $TMPDIR.
    expect(engineScriptPath()).toBe(path);
  });
});

describe("remoteArgv", () => {
  const ENGINE = "/usr/local/share/remote-devbox/devbox-account.sh";

  // No sudo, and not the operator wrapper: the ssh alias logs in as the DEVELOPER, who has
  // no sudo on the box. The developer owns the profile tree and vault, so park/restore
  // needs no privilege; only the Remote Control restart does, and that stays an operator
  // action (`sudo remote-devbox-account`).
  test("runs the engine as the developer with that profile's config dir", () => {
    expect(remoteArgv(cfg, "alice", ["use", "work"])).toEqual([
      "ssh",
      "-t",
      "devbox-alice",
      `env CLAUDE_CONFIG_DIR='/home/alice/.agent-profiles/claude-main' DEVBOX_ACCOUNT_STORE=file ${ENGINE} 'use' 'work'`,
    ]);
  });

  test("honours an explicit agent profile and quotes every interpolated value", () => {
    expect(remoteArgv(cfg, "bob", ["gc", "--keep", "3"], "claude-work")).toEqual([
      "ssh",
      "-t",
      "devbox-bob",
      `env CLAUDE_CONFIG_DIR='/home/bob/.agent-profiles/claude-work' DEVBOX_ACCOUNT_STORE=file ${ENGINE} 'gc' '--keep' '3'`,
    ]);
  });

  test("single-quotes a label so it cannot break out of the remote command", () => {
    // accountArgs refuses such a label, but the quoting is the second line of defence.
    expect(remoteArgv(cfg, "alice", ["use", "it's"])[3]).toContain("'use' 'it'\\''s'");
  });

  test("never routes through sudo", () => {
    expect(remoteArgv(cfg, "alice", ["ls"])[3]).not.toContain("sudo");
  });
});

describe("engine parity", () => {
  test("the embedded engine is byte-identical to scripts/devbox-account.sh", async () => {
    // The whole point of the text import: the compiled binary cannot drift from the copy
    // Ansible installs on the box.
    const onDisk = await Bun.file(join(import.meta.dir, "..", "..", "..", "scripts", "devbox-account.sh")).text();
    const embedded = await Bun.file(engineScriptPath()).text();
    expect(embedded).toBe(onDisk);
  });
});
