/**
 * transcript.ts — pure helpers shared by `devbox push` and `devbox pull` for
 * rewriting the absolute paths embedded in a Claude Code transcript when it
 * crosses between the client and the box, plus the (client-side) backup helper.
 *
 * Side-effect-free except for backupLocal()/stageSidecar(), which only touch the
 * paths handed to them. push.ts and pull.ts both import from here; keeping the
 * rewrite logic in one module is what lets the two directions share coverage.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { die, encodeCwd } from "./config";

export type Mapping = { from: string; to: string };

/**
 * Build the ordered path-rewrite list: project root, then user --map entries,
 * then (opt-in) the home remap. Each gets its dash-encoded variant too. Sorted
 * longest-`from`-first so a broad mapping never shadows a specific one.
 *
 * Direction-agnostic: push calls it with (clientCwd, boxRoot); pull calls it with
 * (boxRoot, clientCwd). `homeFrom`/`homeTo` give the home-remap prefixes for the
 * current direction — push maps the client home to /home/<profile>, pull maps
 * /home/<profile> back to the client home.
 */
export function buildMappings(
  sourceRoot: string,
  destRoot: string,
  opts: { map?: string[]; homeFrom?: string; homeTo?: string },
): Mapping[] {
  const base: Mapping[] = [{ from: sourceRoot, to: destRoot }];
  for (const m of opts.map ?? []) {
    const i = m.indexOf("=");
    if (i <= 0 || i === m.length - 1) die(`bad --map "${m}" (expected OLD=NEW)`);
    base.push({ from: m.slice(0, i), to: m.slice(i + 1) });
  }
  if (opts.homeFrom && opts.homeTo) {
    const u = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(opts.homeFrom);
    if (u) base.push({ from: u[1], to: opts.homeTo });
  }
  const all: Mapping[] = [];
  for (const m of base) {
    all.push(m);
    const enc = { from: encodeCwd(m.from), to: encodeCwd(m.to) };
    if (enc.from !== m.from) all.push(enc); // skip if no non-alphanumerics (nothing to encode)
  }
  const seen = new Set<string>();
  return all.filter((m) => (seen.has(m.from) ? false : (seen.add(m.from), true))).sort((a, b) => b.from.length - a.from.length);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Apply every mapping in ONE simultaneous pass (alternation regex, longest-`from`
 * first). A single pass means a mapping's output is never re-scanned and clobbered
 * by a later mapping whose `from` happens to appear in it.
 */
export function applyMappings(text: string, mappings: Mapping[]): string {
  if (!mappings.length) return text;
  const lookup = new Map(mappings.map((m) => [m.from, m.to]));
  const re = new RegExp(mappings.map((m) => escapeRegex(m.from)).join("|"), "g");
  return text.replace(re, (m) => lookup.get(m) ?? m);
}

/** Rewrite a JSONL transcript: per-line replace, then JSON.parse round-trip. */
export function rewriteJsonl(content: string, mappings: Mapping[]): string {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue; // drop blank / partial trailing line
    const rewritten = applyMappings(line, mappings);
    try {
      JSON.parse(rewritten);
    } catch (e) {
      throw new Error(`rewrite produced invalid JSON: ${(e as Error).message}`);
    }
    out.push(rewritten);
  }
  return out.join("\n") + "\n";
}

/** Lines that actually changed (for the dry-run preview). */
export function changedLines(orig: string, mappings: Mapping[], limit = 8): string[] {
  const out: string[] = [];
  for (const line of orig.split("\n")) {
    if (!line.trim()) continue;
    if (applyMappings(line, mappings) !== line) out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

const TEXT_EXTS = new Set([".jsonl", ".json", ".js", ".txt", ".log", ".md"]);

/**
 * Rewrite text files under a sidecar dir into staging; copy everything else (and
 * any file that isn't valid UTF-8, or has no path to rewrite) verbatim so opaque
 * blobs are never lossily transcoded.
 */
export function stageSidecar(srcDir: string, dstDir: string, mappings: Mapping[]): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(srcDir, rel))) {
      const childRel = join(rel, name);
      const childAbs = join(srcDir, childRel);
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!st.isFile()) continue;
      const dst = join(dstDir, childRel);
      mkdirSync(dirname(dst), { recursive: true });
      const ext = extname(name);
      let text: string | null = null;
      if (TEXT_EXTS.has(ext)) {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(childAbs));
        } catch {
          text = null; // not valid UTF-8 — copy verbatim
        }
      }
      if (text !== null && (ext === ".jsonl" || mappings.some((m) => text!.includes(m.from)))) {
        writeFileSync(dst, ext === ".jsonl" ? rewriteJsonl(text, mappings) : applyMappings(text, mappings));
      } else {
        cpSync(childAbs, dst);
      }
      files++;
      bytes += st.size;
    }
  };
  walk(".");
  return { files, bytes };
}

/**
 * Back up an existing local transcript + sidecar to `.bak-<ts>` before it's
 * overwritten (the client-side mirror of push's remote backup script). No-op for
 * paths that don't exist. Returns whether anything was backed up.
 */
export function backupLocal(file: string, sidecar: string, ts: string): boolean {
  let did = false;
  if (existsSync(file)) {
    cpSync(file, `${file}.bak-${ts}`);
    did = true;
  }
  if (existsSync(sidecar) && statSync(sidecar).isDirectory()) {
    cpSync(sidecar, `${sidecar}.bak-${ts}`, { recursive: true });
    did = true;
  }
  return did;
}
