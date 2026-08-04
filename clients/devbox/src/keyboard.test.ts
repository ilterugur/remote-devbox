import { describe, expect, test } from "bun:test";
import {
  detectClientKeyboard,
  keyboardFromDefaultKeyboard,
  keyboardFromMacInputSources,
  keyboardFromSetxkbmap,
} from "./keyboard";

// The exact shape `defaults read com.apple.HIToolbox AppleSelectedInputSources` prints:
// the active layout first, then input methods that carry no layout at all.
const MAC_TURKISH_Q = `(
        {
        InputSourceKind = "Keyboard Layout";
        "KeyboardLayout ID" = "-36";
        "KeyboardLayout Name" = "Turkish-QWERTY-PC";
    },
        {
        "Bundle ID" = "com.apple.PressAndHold";
        InputSourceKind = "Non Keyboard Input Method";
    }
)`;

describe("macOS input sources", () => {
  test("maps the Turkish Q keyboard to plain tr", () => {
    expect(keyboardFromMacInputSources(MAC_TURKISH_Q)).toEqual({
      layout: "tr",
      variant: null,
      model: "pc105",
    });
  });

  // The pair that makes a mapping table necessary: macOS calls the F keyboard "Turkish",
  // and XKB reaches it only through a variant of the same layout as the Q one.
  test("maps the F keyboard to the tr 'f' variant", () => {
    const raw = '{ "KeyboardLayout Name" = "Turkish"; }';
    expect(keyboardFromMacInputSources(raw)).toEqual({ layout: "tr", variant: "f", model: "pc105" });
  });

  test("takes the first keyboard layout when several are enabled", () => {
    const raw = `(
        { "KeyboardLayout Name" = "Turkish-QWERTY-PC"; },
        { "KeyboardLayout Name" = "U.S."; }
)`;
    expect(keyboardFromMacInputSources(raw)?.layout).toBe("tr");
  });

  // Guessing is worse than leaving the box on its default, so an unknown name is a miss.
  test("reports nothing for a layout with no unambiguous XKB counterpart", () => {
    expect(keyboardFromMacInputSources('{ "KeyboardLayout Name" = "Cherokee-Nation"; }')).toBeNull();
  });

  test("reports nothing when no keyboard layout is selected at all", () => {
    expect(keyboardFromMacInputSources('{ "Bundle ID" = "com.apple.PressAndHold"; }')).toBeNull();
  });
});

describe("Linux clients", () => {
  test("reads setxkbmap output as-is — it is already XKB", () => {
    const raw = ["rules:      evdev", "model:      pc105", "layout:     tr", "variant:    f"].join("\n");
    expect(keyboardFromSetxkbmap(raw)).toEqual({ layout: "tr", variant: "f", model: "pc105" });
  });

  // A switcher setup would otherwise hand the box a layout list it has no key binding
  // to switch between.
  test("keeps only the first of a multi-layout switcher setup", () => {
    const raw = ["layout:     us,tr", "variant:    ,f"].join("\n");
    expect(keyboardFromSetxkbmap(raw)).toEqual({ layout: "us", variant: null, model: "pc105" });
  });

  test("falls back to /etc/default/keyboard", () => {
    const raw = ['XKBMODEL="pc105"', 'XKBLAYOUT="tr"', 'XKBVARIANT=""'].join("\n");
    expect(keyboardFromDefaultKeyboard(raw)).toEqual({ layout: "tr", variant: null, model: "pc105" });
  });

  test("reports nothing when /etc/default/keyboard names no layout", () => {
    expect(keyboardFromDefaultKeyboard('XKBLAYOUT=""')).toBeNull();
  });
});

test("detection is a miss on a platform with no known way to ask", () => {
  expect(detectClientKeyboard("win32")).toBeNull();
});
