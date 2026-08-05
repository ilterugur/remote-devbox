import { expect, test } from "bun:test";
import { PHASES, describePhases, phaseByName, tagsFor } from "./phases";

test("every phase has tags and a summary", () => {
  for (const phase of PHASES) {
    expect(phase.tags.length).toBeGreaterThan(0);
    expect(phase.summary.length).toBeGreaterThan(0);
  }
});

test("phase order puts security before anything that relies on it", () => {
  const index = (name: string) => PHASES.findIndex((p) => p.name === name);
  expect(index("preflight")).toBeLessThan(index("base"));
  expect(index("base")).toBeLessThan(index("security"));
  expect(index("developers")).toBeLessThan(index("agents"));
  expect(index("agents")).toBeLessThan(index("memory"));
  expect(index("desktop")).toBe(PHASES.length - 1);
});

test("the rc phase runs after the working copies it hosts sessions in", () => {
  expect(tagsFor("rc")).toEqual(["rc"]);
  const names = PHASES.map((p) => p.name);
  expect(names.indexOf("rc")).toBeGreaterThan(names.indexOf("projects"));
});

test("tagsFor resolves a phase, 'all' and undefined", () => {
  expect(tagsFor("containers")).toEqual(["containers"]);
  expect(tagsFor("all")).toBeNull();
  expect(tagsFor(undefined)).toBeNull();
});

test("an unknown phase names the valid ones", () => {
  expect(() => tagsFor("nope")).toThrow(/unknown phase 'nope'/);
  expect(() => tagsFor("nope")).toThrow(/containers/);
});

test("phaseByName and describePhases agree with the table", () => {
  expect(phaseByName("memory")?.tags).toEqual(["memory"]);
  expect(phaseByName("missing")).toBeUndefined();
  expect(describePhases()).toContain("desktop");
});
