import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshot, writeHealthSnapshot } from "./snapshot";
import { createHealthDocument } from "./report";
import type { CommandRunner } from "./collect";

test("writeHealthSnapshot atomically writes a world-readable sanitized document", () => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-health-snapshot-"));
  const path = join(dir, "health.json");
  const document = createHealthDocument("2026-08-09T00:00:00.000Z", []);

  writeHealthSnapshot(path, document);

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(document);
  expect(statSync(path).mode & 0o777).toBe(0o644);
  expect(readdirSync(dir)).toEqual(["health.json"]);
});

test("createSnapshot reads strict facts, collects evidence, and writes the document", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-health-collect-"));
  const factsPath = join(dir, "facts.json");
  const outputPath = join(dir, "health.json");
  await Bun.write(factsPath, JSON.stringify({
    schemaVersion: 1,
    components: [{ id: "remote-control.agent-rc-x.service", unit: "agent-rc-x.service", recovery: "automatic" }],
  }));
  const runner: CommandRunner = async () => ({
    stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });

  const document = await createSnapshot({
    factsPath,
    outputPath,
    runner,
    now: new Date("2026-08-09T01:02:03.000Z"),
  });

  expect(document.status).toBe("healthy");
  expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(document);
});
