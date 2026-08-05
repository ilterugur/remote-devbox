import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appConfigsFor, pickTransport, profilesFromYaml, resolveCfgDir, transportPort, type Config } from "./config";

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

describe("profilesFromYaml — which config file wins", () => {
  const DEVBOX_YML = [
    "config_version: 3",
    "developers:",
    "  - user: dev-a",
    "    projects:",
    '      - name: app',
    '        repo: "git@github.com:example-org/app.git"',
    "  - user: dev-b",
    "    projects: []",
    "",
  ].join("\n");

  const LEGACY_YML = [
    "profiles:",
    "  - user: legacy-user",
    "    projects:",
    "      - name: legacy-app",
    '        repo: "git@github.com:example-org/legacy.git"',
    "",
  ].join("\n");

  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "devbox-repo-"));
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
    return dir;
  };

  test("devbox.yml is read when present", () => {
    const out = profilesFromYaml(repo({ "devbox.yml": DEVBOX_YML }));
    expect(out?.map((p) => p.user)).toEqual(["dev-a", "dev-b"]);
    expect(out?.[0]!.projects).toEqual([{ name: "app", repo: "git@github.com:example-org/app.git" }]);
  });

  test("canonical devbox.yml carries the file bridge onto the profile", () => {
    const out = profilesFromYaml(
      repo({
        "devbox.yml": [
          "developers:",
          "  - user: work",
          "    file_bridge:",
          "      sync_disk: true",
          "      engine: syncthing",
          "",
        ].join("\n"),
      }),
    );
    expect(out?.[0]!.syncDisk).toBe(true);
    expect(out?.[0]!.syncEngine).toBe("syncthing");
  });

  test("devbox.yml wins over a legacy file that is still lying around", () => {
    const out = profilesFromYaml(
      repo({ "devbox.yml": DEVBOX_YML, "ansible/group_vars/all.yml": LEGACY_YML }),
    );
    expect(out?.map((p) => p.user)).toEqual(["dev-a", "dev-b"]);
  });

  test("a checkout that has not been migrated still works", () => {
    const out = profilesFromYaml(repo({ "ansible/group_vars/all.yml": LEGACY_YML }));
    expect(out?.map((p) => p.user)).toEqual(["legacy-user"]);
  });

  test("neither file present yields null so the cache is used", () => {
    expect(profilesFromYaml(repo({}))).toBeNull();
  });

  test("a devbox.yml with no developers falls through to the legacy file", () => {
    const out = profilesFromYaml(
      repo({ "devbox.yml": "config_version: 3\ndevelopers: []\n", "ansible/group_vars/all.yml": LEGACY_YML }),
    );
    expect(out?.map((p) => p.user)).toEqual(["legacy-user"]);
  });

  test("canonical devbox.yml carries resolved app configs onto the profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "devbox-cfg-"));
    writeFileSync(join(dir, "devbox.yml"), [
      "developers:",
      "  - user: work",
      "    file_bridge: { sync_disk: true }",
      "    app_configs:",
      "      enabled: true",
      "      paths: [filezilla]",
    ].join("\n"));
    const profs = profilesFromYaml(dir)!;
    expect(profs[0].appConfigs?.[0].label).toBe("filezilla");
    expect(profs[0].appConfigs?.[0].mode).toBe("dir");
  });

  test("appConfigsFor is empty when the block is absent", () => {
    const cfg: Config = { prefix: "devbox", default: "work", locale: "en_US.UTF-8", launch: "claude",
      profiles: [{ user: "work", projects: [] }] };
    expect(appConfigsFor(cfg, "work")).toEqual([]);
  });
});

describe("pickTransport", () => {
  const all = () => true;
  const none = () => false;

  test("auto takes the fastest accelerator that can actually reach the box", () => {
    expect(pickTransport({ want: "auto", has: all, canReach: all }).pick).toBe("et");
    expect(pickTransport({ want: "auto", has: (b) => b === "mosh", canReach: all }).pick).toBe("mosh");
  });

  test("auto falls back to ssh when the accelerator's port is firewalled here", () => {
    const r = pickTransport({ want: "auto", has: all, canReach: (t) => t !== "et" });
    expect(r.pick).toBe("ssh");
    expect(r.note).toContain("et");
  });

  test("auto with nothing installed and no install offered lands on ssh", () => {
    expect(pickTransport({ want: "auto", has: none, canReach: all }).pick).toBe("ssh");
  });

  test("auto offers to install et, but only uses it if it can reach", () => {
    expect(pickTransport({ want: "auto", has: none, canReach: all, offerInstall: all }).pick).toBe("et");
    expect(pickTransport({ want: "auto", has: none, canReach: none, offerInstall: all }).pick).toBe("ssh");
  });

  test("an explicit choice is still not forced through an unreachable port", () => {
    const r = pickTransport({ want: "et", has: all, canReach: none });
    expect(r.pick).toBe("ssh");
    expect(r.note).toContain("et");
  });

  test("an explicit choice is honoured when it can reach", () => {
    expect(pickTransport({ want: "et", has: all, canReach: all })).toEqual({ pick: "et" });
  });

  test("ssh is never probed away", () => {
    expect(pickTransport({ want: "ssh", has: none, canReach: none })).toEqual({ pick: "ssh" });
  });
});

describe("transportPort", () => {
  test("et is a fixed port, ssh follows the alias, mosh cannot be probed", () => {
    expect(transportPort("et", 22)).toBe(2022);
    expect(transportPort("ssh", 2222)).toBe(2222);
    expect(transportPort("mosh", 22)).toBeNull();
  });
});

describe("resolveCfgDir", () => {
  const home = () => mkdtempSync(join(tmpdir(), "devbox-home-"));
  const seed = (h: string, dir: string) => {
    mkdirSync(join(h, ".config", dir), { recursive: true });
    writeFileSync(join(h, ".config", dir, "config.json"), "{}");
  };

  test("prefers the canonical directory when both exist", () => {
    const h = home();
    seed(h, "claude-devbox");
    seed(h, "remote-devbox");
    expect(resolveCfgDir(h)).toBe(join(h, ".config", "remote-devbox"));
  });

  test("still reads the pre-rename directory when it is the only one", () => {
    // An existing client must keep working — this is the case that silently broke when a
    // second writer put a config in the other directory.
    const h = home();
    seed(h, "claude-devbox");
    expect(resolveCfgDir(h)).toBe(join(h, ".config", "claude-devbox"));
  });

  test("a fresh client resolves to the canonical directory", () => {
    expect(resolveCfgDir(home())).toMatch(/\/\.config\/remote-devbox$/);
  });

  test("an empty directory without config.json does not win", () => {
    const h = home();
    mkdirSync(join(h, ".config", "remote-devbox"), { recursive: true });
    seed(h, "claude-devbox");
    expect(resolveCfgDir(h)).toBe(join(h, ".config", "claude-devbox"));
  });
});
