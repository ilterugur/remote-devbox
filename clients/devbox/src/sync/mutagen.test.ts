import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCreateArgs, buildStatusArgs, ensureDaemonAutostart, MUTAGEN_AGENT_LABEL, parseStatusOutput,
  sessionName, goAgentFile,
} from "./mutagen";

describe("goAgentFile", () => {
  test("maps uname -m to the mutagen agent bundle filename", () => {
    expect(goAgentFile("x86_64")).toBe("linux_amd64");
    expect(goAgentFile("amd64\n")).toBe("linux_amd64");
    expect(goAgentFile("aarch64")).toBe("linux_arm64");
    expect(goAgentFile("arm64")).toBe("linux_arm64");
    expect(goAgentFile("riscv64")).toBeNull();
  });
});

const opts = {
  profile: "work", host: "devbox-work",
  localRoot: "/Users/me/devbox/work", remoteRoot: "/home/work/sync",
  ignores: ["node_modules", "dist"],
};

describe("mutagen argv", () => {
  test("sessionName is devbox-<profile>", () => {
    expect(sessionName("work")).toBe("devbox-work");
  });
  test("create uses two-way-safe, labels, vcs+dir ignores, never two-way-resolved", () => {
    const a = buildCreateArgs(opts);
    expect(a.slice(0, 2)).toEqual(["sync", "create"]);
    expect(a).toContain("--name=devbox-work");
    expect(a).toContain("--label=devbox=true");
    expect(a).toContain("--sync-mode=two-way-safe");
    expect(a).toContain("--ignore-vcs");
    expect(a).toContain("--ignore=node_modules");
    expect(a).toContain("--ignore=dist");
    expect(a).not.toContain("--sync-mode=two-way-resolved");
    expect(a[a.length - 2]).toBe("/Users/me/devbox/work");
    expect(a[a.length - 1]).toBe("devbox-work:/home/work/sync");
  });
  test("status filters by the devbox label and uses a machine template", () => {
    const a = buildStatusArgs();
    expect(a.slice(0, 3)).toEqual(["sync", "list", "--label-selector=devbox=true"]);
    expect(a[3]).toBe("--template");
  });
  test("status guards .Conflicts behind the embedded SessionState", () => {
    // A paused session has a nil SessionState, and .Conflicts is promoted from it, so an
    // unguarded {{len .Conflicts}} aborts the whole `mutagen sync list` run:
    //   executing "" at <.Conflicts>: reflect: indirection through nil pointer to
    //   embedded struct field SessionState
    // The row is printed first and the process still exits non-zero, so status() would
    // discard every session, not just the paused one.
    const template = buildStatusArgs()[4]!;
    expect(template).toContain("{{if .SessionState}}");
    expect(template).toContain("{{else}}unknown{{end}}");
    expect(template).not.toMatch(/{{\s*len \.Conflicts\s*}}(?!.*{{else}})/);
  });
});

describe("parseStatusOutput", () => {
  test("a paused session still appears, with its real state", () => {
    // Regression: the whole list used to be dropped when any session was paused.
    expect(parseStatusOutput("devbox-work\tDisconnected\t0\n")).toEqual([
      { name: "devbox-work", state: "Disconnected", conflicts: 0 },
    ]);
  });
  test("a paused session does not hide the healthy ones alongside it", () => {
    const out = "devbox-work\tWatching\t2\ndevbox-home\tDisconnected\t0\n";
    expect(parseStatusOutput(out).map((s) => s.name)).toEqual(["devbox-work", "devbox-home"]);
    expect(parseStatusOutput(out)[0]!.conflicts).toBe(2);
  });
  test("blank lines and a trailing newline are ignored", () => {
    expect(parseStatusOutput("\n\ndevbox-work\tWatching\t0\n\n")).toHaveLength(1);
  });
  test("a malformed row degrades instead of throwing", () => {
    expect(parseStatusOutput("devbox-work\n")).toEqual([
      { name: "devbox-work", state: "", conflicts: null },
    ]);
  });
});

