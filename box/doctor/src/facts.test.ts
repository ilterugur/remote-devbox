import { expect, test } from "bun:test";
import { parseHealthFacts } from "./facts";

test("parseHealthFacts accepts schema 1 and drops undeclared fields", () => {
  const marker = "AUTHKEY=SECRET_MUST_NOT_SURVIVE";
  const parsed = parseHealthFacts({
    schemaVersion: 1,
    environment: marker,
    components: [{
      id: "desktop.xrdp",
      unit: "xrdp.service",
      recovery: "automatic",
      secret: marker,
      listeners: [{
        protocol: "tcp",
        address: "127.0.0.1",
        port: 3389,
        process: "xrdp",
        processMatch: "exact",
        token: marker,
      }],
    }],
  });

  expect(parsed.components[0]?.id).toBe("desktop.xrdp");
  expect(parsed.components[0]?.listeners?.[0]?.processMatch).toBe("exact");
  expect(JSON.stringify(parsed)).not.toContain(marker);
});

test("parseHealthFacts rejects unsupported versions and unsafe unit names", () => {
  expect(() => parseHealthFacts({ schemaVersion: 2, components: [] })).toThrow("unsupported health facts schema");
  expect(() => parseHealthFacts({
    schemaVersion: 1,
    components: [{ id: "x", unit: "x.service; reboot", recovery: "automatic" }],
  })).toThrow("invalid unit");
});

test("parseHealthFacts rejects invalid listener boundaries", () => {
  expect(() => parseHealthFacts({
    schemaVersion: 1,
    components: [{
      id: "x",
      recovery: "none",
      listeners: [{ protocol: "tcp", address: "127.0.0.1", port: 70000, process: "x" }],
    }],
  })).toThrow("invalid TCP listener");
});
