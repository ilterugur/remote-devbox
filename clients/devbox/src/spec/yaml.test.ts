import { expect, test } from "bun:test";
import { toYaml } from "./yaml";

test("scalars and nesting", () => {
  expect(toYaml({ a: 1, b: true, c: null, d: "plain", e: "needs quotes" })).toBe(
    'a: 1\nb: true\nc: null\nd: plain\ne: "needs quotes"\n',
  );
});

test("ambiguous strings are quoted", () => {
  expect(toYaml({ v: "26.04", y: "yes", n: "no", t: "true", e: "" })).toBe(
    'v: "26.04"\ny: "yes"\nn: "no"\nt: "true"\ne: ""\n',
  );
});

test("nested maps and lists", () => {
  expect(toYaml({ outer: { list: [1, "a"], empty_list: [], empty_map: {} } })).toBe(
    "outer:\n  list:\n    - 1\n    - a\n  empty_list: []\n  empty_map: {}\n",
  );
});

test("a list of maps indents correctly", () => {
  expect(toYaml({ developers: [{ user: "dev-a", ports: [3000] }] })).toBe(
    "developers:\n  - user: dev-a\n    ports:\n      - 3000\n",
  );
});

test("undefined entries are dropped, not emitted", () => {
  expect(toYaml({ a: undefined, b: 1 })).toBe("b: 1\n");
});

test("output round-trips through Bun.YAML.parse", () => {
  const value = {
    developers: [
      { user: "dev-a", memory: null, projects: [{ name: "p", branch: "main", ports: [] }] },
    ],
  };
  expect(Bun.YAML.parse(toYaml(value))).toEqual(value);
});

test("quotes and backslashes are escaped", () => {
  expect(toYaml({ s: 'a "b" \\ c' })).toBe('s: "a \\"b\\" \\\\ c"\n');
  expect(Bun.YAML.parse(toYaml({ s: 'a "b" \\ c' }))).toEqual({ s: 'a "b" \\ c' });
});

test("an empty document is empty", () => {
  expect(toYaml({})).toBe("");
});
