/**
 * keyboard.ts — work out what keyboard the machine running the CLI types on.
 *
 * The desktop's layout has to be decided on the box, not left to the RDP client: xrdp
 * ships keymap files for a fixed set of RDP layout ids and silently falls back to `us`
 * for everything else — Turkish is one of the missing ones, so a Turkish keyboard types
 * on a us layout with no error anywhere. The least surprising default is therefore the
 * layout the developer is already using on the client, which is what this detects.
 *
 * `devbox.yml` always wins when it names a layout; this is only the default.
 *
 * Detection is best-effort by design: an unrecognised keyboard returns null and the
 * session keeps the box default, because guessing a layout is worse than leaving it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { XkbKeyboard } from "./spec/types";

/**
 * macOS names its layouts after the language, XKB after the country, and the two
 * disagree often enough that a mapping is the only honest way across. Only layouts whose
 * XKB counterpart is unambiguous are listed — anything absent stays undetected.
 *
 * The Turkish pair is the reason this file exists: macOS "Turkish" is the F keyboard and
 * "Turkish-QWERTY-PC" is the Q one, which map to two different XKB variants of `tr`.
 */
const MAC_LAYOUTS: Record<string, { layout: string; variant?: string }> = {
  "Turkish-QWERTY-PC": { layout: "tr" },
  "Turkish-QWERTY": { layout: "tr" },
  Turkish: { layout: "tr", variant: "f" },
  "U.S.": { layout: "us" },
  USExtended: { layout: "us", variant: "intl" },
  British: { layout: "gb" },
  German: { layout: "de" },
  French: { layout: "fr" },
  Spanish: { layout: "es" },
  "Spanish-ISO": { layout: "es" },
  Italian: { layout: "it" },
  "Italian-Pro": { layout: "it" },
  Dutch: { layout: "nl" },
  Swedish: { layout: "se" },
  "Swedish-Pro": { layout: "se" },
  Norwegian: { layout: "no" },
  Danish: { layout: "dk" },
  Finnish: { layout: "fi" },
  Polish: { layout: "pl" },
  PolishPro: { layout: "pl" },
  Portuguese: { layout: "pt" },
  Brazilian: { layout: "br" },
  Russian: { layout: "ru" },
  Ukrainian: { layout: "ua" },
  Greek: { layout: "gr" },
  Czech: { layout: "cz" },
  "Czech-QWERTY": { layout: "cz", variant: "qwerty" },
  Hungarian: { layout: "hu" },
  Romanian: { layout: "ro" },
  "SwissGerman": { layout: "ch" },
  "SwissFrench": { layout: "ch", variant: "fr" },
};

/**
 * The RDP client sends PC scancodes whatever the physical keyboard is, so the model the
 * box should assume is a PC one — a Mac's own model name would shift the top row.
 */
const RDP_MODEL = "pc105";

/**
 * Parse `defaults read com.apple.HIToolbox AppleSelectedInputSources`.
 *
 * The selected sources are an ordered list and the first keyboard layout in it is the
 * active one; the rest of the list is input methods (emoji picker, press-and-hold) that
 * carry no layout at all.
 */
export function keyboardFromMacInputSources(raw: string): XkbKeyboard | null {
  const match = raw.match(/"?KeyboardLayout Name"?\s*=\s*"?([^";\n]+)"?\s*;/);
  if (!match) return null;
  const mapped = MAC_LAYOUTS[match[1]!.trim()];
  if (!mapped) return null;
  return { layout: mapped.layout, variant: mapped.variant ?? null, model: RDP_MODEL };
}

/**
 * A multi-layout client (`layout: us,tr`) is a switcher setup. The first entry is the one
 * it boots into, and carrying the whole list would hand the box a switcher it has no key
 * binding to switch with. The parallel variant list is positional and often starts empty
 * (`variant: ,f`), so an empty first entry means "no variant", not a variant named "".
 */
const firstOf = (value: string | null): string | null => value?.split(",")[0]?.trim() || null;

/** Parse `setxkbmap -query` on a Linux client — already XKB, so no mapping needed. */
export function keyboardFromSetxkbmap(raw: string): XkbKeyboard | null {
  const field = (name: string): string | null =>
    raw.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? null;
  const layout = firstOf(field("layout"));
  if (!layout) return null;
  return { layout, variant: firstOf(field("variant")), model: RDP_MODEL };
}

/** Parse Debian/Ubuntu's /etc/default/keyboard — the fallback for a headless client. */
export function keyboardFromDefaultKeyboard(raw: string): XkbKeyboard | null {
  const field = (name: string): string | null =>
    raw.match(new RegExp(`^${name}="?([^"\\n]*)"?`, "m"))?.[1]?.trim() || null;
  const layout = firstOf(field("XKBLAYOUT"));
  if (!layout) return null;
  return { layout, variant: firstOf(field("XKBVARIANT")), model: RDP_MODEL };
}

const run = (cmd: string, args: string[]): string | null => {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return out.status === 0 && out.stdout ? out.stdout : null;
};

/** Best-effort detection for the current client. Null when nothing recognisable is found. */
export function detectClientKeyboard(platform: NodeJS.Platform = process.platform): XkbKeyboard | null {
  if (platform === "darwin") {
    const raw = run("defaults", ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"]);
    return raw ? keyboardFromMacInputSources(raw) : null;
  }
  if (platform === "linux") {
    const queried = run("setxkbmap", ["-query"]);
    if (queried) return keyboardFromSetxkbmap(queried);
    return existsSync("/etc/default/keyboard")
      ? keyboardFromDefaultKeyboard(readFileSync("/etc/default/keyboard", "utf8"))
      : null;
  }
  return null;
}
