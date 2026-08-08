import { expect, test } from "bun:test";
import { collectHostDocument, type CommandResult, type CommandRunner } from "./collect";
import type { HealthFacts } from "./facts";

const facts: HealthFacts = {
  schemaVersion: 1,
  components: [
    {
      id: "desktop.xrdp",
      unit: "xrdp.service",
      listeners: [{ protocol: "tcp", address: "127.0.0.1", port: 3389, process: "xrdp" }],
      recovery: "automatic",
    },
    {
      id: "desktop.xrdp-sesman",
      unit: "xrdp-sesman.service",
      listeners: [{ protocol: "unix", path: "xrdp-sesman.socket", process: "xrdp-sesman" }],
      recovery: "confirmation-required",
    },
    {
      id: "browser.proxy",
      unit: "haproxy.service",
      listeners: [{ protocol: "tcp", address: "127.0.0.1", port: 9222, process: "haproxy" }],
      recovery: "automatic",
    },
    {
      id: "browser.fallback",
      unit: "devbox-fallback-chrome.service",
      listeners: [{ protocol: "tcp", address: "127.0.0.1", port: 9422, process: "chrome" }],
      recovery: "automatic",
    },
    {
      id: "memory.dev-a.primary",
      listeners: [{
        protocol: "tcp",
        address: "127.0.0.1",
        port: 9077,
        process: "hindsight",
        processMatch: "prefix",
      }],
      recovery: "manual",
    },
    {
      id: "remote-control.agent-rc-claude-dev-a-app.service",
      unit: "agent-rc-claude-dev-a-app.service",
      recovery: "automatic",
    },
  ],
};

const ok = (stdout: string): CommandResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false });

const healthyRunner: CommandRunner = async (argv) => {
  if (argv[0] === "systemctl") {
    return ok("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=481\n");
  }
  if (argv.join(" ") === "ss -Hlnpt") {
    return ok([
      'LISTEN 0 128 127.0.0.1:3389 0.0.0.0:* users:(("xrdp",pid=481,fd=11))',
      'LISTEN 0 128 127.0.0.1:9222 0.0.0.0:* users:(("haproxy",pid=482,fd=7))',
      'LISTEN 0 128 127.0.0.1:9422 0.0.0.0:* users:(("chrome",pid=483,fd=9))',
      'LISTEN 0 128 127.0.0.1:9077 0.0.0.0:* users:(("hindsight-emb",pid=484,fd=4))',
    ].join("\n"));
  }
  if (argv.join(" ") === "ss -Hxlpn") {
    return ok('u_str LISTEN 0 4096 /run/xrdp/sockdir/xrdp-sesman.socket users:(("xrdp-sesman",pid=480,fd=7))');
  }
  throw new Error(`unexpected command: ${argv.join(" ")}`);
};

test("collectHostDocument proves configured host components from unit and owned-listener evidence", async () => {
  const doc = await collectHostDocument(facts, healthyRunner, new Date("2026-08-09T00:00:00.000Z"));

  expect(doc.schemaVersion).toBe(1);
  expect(doc.status).toBe("healthy");
  expect(doc.components.map((component) => component.id)).toEqual([
    "browser.fallback",
    "browser.proxy",
    "desktop.xrdp",
    "desktop.xrdp-sesman",
    "memory.dev-a.primary",
    "remote-control.agent-rc-claude-dev-a-app.service",
  ]);
  expect(doc.components.find((component) => component.id === "desktop.xrdp")?.observed)
    .toContain("xrdp owns 127.0.0.1:3389");
});

test("a failed unit and a foreign listener owner never become healthy", async () => {
  const runner: CommandRunner = async (argv) => {
    if (argv[0] === "systemctl" && argv.at(-1) === "xrdp.service") {
      return ok("LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\n");
    }
    if (argv[0] === "systemctl") return healthyRunner(argv);
    if (argv.join(" ") === "ss -Hlnpt") {
      const base = await healthyRunner(argv);
      return ok(base.stdout.replace('"haproxy"', '"foreign"'));
    }
    return healthyRunner(argv);
  };

  const doc = await collectHostDocument(facts, runner, new Date("2026-08-09T00:00:00.000Z"));

  expect(doc.components.find((component) => component.id === "desktop.xrdp")?.reason).toBe("unit_failed");
  expect(doc.components.find((component) => component.id === "browser.proxy")?.reason).toBe("listener_owner_mismatch");
  expect(doc.status).toBe("failed");
});

test("a timed-out evidence boundary is unknown and serialized output contains no secret marker", async () => {
  const marker = "PASSWORD=SECRET_HASH_MUST_NOT_APPEAR";
  const runner: CommandRunner = async (argv) => {
    if (argv.join(" ") === "ss -Hlnpt") {
      return { stdout: marker, stderr: marker, exitCode: null, timedOut: true };
    }
    return healthyRunner(argv);
  };

  const doc = await collectHostDocument(facts, runner, new Date("2026-08-09T00:00:00.000Z"));
  const memory = doc.components.find((component) => component.id === "memory.dev-a.primary");

  expect(memory?.status).toBe("unknown");
  expect(memory?.reason).toBe("probe_timeout");
  expect(JSON.stringify(doc)).not.toContain(marker);
});

test("a probe that cannot be started becomes unknown instead of aborting the snapshot", async () => {
  const runner: CommandRunner = async (argv) => {
    if (argv[0] === "ss") throw new Error("ENOENT with SECRET_TOKEN");
    return healthyRunner(argv);
  };

  const doc = await collectHostDocument(facts, runner, new Date("2026-08-09T00:00:00.000Z"));
  const xrdp = doc.components.find((component) => component.id === "desktop.xrdp");

  expect(xrdp?.status).toBe("unknown");
  expect(xrdp?.reason).toBe("probe_unavailable");
  expect(JSON.stringify(doc)).not.toContain("SECRET_TOKEN");
});
