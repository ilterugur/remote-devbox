import { expect, test } from "bun:test";
import { routeToolchainExecutablesThroughGate } from "../roles/agent_profiles/files/omp-heavy-gate";

test("routes absolute toolchain executables through PATH at command boundaries", () => {
  expect(routeToolchainExecutablesThroughGate("/home/dev/.local/share/mise/installs/bun/1.4.0/bin/bun run build"))
    .toBe("bun run build");
  expect(routeToolchainExecutablesThroughGate("cd app && CI=1 /opt/node/bin/node ./node_modules/typescript/bin/tsc"))
    .toBe("cd app && CI=1 node ./node_modules/typescript/bin/tsc");
  expect(routeToolchainExecutablesThroughGate("prepare | /opt/tools/pnpm test"))
    .toBe("prepare | pnpm test");
});

test("does not rewrite toolchain-looking arguments or unrelated executables", () => {
  const command = "printf '%s' /opt/node/bin/node; /usr/bin/env bun run build";
  expect(routeToolchainExecutablesThroughGate(command)).toBe(command);
});
