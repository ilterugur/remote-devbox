import { expect, test } from "bun:test";
import { rdpLayoutId, xkbName } from "./rdp-layouts";

test("the Turkish Q and F keyboards are different ids, not one language", () => {
  expect(rdpLayoutId({ layout: "tr", variant: null })).toBe("0x0000041F");
  expect(rdpLayoutId({ layout: "tr", variant: "f" })).toBe("0x0001041F");
});

// A wrong id maps a keyboard to the wrong language, which is worse than xrdp's own
// fallback — so an id we don't know is reported as unknown rather than approximated.
test("a layout with no known id is a miss, not a guess", () => {
  expect(rdpLayoutId({ layout: "khmer", variant: null })).toBeNull();
  expect(rdpLayoutId({ layout: "tr", variant: "unheard-of" })).toBeNull();
});

test("the xkb name is the key both xrdp and setxkbmap speak", () => {
  expect(xkbName({ layout: "tr", variant: null })).toBe("tr");
  expect(xkbName({ layout: "tr", variant: "f" })).toBe("tr(f)");
});
