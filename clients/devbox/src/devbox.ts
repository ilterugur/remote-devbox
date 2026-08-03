#!/usr/bin/env bun
/**
 * devbox — connect to a claude-devbox profile/project over mosh+tmux (ssh fallback),
 * or `devbox push` a Claude Code session to the box and resume it there.
 *
 * Reads ~/.config/claude-devbox/config.json (written by gen-editor-config.py --cli)
 * and the active-profile state file. Bare `devbox` git-auto-opens the matching box
 * project for $PWD, else shows a fuzzy picker. All domain logic lives in config.ts;
 * this file is only the cac wiring. Set DEVBOX_DRYRUN=1 to print commands instead.
 */
import { cac } from "cac";
import { spawnSync } from "node:child_process";
import {
  type Config,
  type Transport,
  connect,
  die,
  gitMatch,
  hostFor,
  lazyMountOnConnect,
  lazyMountsFor,
  loadConfig,
  projectsOf,
  readState,
  resolveProfile,
  users,
  writeState,
} from "./config";
import { pickUI } from "./picker";
import { runPush } from "./push";
import { runPull } from "./pull";
import { runAdd } from "./add";
import { runMountUp, runMountDown, runMountStatus } from "./mount";
import { runSyncUp, runSyncDown, runSyncStatus, runSyncPause } from "./sync";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { formatIssues, hasErrors } from "./spec/issues";
import { loadSpec, writeGeneratedVars } from "./spec/load";
import { isLegacyConfig, migrateLegacy, renderMigration } from "./spec/migrate";
import { renderPlan } from "./spec/plan";

