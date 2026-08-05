import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  addProjectToYaml,
  addServerToYaml,
  detectProject,
  projectEntry,
  serverEntry,
  setGitExec,
  targetConfig,
  titleize,
  toSshUrl,
} from "./add";

/**
 * A directory that answers git's questions the way a checkout would, without being one.
 * The directory is real because that half is the point — `install` is decided by whether
 * a package.json sits at the repo root — but git itself is stubbed: spawning it here made
 * the tests fail under parallel load for reasons that had nothing to do with add.ts.
 */
function makeRepo(withPackageJson: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "devbox-add-"));
  if (withPackageJson) writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
  return dir;
}

const fakeGit = (dir: string) => (args: string[]): string | null => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return dir;
  if (args[0] === "remote") return "git@github.com:org/fixture.git";
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
  return null;
};

describe("toSshUrl", () => {
  test("https → git@host:owner/repo.git", () => {
    expect(toSshUrl("https://github.com/org/myproj.git")).toBe("git@github.com:org/myproj.git");
  });
  test("https without .git", () => {
    expect(toSshUrl("https://github.com/org/myproj")).toBe("git@github.com:org/myproj.git");
  });
  test("scp-like git@ passes through canonical", () => {
    expect(toSshUrl("git@github.com:org/myproj.git")).toBe("git@github.com:org/myproj.git");
  });
  test("ssh:// url", () => {
    expect(toSshUrl("ssh://git@github.com/org/myproj.git")).toBe("git@github.com:org/myproj.git");
  });
  test("trailing slash and whitespace", () => {
    expect(toSshUrl("  https://github.com/org/myproj/  ")).toBe("git@github.com:org/myproj.git");
  });
  test("non-github host preserved", () => {
    expect(toSshUrl("https://gitlab.example.com/team/app.git")).toBe("git@gitlab.example.com:team/app.git");
  });
});

describe("projectEntry", () => {
  test("install: true → run `bun install` comment", () => {
    expect(
      projectEntry({ name: "myproj", repo: "git@github.com:org/myproj.git", branch: "main", install: true }),
    ).toBe(
      "      - name: myproj\n" +
        '        repo: "git@github.com:org/myproj.git"\n' +
        "        branch: main\n" +
        "        install: true # run `bun install` after clone\n" +
        "        update: false # don't git-pull over Claude's local edits\n" +
        "        ports: []\n",
    );
  });

  test("install: false → no-package.json comment (toolkit, not a bun project)", () => {
    expect(
      projectEntry({ name: "ansible-toolkit", repo: "git@github.com:org/ansible-toolkit.git", branch: "main", install: false }),
    ).toBe(
      "      - name: ansible-toolkit\n" +
        '        repo: "git@github.com:org/ansible-toolkit.git"\n' +
        "        branch: main\n" +
        "        install: false # no package.json at repo root — nothing to install\n" +
        "        update: false # don't git-pull over Claude's local edits\n" +
        "        ports: []\n",
    );
  });
});

