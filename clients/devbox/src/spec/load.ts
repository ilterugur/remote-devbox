/**
 * load.ts — the only module in spec/ that touches the filesystem.
 *
 * Runs the whole pipeline (parse → structure → references → resolve) and hands back
 * either a fully resolved spec or the issues that stopped it. Nothing throws: a missing
 * file and a syntax error are both just issues, so `devbox plan` renders them the same
 * way as a bad reference.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Issue, err, hasErrors } from "./issues";
import { renderVars } from "./normalize";
import { validateReferences } from "./references";
import { resolveSpec } from "./resolve";
import type { ResolvedSpec } from "./types";
import { validateStructure } from "./validate";

export interface LoadResult {
  resolved: ResolvedSpec | null;
  issues: Issue[];
}

export function loadSpec(path: string): LoadResult {
  if (!existsSync(path)) {
    return { resolved: null, issues: [err("", `config not found: ${path}`)] };
  }

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { resolved: null, issues: [err("", `could not parse ${path}: ${(e as Error).message}`)] };
  }

  const structural = validateStructure(raw);
  if (!structural.spec) return { resolved: null, issues: structural.issues };

  // References are only meaningful on a structurally sound spec, and resolution is only
  // meaningful once references hold — otherwise a typo'd identity name reads as an
  // "ambiguous choice" error and buries the real cause.
  const issues = [...structural.issues, ...validateReferences(structural.spec)];
  if (hasErrors(issues)) return { resolved: null, issues };

  const resolution = resolveSpec(structural.spec);
  return { resolved: resolution.resolved, issues: [...issues, ...resolution.issues] };
}

/** devbox.secrets.yml always sits next to the config it belongs to. */
export const secretsPathFor = (configPath: string): string =>
  join(dirname(configPath), "devbox.secrets.yml");

/** Write the normalized vars Ansible consumes. Returns the path written. */
export function writeGeneratedVars(resolved: ResolvedSpec, repoRoot: string): string {
  const dir = join(repoRoot, "ansible", ".generated");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "all.yml");
  writeFileSync(path, renderVars(resolved));
  return path;
}
