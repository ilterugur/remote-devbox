import { describe, expect, test } from "bun:test";
import { normalize } from "./normalize";
import { resolveSpec } from "./resolve";
import { validateStructure } from "./validate";

const KEY = "ssh-ed25519 AAAAC3Nz key@client";

function spec(monitoring: unknown): Record<string, unknown> {
  return {
    config_version: 3,
    platform: { distribution: "ubuntu", version: "26.04", architecture: "amd64" },
    operator: { user: "devbox-admin", ssh_authorized_keys: [KEY] },
    network: { tailscale: { enabled: true }, ssh: { access: ["public", "tailnet"] } },
    container: { default_engine: "podman-rootless", install_engines: ["podman-rootless"] },
    host: monitoring === undefined ? {} : { monitoring },
    developers: [{ user: "dev-a", login_ssh_keys: [KEY] }],
  };
}

const paths = (raw: unknown): string[] =>
  validateStructure(raw).issues.map((issue) => `${issue.severity}:${issue.path}`);

function hostBlock(monitoring?: unknown): Record<string, unknown> {
  const structural = validateStructure(spec(monitoring));
  if (!structural.spec) throw new Error(`spec rejected: ${paths(spec(monitoring)).join(", ")}`);
  const resolution = resolveSpec(structural.spec);
  if (!resolution.resolved) throw new Error("spec did not resolve");
  const out = normalize(resolution.resolved);
  return (out.devbox_host as Record<string, unknown>).monitoring as Record<string, unknown>;
}

describe("host.monitoring", () => {
  test("is off, and exposed nowhere, unless a box asks for it", () => {
    expect(hostBlock()).toEqual({
      enabled: false,
      port: 19999,
      access: ["tunnel"],
      retention_days: 14,
      memory_max: "768M",
    });
  });

  test("defaults to loopback-only access when enabled without one", () => {
    // The security argument for this feature is that there is no listener to reach from
    // the network. A default that widened that would make every other check decorative.
    expect(hostBlock({ enabled: true }).access).toEqual(["tunnel"]);
  });

  test("carries the declared port, access, retention and ceiling through to the box", () => {
    expect(
      hostBlock({
        enabled: true,
        port: 20100,
        access: ["tunnel", "tailnet"],
        retention_days: 30,
        memory_max: "512M",
      }),
    ).toEqual({
      enabled: true,
      port: 20100,
      access: ["tunnel", "tailnet"],
      retention_days: 30,
      memory_max: "512M",
    });
  });

  test("rejects a shape the box cannot act on", () => {
    expect(paths(spec("yes"))).toContain("error:host.monitoring");
    expect(paths(spec({}))).toContain("error:host.monitoring.enabled");
    expect(paths(spec({ enabled: true, port: 0 }))).toContain("error:host.monitoring.port");
    expect(paths(spec({ enabled: true, port: 70000 }))).toContain("error:host.monitoring.port");
    expect(paths(spec({ enabled: true, access: [] }))).toContain("error:host.monitoring.access");
    expect(paths(spec({ enabled: true, access: ["lan"] }))).toContain("error:host.monitoring.access");
    expect(paths(spec({ enabled: true, retention_days: 0 }))).toContain(
      "error:host.monitoring.retention_days",
    );
    // A percentage ceiling cannot be turned into a systemd MemoryMax for one unit here.
    expect(paths(spec({ enabled: true, memory_max: "10%" }))).toContain(
      "error:host.monitoring.memory_max",
    );
  });

  test("accepts every declared access path", () => {
    for (const access of [["tunnel"], ["tailnet"], ["unsafe-public"], ["tunnel", "tailnet"]]) {
      expect(paths(spec({ enabled: true, access })).filter((p) => p.includes("monitoring"))).toEqual([]);
    }
  });
});