/**
 * Fake `mutagen` and `launchctl` on PATH, plus a fake HOME for the plist. Every
 * invocation appends its argv to one log, because the ORDER is the contract: mutagen
 * refuses `daemon register` while a daemon runs, so a register that is not preceded by
 * a stop silently does nothing — which is exactly how a client ends up with a sync
 * that never comes back after a reboot.
 *
 * `refusals` models the real race: `daemon stop` returns before the process is gone, so
 * the first N registers answer "unable to alter registration while daemon is running".
 */
function withFakeDaemonTools(
  behavior: { loaded?: boolean; refusals?: number },
  fn: (log: () => string[], home: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "devbox-mutagen-autostart-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const logFile = join(root, "calls.log");
  writeFileSync(logFile, "");

  // `launchctl print` decides "already loaded"; `bootstrap` always succeeds. `mutagen
  // daemon register` writes the plist the real one writes, so the fs branch is real.
  const plist = join(home, "Library", "LaunchAgents", `${MUTAGEN_AGENT_LABEL}.plist`);
  writeFileSync(
    join(bin, "launchctl"),
    `#!/bin/sh\necho "launchctl $*" >> ${logFile}\n[ "$1" = print ] && exit ${behavior.loaded ? 0 : 1}\nexit 0\n`,
  );
  const refusals = behavior.refusals ?? 0;
  writeFileSync(
    join(bin, "mutagen"),
    `#!/bin/sh\necho "mutagen $*" >> ${logFile}\n`
      + `if [ "$2" = register ]; then\n`
      + `  tries=$(grep -c "daemon register" ${logFile})\n`
      + `  [ "$tries" -le ${refusals} ] && exit 1\n`
      + `  printf '' > ${plist}\n`
      + `fi\nexit 0\n`,
  );
  chmodSync(join(bin, "launchctl"), 0o755);
  chmodSync(join(bin, "mutagen"), 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    fn(() => readFileSync(logFile, "utf8").split("\n").filter(Boolean), home);
  } finally {
    process.env.PATH = originalPath;
  }
}

const darwinOnly = process.platform === "darwin" ? describe : describe.skip;

darwinOnly("ensureDaemonAutostart", () => {
  test("stops the daemon before registering it, then hands the restart to launchd", () => {
    withFakeDaemonTools({}, (log, home) => {
      ensureDaemonAutostart(home);
      const calls = log();
      const stop = calls.indexOf("mutagen daemon stop");
      const register = calls.indexOf("mutagen daemon register");
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(register).toBeGreaterThan(stop);
      expect(calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
      expect(calls.at(-1)).toBe("mutagen daemon start");
      expect(existsSync(join(home, "Library", "LaunchAgents", `${MUTAGEN_AGENT_LABEL}.plist`))).toBe(true);
    });
  });

  test("an already-loaded agent is left alone — no stop, no restart", () => {
    withFakeDaemonTools({ loaded: true }, (log, home) => {
      ensureDaemonAutostart(home);
      expect(log().some((c) => c.startsWith("mutagen"))).toBe(false);
    });
  });

  test("registers through the shutdown window instead of giving up on the first refusal", () => {
    withFakeDaemonTools({ refusals: 3 }, (log, home) => {
      ensureDaemonAutostart(home);
      expect(log().filter((c) => c === "mutagen daemon register")).toHaveLength(4);
      expect(existsSync(join(home, "Library", "LaunchAgents", `${MUTAGEN_AGENT_LABEL}.plist`))).toBe(true);
      expect(log().some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
    });
  });

  // The bound it asserts is 30 attempts a tenth of a second apart, so the test cannot
  // finish inside the default 5s budget on a loaded machine.
  test("a permanently refused registration restarts the daemon it stopped, and bounds its retries", () => {
    withFakeDaemonTools({ refusals: 999 }, (log, home) => {
      ensureDaemonAutostart(home);
      const calls = log().filter((c) => c.startsWith("mutagen"));
      expect(calls[0]).toBe("mutagen daemon stop");
      expect(calls.at(-1)).toBe("mutagen daemon start");
      expect(calls.filter((c) => c === "mutagen daemon register")).toHaveLength(30);
      expect(log().some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
    });
  }, 30_000);
});
