import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  OPENCODE_ACCOUNT_VERBS,
  opencodeAccountArgs,
  opencodeEngineScriptPath,
  opencodeRemoteArgv,
} from "./opencode-account";
import type { Config } from "./config";

const cfg: Config = {
  prefix: "devbox",
  default: "alice",
  locale: "en_US.UTF-8",
  launch: "claude",
  profiles: [{ user: "alice", projects: [] }, { user: "bob", projects: [] }],
};

describe("opencodeAccountArgs", () => {
  test("passes the verb through for the label-less verbs", () => {
    expect(opencodeAccountArgs("ls")).toEqual(["ls"]);
    expect(opencodeAccountArgs("status")).toEqual(["status"]);
    expect(opencodeAccountArgs("gc")).toEqual(["gc"]);
  });

  test("puts the label straight after the verb", () => {
    expect(opencodeAccountArgs("add", "ugur1")).toEqual(["add", "ugur1"]);
    expect(opencodeAccountArgs("use", "ugur2")).toEqual(["use", "ugur2"]);
  });

  test("emits flags in --json, --force, --keep, --key order", () => {
    expect(opencodeAccountArgs("add", "ugur2", { key: "oc_sk_test", json: true })).toEqual([
      "add",
      "ugur2",
      "--json",
      "--key",
      "oc_sk_test",
    ]);
    expect(opencodeAccountArgs("use", "ugur1", { force: true, keep: 5 })).toEqual([
      "use",
      "ugur1",
      "--force",
      "--keep",
      "5",
    ]);
  });

  test("every verb the engine has is accepted", () => {
    for (const verb of OPENCODE_ACCOUNT_VERBS) {
      if (verb === "add" || verb === "use" || verb === "rm") {
        expect(opencodeAccountArgs(verb, "x")).toBeTruthy();
      } else {
        expect(opencodeAccountArgs(verb)).toBeTruthy();
      }
    }
  });

  test("rejects an unknown verb", () => {
    expect(() => opencodeAccountArgs("swap")).toThrow(/unknown opencode-account action/);
  });

  test("rejects a missing label on the verbs that name an account", () => {
    expect(() => opencodeAccountArgs("add")).toThrow(/needs a label/);
    expect(() => opencodeAccountArgs("use")).toThrow(/needs a label/);
  });

  test("rejects a label the engine would refuse, before spawning anything", () => {
    expect(() => opencodeAccountArgs("add", "bad label")).toThrow(/may only contain/);
  });
});

describe("opencodeEngineScriptPath", () => {
  test("materialises the embedded engine as an executable 0700 script, once", async () => {
    const path = opencodeEngineScriptPath();
    const st = statSync(path);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    const onDisk = await Bun.file(join(import.meta.dir, "..", "..", "..", "scripts", "devbox-opencode-account.sh")).text();
    const embedded = await Bun.file(path).text();
    expect(embedded).toBe(onDisk);
  });
});

describe("opencodeRemoteArgv", () => {
  const ENGINE = "/usr/local/share/remote-devbox/devbox-opencode-account.sh";

  test("runs the engine as the developer with that profile's omp dir", () => {
    expect(opencodeRemoteArgv(cfg, "alice", ["use", "ugur1"])).toEqual([
      "ssh",
      "-t",
      "devbox-alice",
      `env PI_CODING_AGENT_DIR='/home/alice/.agent-profiles/omp-main' ${ENGINE} 'use' 'ugur1'`,
    ]);
  });

  test("honours an explicit agent profile", () => {
    expect(opencodeRemoteArgv(cfg, "bob", ["ls"], "omp-work")).toEqual([
      "ssh",
      "-t",
      "devbox-bob",
      `env PI_CODING_AGENT_DIR='/home/bob/.agent-profiles/omp-work' ${ENGINE} 'ls'`,
    ]);
  });

  test("never routes through sudo", () => {
    expect(opencodeRemoteArgv(cfg, "alice", ["ls"])[3]).not.toContain("sudo");
  });
});

describe("engine parity", () => {
  test("the embedded engine is byte-identical to scripts/devbox-opencode-account.sh", async () => {
    const onDisk = await Bun.file(
      join(import.meta.dir, "..", "..", "..", "scripts", "devbox-opencode-account.sh"),
    ).text();
    const embedded = await Bun.file(opencodeEngineScriptPath()).text();
    expect(embedded).toBe(onDisk);
  });
});
