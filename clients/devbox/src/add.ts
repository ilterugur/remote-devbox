/**
 * add.ts — `devbox add`: register the current git repo as a claude-devbox project.
 *
 * Detects the project (origin remote → canonical SSH url, branch, name), targets a
 * profile, and either PREVIEWS the YAML snippets + the playbook command (default, and
 * whenever DEVBOX_DRYRUN is set) or — with --write — does a comment-preserving textual
 * insert into the repo's config under that developer's `projects:`. The canonical
 * `devbox.yml` is preferred; `ansible/group_vars/all.yml` is only used on a checkout
 * that has not been migrated yet. Always-on Remote Control servers exist only in the
 * legacy layout, so on devbox.yml no `servers:` entry is written.
 *
 * It NEVER runs the playbook: that has remote side effects and needs the operator /
 * Tailscale secrets, which aren't present on every client. The `/<prefix>-add-project`
 * slash command drives the playbook run (and the GitHub-access check) with confirmation.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, die, resolveProfile } from "./config";

/** Convert any git remote URL (https://, ssh://, scp-like git@host:path) to the
 *  canonical `git@host:owner/repo.git` form used in group_vars for private clones. */
export function toSshUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/^[a-z+]+:\/\//i, ""); // scheme: https:// ssh:// git://
  u = u.replace(/^[^@/]*@/, ""); // user@  (only when it precedes the host, before any /)
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = u.match(/^([^/:]+)[/:](.+)$/); // host <sep> path  (sep is ':' for scp-like, '/' otherwise)
  if (!m) die(`cannot parse git remote url: ${url}`);
  const host = m[1];
  const path = m[2].replace(/^\/+/, "").replace(/\/+$/, "");
  return `git@${host}:${path}.git`;
}

const git = (args: string[], cwd: string): string | null => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 && r.stdout ? r.stdout.trim() : null;
};

export type Detected = { name: string; repo: string; branch: string; install: boolean };

/** Inspect the git repo at `cwd` (default: process.cwd()) to fill name/repo/branch.
 *  `install` is auto-detected from a root package.json: a repo without one (an Ansible
 *  or shell toolkit, e.g. claude-devbox itself) gets `install: false`, so the projects
 *  role's `bun install` doesn't fail with "could not find a package.json file". */
export function detectProject(opts: { name?: string; branch?: string; cwd?: string }): Detected {
  const cwd = opts.cwd ?? process.cwd();
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) die("not inside a git repository (run this from the project you want to add)");
  const origin = git(["remote", "get-url", "origin"], cwd);
  if (!origin) die("this repo has no 'origin' remote — add one, or pass the repo url by hand");
  const branch = opts.branch ?? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "main";
  const name = opts.name ?? top.split("/").pop()!;
  const install = existsSync(join(top, "package.json"));
  return { name, repo: toSshUrl(origin), branch, install };
}

/** The YAML block for one project, indented to match group_vars (6-space list items).
 *  Writes the FULL schema (install/update/ports) — a partial entry crashes the projects
 *  role, because a missing `update` key makes Jinja's `item.update` resolve to the dict's
 *  built-in .update() method instead of the value. Defaults mirror all.example.yml. */
export function projectEntry(d: Detected): string {
  const installLine = d.install
    ? "        install: true # run `bun install` after clone\n"
    : "        install: false # no package.json at repo root — nothing to install\n";
  return (
    `      - name: ${d.name}\n` +
    `        repo: "${d.repo}"\n` +
    `        branch: ${d.branch}\n` +
    installLine +
    `        update: false # don't git-pull over Claude's local edits\n` +
    `        ports: []\n`
  );
}

