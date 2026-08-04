import { expect, test } from "bun:test";
import { loadSpec } from "./load";
import { EXAMPLE_CONFIG } from "./load.test";
import { renderPlan } from "./plan";

const rendered = () => {
  const { resolved, issues } = loadSpec(EXAMPLE_CONFIG);
  return renderPlan(resolved!, issues);
};

test("the plan names every developer and their resolved project dimensions", () => {
  const text = rendered();
  expect(text).toContain("developer dev-a  (adopt existing account)");
  expect(text).toContain("developer dev-b");
  expect(text).toContain("git=work");
  expect(text).toContain("engine=docker-rootless");
  expect(text).toContain("memory=off");
});

test("the plan reports the global sections and an issue tally", () => {
  const text = rendered();
  expect(text).toContain("devbox plan — ubuntu 26.04 amd64");
  expect(text).toContain("ssh via public + tailnet");
  expect(text).toContain("shared svcs disabled");
  expect(text).toMatch(/\d+ warnings?, 0 errors/);
});

test("a developer with memory off prints 'disabled', not an empty space list", () => {
  expect(rendered()).toContain("memory      disabled");
});
