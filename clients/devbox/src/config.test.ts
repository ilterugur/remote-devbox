import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profilesFromYaml } from "./config";

/** Make a throwaway claude-devbox checkout with the given all.yml body; return its root. */
function repoWithYaml(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "devbox-cfg-"));
  const dir = join(root, "ansible", "group_vars");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "all.yml"), body);
  return root;
}

describe("profilesFromYaml", () => {
  test("maps profiles, projects, and the snake_case profile options to camelCase", () => {
    const repo = repoWithYaml(
      `profiles:\n` +
        `  - user: dev-a\n` +
        `    git_name: "U"\n` +
        `    projects:\n` +
        `      - name: example-app\n` +
        `        repo: "git@github.com:example-org/example-app.git"\n` +
        `        branch: main\n` +
        `      - name: example-monorepo\n` +
        `        repo: "git@github.com:example-org/example-monorepo.git"\n` +
        `        branch: feat/agent-skills\n` +
        `    lazy_mounts:\n` +
        `      - { label: desktop, path: ~/Desktop }\n` +
        `    sync_engine: syncthing\n` +
        `    sync_disk: true\n` +
        `    lazy_mount_on_connect: true\n`,
    );
    const profs = profilesFromYaml(repo);
    expect(profs).not.toBeNull();
    expect(profs!.length).toBe(1);
    const p = profs![0];
    expect(p.user).toBe("dev-a");
    expect(p.projects.map((pr) => pr.name)).toEqual(["example-app", "example-monorepo"]);
    expect(p.projects[1].repo).toBe("git@github.com:example-org/example-monorepo.git");
    expect(p.lazyMounts).toEqual([{ label: "desktop", path: "~/Desktop" }]);
    expect(p.syncEngine).toBe("syncthing");
    expect(p.syncDisk).toBe(true);
    expect(p.lazyMountOnConnect).toBe(true);
  });

  test("omits absent options and defaults a missing projects list to []", () => {
    const repo = repoWithYaml(`profiles:\n  - user: solo\n`);
    const p = profilesFromYaml(repo)![0];
    expect(p.projects).toEqual([]);
    expect(p.lazyMounts).toBeUndefined();
    expect(p.syncEngine).toBeUndefined();
    expect(p.syncDisk).toBeUndefined();
    expect(p.lazyMountOnConnect).toBeUndefined();
  });

  test("returns null when all.yml is missing (caller falls back to the cache)", () => {
    const root = mkdtempSync(join(tmpdir(), "devbox-cfg-"));
    expect(profilesFromYaml(root)).toBeNull();
  });

  test("returns null on an empty or profile-less document", () => {
    expect(profilesFromYaml(repoWithYaml(`profiles: []\n`))).toBeNull();
    expect(profilesFromYaml(repoWithYaml(`other: 1\n`))).toBeNull();
  });

  test("returns null on malformed YAML", () => {
    expect(profilesFromYaml(repoWithYaml(`profiles:\n  - user: x\n   bad: : :\n`))).toBeNull();
  });
});