/** Human-friendly title from a repo name: "example-monorepo" → "Example Monorepo". */
export function titleize(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export type ServerOpts = { name?: string; spawn?: string; capacity?: number };

/** The YAML block for one always-on Remote Control server, 6-space indented to sit
 *  under a profile's `servers:`. References the project by name; `name` is the title
 *  shown in the phone app. Defaults mirror the live config (worktree spawn, capacity 32). */
export function serverEntry(projectName: string, opts: ServerOpts = {}): string {
  const title = opts.name ?? titleize(projectName);
  const spawn = opts.spawn ?? "worktree";
  const capacity = opts.capacity ?? 32;
  return (
    `      - project: ${projectName}\n` +
    `        name: "${title}" # title shown in the phone app\n` +
    `        spawn: ${spawn} # worktree | same-dir | session\n` +
    `        capacity: ${capacity}\n`
  );
}

const cleaned = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

/** [start, end) line range of the `- user: <user>` profile block, plus its list indent.
 *  The block ends at the next `- user:` at the same indent (or EOF). Dies if absent. */
function findProfile(lines: string[], user: string): { start: number; end: number; userIndent: number } {
  let start = -1;
  let userIndent = 2;
  for (let j = 0; j < lines.length; j++) {
    const m = lines[j].match(/^(\s*)-\s+user:\s*(.+?)\s*$/);
    if (m && cleaned(m[2]) === user) {
      start = j;
      userIndent = m[1].length;
      break;
    }
  }
  if (start < 0) die(`developer "${user}" not found in the config`);

  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const m = lines[j].match(/^(\s*)-\s+user:/);
    if (m && m[1].length === userIndent) {
      end = j;
      break;
    }
  }
  return { start, end, userIndent };
}

/** Line index of a `key:` mapping at exactly keyIndent within [start, end), or -1. */
function findKeyLine(lines: string[], start: number, end: number, keyIndent: number, key: string): number {
  for (let j = start + 1; j < end; j++) {
    if (new RegExp(`^\\s{${keyIndent}}${key}:\\s*$`).test(lines[j])) return j;
  }
  return -1;
}

/** Given the line index of a list-key (at keyIndent), return where its list ends:
 *  the first non-blank in-block line indented <= keyIndent, or `end`. */
function listEnd(lines: string[], keyLine: number, end: number, keyIndent: number): number {
  for (let j = keyLine + 1; j < end; j++) {
    if (lines[j].trim() === "") continue;
    const ind = lines[j].match(/^(\s*)/)![1].length;
    if (ind <= keyIndent) return j;
  }
  return end;
}

/**
 * Insert `snippet` at the end of `user`'s `projects:` list. The `- user:` /
 * `projects:` shape is identical in devbox.yml and the legacy group_vars file, so one
 * implementation serves both.
 * preserving every other line (comments included). Refuses (via die) if the profile
 * or its projects: block is missing, or a project of `name` already exists there.
 * Pure: returns the new content, touches no files.
 */
export function addProjectToYaml(content: string, user: string, snippet: string, name: string): string {
  const lines = content.split("\n");
  const { start, end, userIndent } = findProfile(lines, user);
  const keyIndent = userIndent + 2;

  const pj = findKeyLine(lines, start, end, keyIndent, "projects");
  if (pj < 0) die(`developer "${user}" has no projects: block in the config`);
  const pend = listEnd(lines, pj, end, keyIndent);

  for (let j = pj + 1; j < pend; j++) {
    const nm = lines[j].match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (nm && cleaned(nm[1]) === name) die(`profile "${user}" already has a project named "${name}"`);
  }

  const snippetLines = snippet.replace(/\n$/, "").split("\n");
  lines.splice(pend, 0, ...snippetLines);
  return lines.join("\n");
}

/**
 * Insert `snippet` at the end of `user`'s `servers:` list, creating the `servers:`
 * block (right after `projects:`) if the profile doesn't have one. Refuses (via die)
 * if a server for `projectName` already exists. Pure: returns the new content.
 */
export function addServerToYaml(content: string, user: string, snippet: string, projectName: string): string {
  const lines = content.split("\n");
  const { start, end, userIndent } = findProfile(lines, user);
  const keyIndent = userIndent + 2;
  const snippetLines = snippet.replace(/\n$/, "").split("\n");

  const sj = findKeyLine(lines, start, end, keyIndent, "servers");
  if (sj >= 0) {
    const send = listEnd(lines, sj, end, keyIndent);
    for (let j = sj + 1; j < send; j++) {
      const pm = lines[j].match(/^\s*-?\s*project:\s*(.+?)\s*$/);
      if (pm && cleaned(pm[1]) === projectName)
        die(`profile "${user}" already has a server for project "${projectName}"`);
    }
    lines.splice(send, 0, ...snippetLines);
    return lines.join("\n");
  }

  // No servers: block yet — create one right after projects: (or at the block's end).
  const pj = findKeyLine(lines, start, end, keyIndent, "projects");
  const insertAt = pj >= 0 ? listEnd(lines, pj, end, keyIndent) : end;
  const header = `${" ".repeat(keyIndent)}servers: # always-on Remote Control servers (one per project) for the phone`;
  lines.splice(insertAt, 0, header, ...snippetLines);
  return lines.join("\n");
}

