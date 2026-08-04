import { expect, test } from "bun:test";
import { planAppConfigLink, planAppConfigUnlink, type SideState } from "./plan";
import { resolveEntry } from "./registry";

const fz = (resolveEntry("filezilla") as any).entry;
const s = (kind: SideState["kind"], summary = ""): SideState => ({ kind, summary });

test("both sides already linked is a no-op", () => {
  expect(planAppConfigLink(fz, s("linked"), s("linked"), "content").decision).toBe("already-linked");
});

test("a link pointing somewhere else is refused", () => {
  expect(planAppConfigLink(fz, s("foreign-link"), s("absent"), "absent").decision).toBe("refuse");
  expect(planAppConfigLink(fz, s("absent"), s("foreign-link"), "absent").decision).toBe("refuse");
});

test("content on exactly one side wins without asking", () => {
  expect(planAppConfigLink(fz, s("content", "41 sites"), s("absent"), "absent").decision).toBe("use-client");
  expect(planAppConfigLink(fz, s("empty"), s("content", "3 sites"), "absent").decision).toBe("use-box");
});

test("content on both sides asks", () => {
  const r = planAppConfigLink(fz, s("content", "41 sites"), s("content", "3 sites"), "absent");
  expect(r.decision).toBe("ask");
  expect(r.reason).toContain("41 sites");
  expect(r.reason).toContain("3 sites");
});

test("nothing anywhere seeds an empty store", () => {
  expect(planAppConfigLink(fz, s("absent"), s("empty"), "absent").decision).toBe("seed-empty");
});

test("an already-seeded store links a bare side without asking", () => {
  expect(planAppConfigLink(fz, s("absent"), s("linked"), "content").decision).toBe("use-client");
});

test("unlink restores a linked side and skips an unlinked one", () => {
  expect(planAppConfigUnlink(fz, s("linked")).action).toBe("restore");
  expect(planAppConfigUnlink(fz, s("content")).action).toBe("skip");
});