function newHelp(prof: string) {
  const lines = [
    "",
    `  Add a new project to profile '${prof}' (edit the claude-devbox repo, re-run the playbook):`,
    `    1) ansible/group_vars/all.yml — add under that profile's projects:`,
    `         - { name: myproj, repo: "git@github.com:org/myproj.git", branch: main }`,
    `    2) cd ansible && ansible-playbook -i inventory.ini playbook.yml --tags projects`,
    `    3) private repo? add the profile's SSH key to GitHub, then re-run.`,
    `    Then:  devbox myproj`,
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

// Lazy + memoized: `devbox plan` / `migrate-config` operate on devbox.yml and must
// work on a machine that has never run gen-editor-config.py (loadConfig() die()s
// when ~/.config/claude-devbox/config.json is absent).
let _cfg: Config | null = null;
const cfg = (): Config => (_cfg ??= loadConfig());

const cli = cac("devbox");

cli
  .command("use [profile]", "show, or set, the remembered active profile")
  .action((profile?: string) => {
    const active = readState() ?? cfg().default;
    if (!profile) {
      console.log(`active profile: ${active}`);
      if (users(cfg()).length > 1) {
        console.log("profiles:");
        for (const u of users(cfg())) console.log(`  ${u === active ? "●" : "○"} ${u}`);
        console.log(`switch with:  devbox use <profile>   (or ⌃p in the picker)`);
      }
      return;
    }
    if (!users(cfg()).includes(profile)) die(`unknown profile "${profile}" (have: ${users(cfg()).join(" ")})`);
    writeState(profile);
    console.log(`active profile -> ${profile}`);
  });

cli
  .command("ls [profile]", "list open (attachable) tmux sessions")
  .action((profile?: string) => {
    const prof = resolveProfile(cfg(), profile);
    const env = { ...process.env, LANG: cfg().locale, LC_ALL: cfg().locale, LC_CTYPE: cfg().locale };
    if (process.env.DEVBOX_DRYRUN) {
      return void process.stdout.write(JSON.stringify(["ssh", hostFor(cfg(), prof), "tmux ls ..."]) + "\n");
    }
    const r = spawnSync("ssh", [hostFor(cfg(), prof), "tmux ls 2>/dev/null || echo '(no open sessions)'"], {
      stdio: "inherit",
      env,
    });
    process.exit(r.status ?? 0);
  });

cli
  .command("push [project]", "copy the current (or picked) session to the box and resume it there")
  .option("--session <id>", "session id (default: $CLAUDE_CODE_SESSION_ID, else newest in $PWD)")
  .option("--pick", "fuzzy-pick a recent session for this project")
  .option("-p, --profile <profile>", "target profile (required when origin is unmatched/ambiguous)")
  .option("--remote-cwd <dir>", "override the remote project root (required for worktree sources)")
  .option("--map <pair>", "extra path mapping OLD=NEW (repeatable)")
  .option("--remap-home", "also remap /Users/<you> -> /home/<profile>")
  .option("--no-sidecar", "do not transfer the <id>/ sidecar dir")
  .option("--go", "after push, connect and `claude --resume` on the box")
  .option("--yes", "skip the confirmation prompt")
  .option("--force", "overwrite even if the remote copy is live or newer")
  .action(async (project: string | undefined, opts: Record<string, unknown>) => {
    const maps = opts.map ? (Array.isArray(opts.map) ? (opts.map as string[]) : [opts.map as string]) : [];
    await runPush(cfg(), {
      project,
      session: opts.session as string | undefined,
      pick: !!opts.pick,
      profile: opts.profile as string | undefined,
      remoteCwd: opts.remoteCwd as string | undefined,
      map: maps,
      remapHome: !!opts.remapHome,
      sidecar: opts.sidecar !== false,
      go: !!opts.go,
      yes: !!opts.yes,
      force: !!opts.force,
    });
  });

cli
  .command("pull [project]", "copy a session FROM the box back to the client (mirror of push)")
  .option("--session <id>", "box session id to pull (required unless --pick)")
  .option("--pick", "fuzzy-pick a session from the box")
  .option("-p, --profile <profile>", "source profile (default: active profile)")
  .option("--local-cwd <dir>", "override the local target dir (default: $PWD)")
  .option("--map <pair>", "extra path mapping OLD=NEW (repeatable)")
  .option("--remap-home", "also remap /home/<profile> -> /Users/<you>")
  .option("--no-sidecar", "do not pull the <id>/ sidecar dir")
  .option("--go", "after pull, `claude --resume` locally")
  .option("--yes", "skip the confirmation prompt")
  .option("--force", "overwrite even if the local copy is live or newer")
  .action(async (project: string | undefined, opts: Record<string, unknown>) => {
    const maps = opts.map ? (Array.isArray(opts.map) ? (opts.map as string[]) : [opts.map as string]) : [];
    await runPull(cfg(), {
      project,
      session: opts.session as string | undefined,
      pick: !!opts.pick,
      profile: opts.profile as string | undefined,
      localCwd: opts.localCwd as string | undefined,
      map: maps,
      remapHome: !!opts.remapHome,
      sidecar: opts.sidecar !== false,
      go: !!opts.go,
      yes: !!opts.yes,
      force: !!opts.force,
    });
  });

cli
  .command("mount [action]", "lazy-mount configured client paths on the box (action: up|down|status)")
  .option("-p, --profile <profile>", "target profile")
  .option("--label <label>", "only this mount (for down)")
  .action((action: string | undefined, opts: { profile?: string; label?: string }) => {
    const prof = resolveProfile(cfg(), opts.profile);
    switch (action ?? "up") {
      case "up": return runMountUp(cfg(), prof);
      case "down": return runMountDown(cfg(), prof, opts.label);
      case "status": return runMountStatus();
      default: return die(`unknown mount action "${action}" (up|down|status)`);
    }
  });

cli
  .command("sync [action]", "two-way sync the ~/devbox/<profile> disk with the box (action: up|down|status|pause|resume)")
  .option("-p, --profile <profile>", "target profile")
  .action(async (action: string | undefined, opts: { profile?: string }) => {
    if ((action ?? "up") === "status") return runSyncStatus(cfg());
    const prof = resolveProfile(cfg(), opts.profile);
    switch (action ?? "up") {
      case "up": return runSyncUp(cfg(), prof);
      case "down": return runSyncDown(cfg(), prof);
      case "pause": return runSyncPause(cfg(), prof, false);
      case "resume": return runSyncPause(cfg(), prof, true);
      default: return die(`unknown sync action "${action}" (up|down|status|pause|resume)`);
    }
  });

cli
  .command("add [name]", "register the current git repo as a project (+ Remote Control server) for a profile")
  .option("-p, --profile <profile>", "target profile (default: active)")
  .option("--branch <branch>", "branch to track (default: current branch)")
  .option("--write", "edit ansible/group_vars/all.yml in place (needs repoPath; never runs the playbook)")
  .option("--no-server", "don't add an always-on Remote Control server (project only)")
  .option("--server-name <title>", "Remote Control title shown in the phone app (default: titleized name)")
  .option("--spawn <mode>", "Remote Control spawn mode: worktree | same-dir | session (default: worktree)")
  .option("--capacity <n>", "Remote Control session capacity (default: 32)")
  .action(
    (
      name: string | undefined,
      opts: {
        profile?: string;
        branch?: string;
        write?: boolean;
        server?: boolean;
        serverName?: string;
        spawn?: string;
        capacity?: string | number;
      },
    ) => {
      runAdd(cfg(), {
        name,
        profile: opts.profile,
        branch: opts.branch,
        write: !!opts.write,
        server: opts.server,
        serverName: opts.serverName,
        spawn: opts.spawn,
        capacity: opts.capacity == null ? undefined : Number(opts.capacity),
      });
    },
  );

cli
  .command("[project]", "connect — picker, or git-auto-open, when no project is given")
  .option("-p, --profile <profile>", "use this profile for this call only")
  .option("-m, --menu", "force the picker (skip git auto-open)")
  .option("-s, --shell", "open a plain shell (skip the auto-launch)")
  .option("--transport <t>", "connection transport: auto|et|mosh|ssh (also: DEVBOX_TRANSPORT)")
  .option("--et", "force Eternal Terminal (shortcut for --transport et)")
  .option("--mosh", "force mosh (shortcut for --transport mosh)")
  .option("--ssh", "force plain ssh+tmux, skipping et/mosh (shortcut for --transport ssh)")
  .action(async (project: string | undefined, opts: { profile?: string; menu?: boolean; shell?: boolean; transport?: string; et?: boolean; mosh?: boolean; ssh?: boolean }) => {
    const prof = resolveProfile(cfg(), opts.profile);
    const transport = (opts.transport ?? (opts.ssh ? "ssh" : opts.et ? "et" : opts.mosh ? "mosh" : undefined)) as Transport | undefined;
    const co = { shellOnly: !!opts.shell, transport };
    if (lazyMountOnConnect(cfg(), prof) && lazyMountsFor(cfg(), prof).length) {
      try { runMountUp(cfg(), prof); } catch (e) { process.stderr.write(`devbox: lazy mount skipped: ${(e as Error).message}\n`); }
    }
    if (project) return connect(cfg(), prof, project, co);
    if (!opts.menu) {
      const m = gitMatch(cfg());
      if (m.length) return connect(cfg(), m[0].profile, m[0].project, co);
    }
    const profilesList = cfg().profiles.map((p) => ({ user: p.user, projects: projectsOf(cfg(), p.user) }));
    const { profile, result } = await pickUI(profilesList, prof);
    if (result === null) return; // cancelled
    if (profile !== prof) writeState(profile); // persist an in-picker profile switch
    if (result === "__home__") return connect(cfg(), profile, null, co);
    if (result === "__new__") return newHelp(profile);
    return connect(cfg(), profile, result, co);
  });

// ── Provisioning config (devbox.yml) ────────────────────────────────────────────
// These two commands do NOT read ~/.config/claude-devbox/config.json — they operate
// on the canonical config in a remote-devbox checkout, so they work on any machine.
cli
  .command("plan", "validate devbox.yml and show the resolved provisioning plan")
  .option("--config <path>", "path to devbox.yml", { default: "devbox.yml" })
  .option("--write-vars", "also write ansible/.generated/all.yml")
  .action((opts: { config: string; writeVars?: boolean }) => {
    const path = resolvePath(opts.config);
    const { resolved, issues } = loadSpec(path);
    if (issues.length) process.stderr.write(`${formatIssues(issues)}\n\n`);
    if (!resolved) {
      process.stderr.write("devbox: plan failed — fix the errors above\n");
      process.exit(1);
    }
    console.log(renderPlan(resolved, issues));
    if (opts.writeVars) {
      // The repo root is the directory holding devbox.yml; ansible/ lives beside it.
      console.log(`\nwrote ${writeGeneratedVars(resolved, dirname(path))}`);
    }
    if (hasErrors(issues)) process.exit(1);
  });

cli
  .command("migrate-config", "convert a legacy group_vars/all.yml into a devbox.yml")
  .option("--from <path>", "legacy group_vars file", { default: "ansible/group_vars/all.yml" })
  .option("--out <path>", "where to write devbox.yml", { default: "devbox.yml" })
  .option("--write", "save --out instead of printing (refuses to overwrite an existing file)")
  .action((opts: { from: string; out: string; write?: boolean }) => {
    const from = resolvePath(opts.from);
    if (!existsSync(from)) die(`no config at ${from}`);
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(readFileSync(from, "utf8"));
    } catch (e) {
      die(`could not parse ${from}: ${(e as Error).message}`);
    }
    if (!isLegacyConfig(raw)) die(`${from} has no 'profiles:' list — nothing to migrate`);

    const { spec, issues } = migrateLegacy(raw as Record<string, unknown>);
    if (issues.length) process.stderr.write(`${formatIssues(issues)}\n\n`);
    const text = renderMigration(spec);

    // Printing is the default on purpose: migration is a review step, not an apply.
    if (!opts.write) {
      process.stdout.write(text);
      process.stderr.write("\n(dry run — pass --write to save; the source file is never modified)\n");
      return;
    }
    const out = resolvePath(opts.out);
    if (existsSync(out)) die(`refusing to overwrite ${out} — move it aside first`);
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
  });

cli.help();
cli.version("0.1.0");
// `bun run src/devbox.ts …` yields argv [bun, script.ts, …args]; a compiled standalone
// binary yields [exe, …args] — one fewer. cac parses from argv[2], so for the compiled
// case reinsert a placeholder "script" slot, otherwise the first arg (the command) is lost.
const argv = process.argv;
const fromSource = argv[1]?.endsWith(".ts") || argv[1]?.endsWith(".js");
cli.parse(fromSource ? argv : [argv[0]!, "devbox", ...argv.slice(1)]);