export type AddOpts = {
  name?: string;
  branch?: string;
  profile?: string;
  write?: boolean;
  /** Also add an always-on Remote Control server (default true; --no-server disables). */
  server?: boolean;
  serverName?: string;
  spawn?: string;
  capacity?: number;
};

/**
 * Which config file owns the developer list. devbox.yml is the source of truth; the
 * legacy group_vars file is a fallback so a checkout mid-migration still works.
 * `servers` is false for the canonical layout — always-on RC servers are not part of it.
 */
export function targetConfig(repoPath: string): { path: string; canonical: boolean } {
  const canonical = join(repoPath, "devbox.yml");
  if (existsSync(canonical)) return { path: canonical, canonical: true };
  return { path: join(repoPath, "ansible", "group_vars", "all.yml"), canonical: false };
}

/** CLI entrypoint for `devbox add`. Preview unless --write (and never on DEVBOX_DRYRUN). */
export function runAdd(cfg: Config, opts: AddOpts) {
  const prof = resolveProfile(cfg, opts.profile);
  const d = detectProject(opts);
  const target = cfg.repoPath ? targetConfig(cfg.repoPath) : null;
  // No servers: block to write into on the canonical layout, so don't pretend otherwise.
  const wantServer = opts.server !== false && target?.canonical !== true;
  const projSnippet = projectEntry(d);
  const srvSnippet = wantServer
    ? serverEntry(d.name, { name: opts.serverName, spawn: opts.spawn, capacity: opts.capacity })
    : "";
  const repoForCmd = cfg.repoPath ?? "<claude-devbox-repo>";
  // `remote` brings the new always-on RC server online; drop it when --no-server.
  const tags = wantServer ? "projects,remote" : "projects";
  // On the canonical layout the CLI applies it; the legacy one still needs raw ansible
  // because `devbox apply` regenerates vars from devbox.yml, which does not exist there.
  const playbookCmd = target?.canonical
    ? `devbox apply projects`
    : `cd ${repoForCmd}/ansible && ansible-playbook -i inventory.ini playbook.yml --tags ${tags}`;

  const preview = !opts.write || !!process.env.DEVBOX_DRYRUN;
  if (preview) {
    const where =
      target?.path ??
      "devbox.yml  (repoPath not set — `--write` will fail until you re-run gen-editor-config.py --cli)";
    const serverBlock = wantServer
      ? `\nand an always-on Remote Control server under its servers:\n\n${srvSnippet}\n`
      : target?.canonical
        ? "\n(devbox.yml has no servers: block — declare always-on agents separately)\n"
        : "\n(--no-server: no Remote Control server will be added)\n";
    process.stdout.write(
      `Add project '${d.name}' to profile '${prof}'.\n\n` +
        `Would insert under that developer's projects: in\n  ${where}\n\n${projSnippet}` +
        `${serverBlock}\n` +
        `Then apply on the box:\n  ${playbookCmd}\n`,
    );
    return;
  }

  // --write: edit the config in place. Still does NOT run the playbook.
  if (!cfg.repoPath || !target) {
    die("config has no repoPath — re-run `gen-editor-config.py --cli` to record the repo location");
  }
  const ymlPath = target.path;
  if (!existsSync(ymlPath)) die(`no devbox.yml or group_vars/all.yml under ${cfg.repoPath}`);
  let after = addProjectToYaml(readFileSync(ymlPath, "utf8"), prof, projSnippet, d.name);
  if (wantServer) after = addServerToYaml(after, prof, srvSnippet, d.name);
  writeFileSync(ymlPath, after);
  const what = wantServer ? `project '${d.name}' + Remote Control server` : `project '${d.name}'`;
  process.stdout.write(
    `✓ added ${what} to profile '${prof}' in\n  ${ymlPath}\n\n` +
      `Now apply on the box:\n  ${playbookCmd}\n`,
  );
}
