import { describe, expect, test } from "bun:test";
import { buildCreateArgs, buildStatusArgs, parseStatusOutput, sessionName, goAgentFile } from "./mutagen";

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
    expect(template).toContain("{{else}}0{{end}}");
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
      { name: "devbox-work", state: "", conflicts: 0 },
    ]);
  });
});
