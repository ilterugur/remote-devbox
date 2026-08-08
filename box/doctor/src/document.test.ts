import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHealthSnapshot } from "./document";
import { createHealthDocument } from "./report";
import type { HealthResult } from "./types";

const now = new Date("2026-08-09T12:00:30.000Z");

const component = (id: string, profile?: string): HealthResult => ({
  id,
  ...(profile ? { profile } : {}),
  status: "healthy",
  expected: [`${id} expected`],
  observed: [`${id} observed`],
  recovery: "none",
});

function snapshot(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "devbox-health-document-"));
  const path = join(dir, "health.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test("readHealthSnapshot returns a fresh schema 1 document filtered by explicit profile", () => {
  const path = snapshot(createHealthDocument("2026-08-09T12:00:00.000Z", [
    component("desktop.xrdp"),
    component("memory.dev-a.primary", "dev-a"),
    component("memory.dev-b.primary", "dev-b"),
  ]));

  const document = readHealthSnapshot(path, { profile: "dev-a", now, maxAgeMs: 45_000 });

  expect(document.status).toBe("healthy");
  expect(document.components.map((item) => item.id)).toEqual([
    "desktop.xrdp",
    "memory.dev-a.primary",
  ]);
});

test("stale, future, missing, malformed, and unsupported snapshots fail closed", () => {
  const cases: Array<[string, string]> = [
    [snapshot(createHealthDocument("2026-08-09T11:59:00.000Z", [])), "snapshot_stale"],
    [snapshot(createHealthDocument("2026-08-09T12:01:00.000Z", [])), "snapshot_clock_skew"],
    [join(tmpdir(), `missing-health-${process.pid}.json`), "snapshot_missing"],
    [snapshot("not an object"), "snapshot_invalid"],
    [snapshot({ schemaVersion: 2, status: "healthy", observedAt: now.toISOString(), components: [] }), "unsupported_schema"],
  ];

  for (const [path, reason] of cases) {
    const document = readHealthSnapshot(path, { profile: "dev-a", now, maxAgeMs: 45_000 });
    expect(document.status).toBe("unknown");
    expect(document.components).toHaveLength(1);
    expect(document.components[0]?.id).toBe("box.snapshot");
    expect(document.components[0]?.reason).toBe(reason);
  }
});

test("snapshot parsing drops undeclared fields instead of leaking them", () => {
  const marker = "TOKEN=SECRET_MUST_NOT_SURVIVE";
  const path = snapshot({
    ...createHealthDocument("2026-08-09T12:00:00.000Z", [component("desktop.xrdp")]),
    environment: marker,
    components: [{ ...component("desktop.xrdp"), raw: marker }],
  });

  const document = readHealthSnapshot(path, { profile: "dev-a", now, maxAgeMs: 45_000 });

  expect(JSON.stringify(document)).not.toContain(marker);
});
