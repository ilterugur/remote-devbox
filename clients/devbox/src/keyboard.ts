/**
 * keyboard.ts — work out what keyboard the machine running the CLI types on.
 *
 * The RDP client does announce its layout, and xrdp maps that announcement to an X11
 * layout through /etc/xrdp/xrdp_keyboard.ini — but that table covers only some layout
 * ids and falls back to `us` for the rest, Turkish among them, with nothing but a debug
 * line to say so. The box therefore has to be taught the mapping for the layouts its
 * developers actually use, and this is how we learn which those are without asking.
 *
 * Setting the layout inside the session instead does NOT work: xrdp applies its own
 * keymap when the client connects, which is after the session script has run, so
 * anything setxkbmap did there is overwritten a moment later.
 *
 * `devbox.yml` always wins when it names a layout; this is only the default.
 *
 * Detection is best-effort by design: an unrecognised keyboard returns null and the
 * session keeps the box default, because guessing a layout is worse than leaving it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { childProcessEnv } from "./locale";
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
  return { layout: mapped.layout, variant: mapped.variant ?? null };
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
  return { layout, variant: firstOf(field("variant")) };
}

/** Parse Debian/Ubuntu's /etc/default/keyboard — the fallback for a headless client. */
export function keyboardFromDefaultKeyboard(raw: string): XkbKeyboard | null {
  const field = (name: string): string | null =>
    raw.match(new RegExp(`^${name}="?([^"\\n]*)"?`, "m"))?.[1]?.trim() || null;
  const layout = firstOf(field("XKBLAYOUT"));
  if (!layout) return null;
  return { layout, variant: firstOf(field("XKBVARIANT")) };
}

const run = (cmd: string, args: string[]): string | null => {
  const out = spawnSync(cmd, args, { encoding: "utf8", env: childProcessEnv() });
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
