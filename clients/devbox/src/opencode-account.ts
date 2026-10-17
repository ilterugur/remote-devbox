/**
 * opencode-account.ts — the client half of the manual OpenCode account swap.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import engineScript from "../../../scripts/devbox-opencode-account.sh" with { type: "text" };
import { type Config, die, hostFor, loadConfig, resolveProfile, shQuote } from "./config";

export const OPENCODE_ACCOUNT_VERBS = ["ls", "status", "add", "use", "rm", "gc"] as const;
export type OpencodeAccountVerb = (typeof OPENCODE_ACCOUNT_VERBS)[number];
const LABEL_REQUIRED: readonly OpencodeAccountVerb[] = ["add", "use", "rm"];
const LABEL_RE = /^[A-Za-z0-9._-]+$/;
export const DEFAULT_OPENCODE_AGENT_PROFILE = "omp-main";

export type OpencodeAccountOpts = {
  json?: boolean;
  force?: boolean;
  keep?: string | number;
  key?: string;
};

export function opencodeAccountArgs(verb: string, label?: string, opts: OpencodeAccountOpts = {}): string[] {
  if (!(OPENCODE_ACCOUNT_VERBS as readonly string[]).includes(verb))
    throw new Error(`unknown opencode-account action "${verb}" (have: ${OPENCODE_ACCOUNT_VERBS.join(" ")})`);
  const v = verb as OpencodeAccountVerb;
  if (label !== undefined && label !== "" && !LABEL_RE.test(label))
    throw new Error(`label "${label}" may only contain letters, digits, '.', '_' and '-'`);
  if (LABEL_REQUIRED.includes(v) && !label)
    throw new Error(`opencode-account ${v} needs a label: devbox opencode-account ${v} <label>`);
  const argv: string[] = [v];
  if (label) argv.push(label);
  if (opts.json) argv.push("--json");
  if (opts.force) argv.push("--force");
  if (opts.keep !== undefined && opts.keep !== "") argv.push("--keep", String(opts.keep));
  if (opts.key) argv.push("--key", opts.key);
  return argv;
}

const ENGINE_DIGEST = createHash("sha256").update(engineScript).digest("hex").slice(0, 16);

export function opencodeEngineScriptPath(): string {
  const path = join(tmpdir(), `devbox-opencode-account-${ENGINE_DIGEST}.sh`);
  try {
    const st = lstatSync(path);
    if (st.isFile() && st.size === Buffer.byteLength(engineScript) && (st.mode & 0o777) === 0o700) return path;
  } catch {
    // not materialised yet
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, engineScript, { mode: 0o700 });
  renameSync(tmp, path);
  return path;
}

const BOX_ENGINE = "/usr/local/share/remote-devbox/devbox-opencode-account.sh";
const boxOmpDir = (user: string, agentProfile: string) => `/home/${user}/.agent-profiles/${agentProfile}`;

export function opencodeRemoteArgv(
  cfg: Config,
  profile: string,
  argv: string[],
  agentProfile: string = DEFAULT_OPENCODE_AGENT_PROFILE,
): string[] {
  const env = [`PI_CODING_AGENT_DIR=${shQuote(boxOmpDir(profile, agentProfile))}`].join(" ");
  const remote = [`env ${env}`, BOX_ENGINE, ...argv.map(shQuote)].join(" ");
  return ["ssh", "-t", hostFor(cfg, profile), remote];
}

export function runOpencodeAccount(argv: string[], opts: { profile?: string; agentProfile?: string } = {}): number {
  if (opts.profile) {
    const cfg = loadConfig();
    const user = resolveProfile(cfg, opts.profile);
    const agentProfile = opts.agentProfile ?? DEFAULT_OPENCODE_AGENT_PROFILE;
    const [cmd, ...rest] = opencodeRemoteArgv(cfg, user, argv, agentProfile);
    const r = spawnSync(cmd!, rest, { stdio: "inherit" });
    if (r.error) die(`could not run ssh: ${r.error.message}`);
    return r.status ?? 1;
  }
  const r = spawnSync(opencodeEngineScriptPath(), argv, { stdio: "inherit" });
  if (r.error) die(`could not run the opencode account engine: ${r.error.message}`);
  return r.status ?? 1;
}