describe("detectProject install auto-detection", () => {
  const dirs: string[] = [];
  afterAll(() => {
    setGitExec(null);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const detectIn = (withPackageJson: boolean) => {
    const dir = makeRepo(withPackageJson);
    dirs.push(dir);
    setGitExec(fakeGit(dir));
    return detectProject({ cwd: dir });
  };

  test("install: true when the repo has a root package.json", () => {
    expect(detectIn(true).install).toBe(true);
  });

  test("install: false when the repo has no root package.json", () => {
    expect(detectIn(false).install).toBe(false);
  });

  // The rest of the detection, so the stub is exercised as a whole rather than only for
  // the one field these tests were named after.
  test("name, repo and branch come from the repo it was pointed at", () => {
    const d = detectIn(true);
    expect({ name: d.name.startsWith("devbox-add-"), repo: d.repo, branch: d.branch }).toEqual({
      name: true,
      repo: "git@github.com:org/fixture.git",
      branch: "main",
    });
  });
});

describe("titleize", () => {
  test("hyphens and underscores → spaced Title Case", () => {
    expect(titleize("example-monorepo")).toBe("Example Monorepo");
    expect(titleize("ecomm_insight_mcp")).toBe("Ecomm Insight Mcp");
    expect(titleize("app")).toBe("App");
  });
});

describe("serverEntry", () => {
  test("defaults: titleized name, worktree spawn, capacity 32", () => {
    expect(serverEntry("example-monorepo")).toBe(
      "      - project: example-monorepo\n" +
        '        name: "Example Monorepo" # title shown in the phone app\n' +
        "        spawn: worktree # worktree | same-dir | session\n" +
        "        capacity: 32\n",
    );
  });
  test("honors overrides", () => {
    expect(serverEntry("myproj", { name: "Custom", spawn: "session", capacity: 4 })).toBe(
      "      - project: myproj\n" +
        '        name: "Custom" # title shown in the phone app\n' +
        "        spawn: session # worktree | same-dir | session\n" +
        "        capacity: 4\n",
    );
  });
});

const YML = `---
# header comment
profiles:
  - user: dev-a
    git_name: "Uğur"
    projects:
      - name: example-app
        repo: "git@github.com:example-org/example-app.git"
        branch: main
        ports: [3000, 5173]
    servers:
      - project: example-app
        name: "ExampleApp"
  - user: other
    projects:
      - name: alpha
        repo: "git@github.com:org/alpha.git"
        branch: main
`;

const snippet = projectEntry({ name: "myproj", repo: "git@github.com:org/myproj.git", branch: "main", install: true });

describe("addProjectToYaml", () => {
  test("inserts at the end of the correct profile's projects, before servers:", () => {
    const out = addProjectToYaml(YML, "dev-a", snippet, "myproj");
    const lines = out.split("\n");
    const newIdx = lines.findIndex((l) => l.includes("name: myproj"));
    const serversIdx = lines.findIndex((l) => l.trim() === "servers:");
    const portsIdx = lines.findIndex((l) => l.includes("ports:"));
    expect(newIdx).toBeGreaterThan(portsIdx); // after the last existing project
    expect(newIdx).toBeLessThan(serversIdx); // still inside projects:, before servers:
  });

  test("preserves comments and every original line", () => {
    const out = addProjectToYaml(YML, "dev-a", snippet, "myproj");
    expect(out).toContain("# header comment");
    for (const orig of YML.split("\n").filter((l) => l.trim())) expect(out).toContain(orig);
  });

  test("targets the right profile when multiple exist", () => {
    const out = addProjectToYaml(YML, "other", snippet, "myproj");
    const lines = out.split("\n");
    // myproj should land after alpha (in 'other'), i.e. after the first profile's whole block
    const alphaIdx = lines.findIndex((l) => l.includes("name: alpha"));
    const newIdx = lines.findIndex((l) => l.includes("name: myproj"));
    expect(newIdx).toBeGreaterThan(alphaIdx);
    // and NOT inside dev-a's block (before servers:)
    const serversIdx = lines.findIndex((l) => l.trim() === "servers:");
    expect(newIdx).toBeGreaterThan(serversIdx);
  });

  test("refuses a duplicate project name", () => {
    expect(() => addProjectToYaml(YML, "dev-a", snippet, "example-app")).toThrow(/already has a project named/);
  });

  test("refuses an unknown profile", () => {
    expect(() => addProjectToYaml(YML, "nope", snippet, "myproj")).toThrow(/not found/);
  });
});

const srv = serverEntry("myproj", { name: "MyProj" });

describe("addServerToYaml", () => {
  test("appends to an existing servers: block", () => {
    const out = addServerToYaml(YML, "dev-a", srv, "myproj");
    const lines = out.split("\n");
    const serversIdx = lines.findIndex((l) => l.trim() === "servers:");
    const exampleIdx = lines.findIndex((l) => l.includes('name: "ExampleApp"'));
    const newIdx = lines.findIndex((l) => l.includes("project: myproj"));
    expect(newIdx).toBeGreaterThan(serversIdx);
    expect(newIdx).toBeGreaterThan(exampleIdx); // after the existing server
  });

  test("creates a servers: block when the profile has none, right after projects:", () => {
    const out = addServerToYaml(YML, "other", srv, "myproj");
    const lines = out.split("\n");
    // The new servers: must belong to 'other' (after alpha), not the first profile.
    const alphaIdx = lines.findIndex((l) => l.includes("name: alpha"));
    const serversIdxs = lines.map((l, i) => (l.trim().startsWith("servers:") ? i : -1)).filter((i) => i >= 0);
    const otherServers = serversIdxs.find((i) => i > alphaIdx)!;
    expect(otherServers).toBeGreaterThan(alphaIdx);
    const newIdx = lines.findIndex((l) => l.includes("project: myproj"));
    expect(newIdx).toBeGreaterThan(otherServers);
  });

  test("preserves every original line", () => {
    const out = addServerToYaml(YML, "other", srv, "myproj");
    for (const orig of YML.split("\n").filter((l) => l.trim())) expect(out).toContain(orig);
  });

  test("refuses a duplicate server for the same project", () => {
    expect(() => addServerToYaml(YML, "dev-a", srv, "example-app")).toThrow(/already has a server/);
  });

  test("refuses an unknown profile", () => {
    expect(() => addServerToYaml(YML, "nope", srv, "myproj")).toThrow(/not found/);
  });
});

describe("targetConfig", () => {
  const repo = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "devbox-target-"));
    for (const rel of files) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    return dir;
  };

  test("devbox.yml is the canonical target", () => {
    const dir = repo(["devbox.yml"]);
    expect(targetConfig(dir)).toEqual({ path: join(dir, "devbox.yml"), canonical: true });
  });

  test("devbox.yml wins even when a legacy file is still present", () => {
    const dir = repo(["devbox.yml", "ansible/group_vars/all.yml"]);
    expect(targetConfig(dir).canonical).toBe(true);
  });

  test("a checkout without devbox.yml falls back to group_vars, marked non-canonical", () => {
    const dir = repo(["ansible/group_vars/all.yml"]);
    expect(targetConfig(dir)).toEqual({
      path: join(dir, "ansible", "group_vars", "all.yml"),
      canonical: false,
    });
  });
});
