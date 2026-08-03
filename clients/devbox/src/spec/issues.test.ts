import { expect, test } from "bun:test";
import { err, formatIssues, hasErrors, warn } from "./issues";

test("err and warn carry severity and path", () => {
  expect(err("developers[0].user", "bad")).toEqual({
    severity: "error",
    path: "developers[0].user",
    message: "bad",
  });
  expect(warn("network.ssh", "risky")).toEqual({
    severity: "warning",
    path: "network.ssh",
    message: "risky",
  });
});

test("hasErrors is true only when an error is present", () => {
  expect(hasErrors([])).toBe(false);
  expect(hasErrors([warn("a", "x")])).toBe(false);
  expect(hasErrors([warn("a", "x"), err("b", "y")])).toBe(true);
});

test("formatIssues prints errors first, then warnings, stably", () => {
  const out = formatIssues([warn("b", "second"), err("a", "first")]);
  expect(out).toBe("ERROR  a: first\nwarn   b: second");
});
