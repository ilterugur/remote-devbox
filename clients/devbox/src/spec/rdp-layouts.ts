/**
 * rdp-layouts.ts — the RDP keyboard layout id an XKB layout arrives as.
 *
 * xrdp decides the session's keyboard by looking up the layout id the client announces
 * in /etc/xrdp/xrdp_keyboard.ini. Its shipped table has holes — Turkish is one — and an
 * unmapped id silently becomes `us`. Closing a hole means knowing the id to map, which
 * is what this provides: the box is taught only the layouts its developers use.
 *
 * The ids are Windows language identifiers (LCIDs), which is what the RDP protocol
 * carries. Layouts whose id is not listed here resolve to null and are left to xrdp's
 * own table, because writing a wrong id would map a keyboard to the wrong language
 * rather than merely failing.
 */
import type { XkbKeyboard } from "./types";

const RDP_LAYOUT_IDS: Record<string, string> = {
  us: "0x00000409",
  "us(intl)": "0x00020409",
  gb: "0x00000809",
  de: "0x00000407",
  fr: "0x0000040C",
  es: "0x0000040A",
  it: "0x00000410",
  nl: "0x00000413",
  se: "0x0000041D",
  no: "0x00000414",
  dk: "0x00000406",
  fi: "0x0000040B",
  pl: "0x00000415",
  pt: "0x00000816",
  br: "0x00000416",
  ru: "0x00000419",
  ua: "0x00000422",
  gr: "0x00000408",
  cz: "0x00000405",
  hu: "0x0000040E",
  ro: "0x00000418",
  ch: "0x00000807",
  tr: "0x0000041F",
  // The F keyboard is the same language with the "alternate layout" bit set — the only
  // pair here where two physical keyboards share a language and must not be conflated.
  "tr(f)": "0x0001041F",
};

/** `tr` / `tr(f)` — the way XKB itself writes a layout with a variant. */
export const xkbName = (keyboard: Pick<XkbKeyboard, "layout" | "variant">): string =>
  keyboard.variant ? `${keyboard.layout}(${keyboard.variant})` : keyboard.layout;

/** The id this keyboard announces itself as over RDP, or null when we don't know it. */
export const rdpLayoutId = (keyboard: Pick<XkbKeyboard, "layout" | "variant">): string | null =>
  RDP_LAYOUT_IDS[xkbName(keyboard)] ?? null;
