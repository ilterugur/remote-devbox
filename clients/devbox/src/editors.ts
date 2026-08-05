/**
 * Teach the local apps about the box: Zed's remote-project list, and the RDP client's
 * menu shortcut.
 *
 * These used to live in gen-editor-config.py, which also generated the ssh config from
 * ansible/group_vars/all.yml — a file the canonical config replaced. Reading a laptop's
 * connection details out of stale provisioning data is worse than not generating them at
 * all, so the box now emits the ssh block itself (`devbox client-config`) and what
 * remains here is the part that is genuinely client-side: it edits files and preference
 * domains that only exist on this machine.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config";

const ZED_SETTINGS = join(homedir(), ".config", "zed", "settings.json");

// Microsoft renamed Remote Desktop to "Windows App" but kept the preference domain, so
// one domain covers both.
const RDP_DOMAIN = "com.microsoft.rdc.macos";
const RDP_APPS = ["/Applications/Windows App.app", "/Applications/Microsoft Remote Desktop.app"];
// Keyed by the menu item's VISIBLE title — that is how NSUserKeyEquivalents matches, so
// this has to stay the string in the app's menu bar.
const RDP_CLOSE_ITEM = "Close";
const RDP_CLOSE_KEYS = "@~w";
// Ordered as macOS renders modifiers rather than as they are typed, so what we print
// matches the menu character for character.
const MODIFIER_GLYPHS: [string, string][] = [
  ["^", "\u2303"],
  ["~", "\u2325"],
  ["$", "\u21e7"],
  ["@", "\u2318"],
];

export interface ZedConnection {
  host: string;
  nickname: string;
  projects: { paths: string[] }[];
}

/** One entry per profile, listing that profile's projects under their box paths. */
export const zedConnections = (cfg: Config): ZedConnection[] =>
  cfg.profiles.map((p) => ({
    host: `${cfg.prefix}-${p.user}`,
    nickname: `remote-devbox · ${p.user}`,
    projects: (p.projects ?? []).map((pr) => ({ paths: [`~/projects/${pr.name}`] })),
  }));

/**
 * Merge our connections into an existing settings object, replacing only the entries we
 * own. Anything the developer added by hand for another host is left where it is.
 */
export function mergeZedSettings(existing: Record<string, unknown>, cfg: Config): Record<string, unknown> {
  const ours = zedConnections(cfg);
  const prior = Array.isArray(existing.ssh_connections) ? existing.ssh_connections : [];
  const theirs = prior.filter(
    (c) => !String((c as { host?: unknown }).host ?? "").startsWith(`${cfg.prefix}-`),
  );
  return { ...existing, ssh_connections: [...theirs, ...ours] };
}

export type EditorsResult = { zed: string; rdp: string };

export function runEditors(cfg: Config, opts: { zed?: boolean; platform?: string } = {}): EditorsResult {
  return { zed: writeZed(cfg, opts.zed ?? false), rdp: rebindRdpClose(opts.platform ?? process.platform) };
}

function writeZed(cfg: Config, forced: boolean): string {
  const dir = dirname(ZED_SETTINGS);
  if (!forced && !existsSync(dir)) return "Zed not detected (no ~/.config/zed) — skipped; --zed forces it";

  let existing: Record<string, unknown> = {};
  if (existsSync(ZED_SETTINGS)) {
    const raw = readFileSync(ZED_SETTINGS, "utf8");
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Zed's settings file is JSONC and ships full of comments. Rewriting it through a
      // strict parser would silently delete every one of them, so we hand the block over
      // instead of editing a file we cannot round-trip.
      const snippet = JSON.stringify({ ssh_connections: zedConnections(cfg) }, null, 2);
      return `~/.config/zed/settings.json has comments — not editing it. Paste this in:\n\n${snippet}`;
    }
    copyFileSync(ZED_SETTINGS, `${ZED_SETTINGS}.bak`);
  } else {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(ZED_SETTINGS, `${JSON.stringify(mergeZedSettings(existing, cfg), null, 2)}\n`);
  return "~/.config/zed/settings.json updated";
}

export const renderKeys = (keys: string): string => {
  const flags = new Set(MODIFIER_GLYPHS.map(([c]) => c));
  const mods = MODIFIER_GLYPHS.filter(([c]) => keys.includes(c)).map(([, g]) => g).join("");
  return mods + [...keys].filter((c) => !flags.has(c)).join("").toUpperCase();
};

/**
 * Move the RDP client's Close menu item off ⌘W.
 *
 * ⌘W closes the whole session window and never reaches the box: macOS routes it to the
 * app's own menu first. Microsoft's position is that no in-app setting overrides this and
 * the conflicting shortcut has to be reassigned — which is what NSUserKeyEquivalents
 * does, the same thing System Settings → Keyboard → App Shortcuts writes, so the two
 * cannot disagree.
 *
 * This frees ⌘W rather than making it useful remotely: the client maps Command to the
 * Windows key, so Ctrl is already the modifier that arrives as Ctrl.
 */
function rebindRdpClose(platform: string): string {
  if (platform !== "darwin") return "RDP close shortcut: macOS only — skipped";
  if (!RDP_APPS.some((app) => existsSync(app))) return "RDP close shortcut: no RDP client installed — skipped";

  const current = spawnSync("defaults", ["read", RDP_DOMAIN, "NSUserKeyEquivalents"], { encoding: "utf8" });
  // An absent domain or key is the normal first run, not a failure worth reporting.
  const already = new RegExp(`"?${RDP_CLOSE_ITEM}"?\\s*=\\s*"?${RDP_CLOSE_KEYS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*;`);
  if (current.status === 0 && already.test(current.stdout)) {
    return `RDP '${RDP_CLOSE_ITEM}' already on ${renderKeys(RDP_CLOSE_KEYS)}`;
  }

  const w = spawnSync(
    "defaults",
    ["write", RDP_DOMAIN, "NSUserKeyEquivalents", "-dict-add", RDP_CLOSE_ITEM, RDP_CLOSE_KEYS],
    { encoding: "utf8" },
  );
  if (w.status !== 0) return `RDP close shortcut: defaults write failed — ${(w.stderr || "").trim()}`;
  return (
    `RDP '${RDP_CLOSE_ITEM}' moved to ${renderKeys(RDP_CLOSE_KEYS)} — ⌘W is free ` +
    `(quit and reopen the RDP client: menu shortcuts are read at launch)`
  );
}
