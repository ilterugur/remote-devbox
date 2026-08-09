import { expect, test } from "bun:test";
import { loadSpec } from "./load";
import { EXAMPLE_CONFIG } from "./load.test";
import { renderPlan } from "./plan";
import type { MemoryLimitSpec, ResolvedSpec } from "./types";

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

test("the plan reports a sync disk and its app configs", () => {
  // A declared block the plan never mentions reads as a block that was never declared —
  // which is exactly how a live config looked after file_bridge landed.
  const dev = {
    user: "dev-c",
    login_ssh_keys: [],
    projects: [],
    file_bridge: { sync_disk: true, engine: "syncthing" as const },
    app_configs: { enabled: true, paths: ["filezilla", "ssh_config"] },
  };
  const { resolved, issues } = loadSpec(EXAMPLE_CONFIG);
  const spec = resolved!;
  spec.developers.push(dev as unknown as (typeof spec.developers)[number]);
  const text = renderPlan(spec, issues);
  expect(text).toContain("sync disk via syncthing");
  expect(text).toContain("app configs filezilla, ssh_config");
});

test("a developer without a sync disk gets no file-bridge line", () => {
  expect(rendered()).not.toContain("file bridge");
});

test("the desktop line names the address the client dials, counting up per developer", () => {
  // The port is the one number a developer has to type into their RDP client, and it is
  // decided across developers — so a plan that showed the desktop without it would send
  // the second developer to the first one's tunnel.
  const { resolved, issues } = loadSpec(EXAMPLE_CONFIG);
  const spec = resolved!;
  const desk = { enabled: true, environment: "xfce" as const, transport: "xrdp" as const };
  spec.developers[0]!.desktop = desk;
  spec.developers[1]!.desktop = { ...desk };
  const text = renderPlan(spec, issues);
  expect(text).toContain("client dials 127.0.0.1:3389");
  expect(text).toContain("client dials 127.0.0.1:3390");
});

const withMemoryHigh = (memoryHigh: MemoryLimitSpec): ResolvedSpec => {
  const { resolved } = loadSpec(EXAMPLE_CONFIG);
  const spec = resolved!;
  return {
    ...spec,
    developers: [{ ...spec.developers[0]!, resources: { memory_high: memoryHigh } }],
  };
};

test("the plan distinguishes a proportional memory_high weight from a direct limit", () => {
  expect(renderPlan(withMemoryHigh({ weight: 5 }), [])).toContain("memory_high weight 5");
  expect(renderPlan(withMemoryHigh("32GB"), [])).toContain("memory_high 32G");
});
