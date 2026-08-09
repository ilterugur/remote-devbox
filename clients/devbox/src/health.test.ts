import { expect, test } from "bun:test";
import {
  combineHealth,
  fetchBoxHealth,
  parseHealthDocument,
  parseLaunchctlState,
  probeAgentHealth,
  runDoctor,
  type DoctorRunner,
  type HealthDocument,
  type LocalHealthResult,
} from "./health";
import type { AgentSpec } from "./agent";
import type { Config } from "./config";

const box = (status: "healthy" | "failed" = "healthy"): HealthDocument => ({
  schemaVersion: 1,
  status,
  observedAt: "2026-08-09T12:00:00.000Z",
  components: [{
    id: "desktop.xrdp",
    status,
    expected: ["xrdp active"],
    observed: [status === "healthy" ? "active/running" : "failed/failed"],
    ...(status === "failed" ? { reason: "unit_failed" } : {}),
    recovery: "automatic",
  }],
});

const local = (status: "healthy" | "failed" = "healthy"): LocalHealthResult => ({
  id: "client.rdp-tunnel.dev-a",
  status,
  expected: ["launchd SSH PID owns 127.0.0.1:3390"],
  observed: [status === "healthy" ? "ssh pid 91 owns 127.0.0.1:3390" : "foreign pid owns 127.0.0.1:3390"],
  ...(status === "failed" ? { reason: "listener_owner_mismatch" } : {}),
  recovery: "automatic",
  remoteComponent: "desktop.xrdp",
});

test("parseHealthDocument accepts schema 1, ignores unknown fields, and rejects unsupported versions", () => {
  expect(parseHealthDocument({ ...box(), additive: true }).schemaVersion).toBe(1);
  expect(() => parseHealthDocument({ ...box(), schemaVersion: 2 })).toThrow("unsupported health schema");
});

test("combineHealth requires both local ownership and downstream box health", () => {
  const healthy = combineHealth(box(), [local()], new Date("2026-08-09T12:00:01.000Z"));
  expect(healthy.components.find((item) => item.id === local().id)?.status).toBe("healthy");

  const downstreamFailed = combineHealth(box("failed"), [local()], new Date("2026-08-09T12:00:01.000Z"));
  const tunnel = downstreamFailed.components.find((item) => item.id === local().id);
  expect(tunnel?.status).toBe("failed");
  expect(tunnel?.reason).toBe("downstream_unit_failed");
});

test("a foreign local owner stays failed even when xrdp is healthy", () => {
  const document = combineHealth(box(), [local("failed")], new Date("2026-08-09T12:00:01.000Z"));
  const tunnel = document.components.find((item) => item.id === local().id);
  expect(tunnel?.status).toBe("failed");
  expect(tunnel?.reason).toBe("listener_owner_mismatch");
});

test("missing downstream evidence makes a locally healthy forward unknown", () => {
  const unavailable: HealthDocument = {
    schemaVersion: 1,
    status: "unknown",
    observedAt: "2026-08-09T12:00:00.000Z",
    components: [{
      id: "box.transport",
      status: "unknown",
      expected: ["box doctor JSON"],
      observed: ["ssh transport failed"],
      reason: "transport_failed",
      recovery: "none",
    }],
  };
  const document = combineHealth(unavailable, [local()], new Date("2026-08-09T12:00:01.000Z"));
  const tunnel = document.components.find((item) => item.id === local().id);
  expect(tunnel?.status).toBe("unknown");
  expect(tunnel?.reason).toBe("downstream_unknown");
});

test("fetchBoxHealth parses valid JSON even when doctor exits nonzero for failed health", () => {
  const runner: DoctorRunner = () => ({ status: 1, stdout: JSON.stringify(box("failed")), stderr: "" });
  expect(fetchBoxHealth("devbox-dev-a", runner).status).toBe("failed");
});

test("fetchBoxHealth maps transport, malformed JSON, and unsupported schemas to unknown", () => {
  const cases: DoctorRunner[] = [
    () => ({ status: 255, stdout: "", stderr: "ssh failed" }),
    () => ({ status: 0, stdout: "not json", stderr: "" }),
    () => ({ status: 0, stdout: JSON.stringify({ ...box(), schemaVersion: 2 }), stderr: "" }),
  ];
  for (const runner of cases) {
    const document = fetchBoxHealth("devbox-dev-a", runner);
    expect(document.status).toBe("unknown");
    expect(document.components[0]?.id).toBe("box.transport");
  }
});

test("parseLaunchctlState extracts the running state and PID", () => {
  expect(parseLaunchctlState(`com.devbox.dev-a.desktop = {\n\tstate = running\n\tpid = 91\n}`)).toEqual({
    state: "running",
    pid: 91,
  });
  expect(parseLaunchctlState("state = exited\nlast exit code = 1")).toEqual({ state: "exited", pid: null });
});

const desktopSpec: AgentSpec = {
  label: "com.devbox.dev-a.desktop",
  mode: "daemon",
  description: "RDP tunnel",
  argv: ["ssh", "-N", "-L", "127.0.0.1:3390:127.0.0.1:3389", "devbox-dev-a"],
};

test("probeAgentHealth requires the launchd SSH PID to own the desktop listener", () => {
  const commands: string[] = [];
  const healthy = probeAgentHealth(desktopSpec, "dev-a", (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "launchctl") return { status: 0, stdout: "state = running\npid = 91\n", stderr: "" };
    return { status: 0, stdout: "ssh 91 user 5u IPv4 TCP 127.0.0.1:3390 (LISTEN)\n", stderr: "" };
  });
  expect(healthy.status).toBe("healthy");
  expect(healthy.remoteComponent).toBe("desktop.xrdp");
  expect(commands[1]).toContain("-p 91");
  expect(commands[1]).toContain("-iTCP:3390");

  const foreign = probeAgentHealth(desktopSpec, "dev-a", (command) => command === "launchctl"
    ? { status: 0, stdout: "state = running\npid = 91\n", stderr: "" }
    : { status: 1, stdout: "", stderr: "" });
  expect(foreign.status).toBe("failed");
  expect(foreign.reason).toBe("listener_owner_mismatch");
});

test("probeAgentHealth reports a loaded daemon without a running PID as recovering", () => {
  const result = probeAgentHealth(desktopSpec, "dev-a", () => ({
    status: 0,
    stdout: "state = waiting\nlast exit code = 255\n",
    stderr: "",
  }));
  expect(result.status).toBe("recovering");
  expect(result.reason).toBe("agent_not_running");
});

test("probeAgentHealth uses a supervisor's ready-file SSH PID for browser forwards", () => {
  const spec: AgentSpec = {
    label: "com.devbox.dev-a.browser-port-5173",
    mode: "daemon",
    description: "browser port",
    readyFile: "/tmp/browser.ready",
    forwardPort: 5173,
    argv: ["sh", "-c", "supervisor"],
  };
  const commands: string[] = [];
  const result = probeAgentHealth(spec, "dev-a", (command, args) => {
    commands.push([command, ...args].join(" "));
    return command === "launchctl"
      ? { status: 0, stdout: "state = running\npid = 44\n", stderr: "" }
      : { status: 0, stdout: "ssh 72 user TCP 127.0.0.1:5173 (LISTEN)\n", stderr: "" };
  }, () => "72\n");
  expect(result.status).toBe("healthy");
  expect(commands[1]).toContain("-p 72");
});

test("runDoctor emits one JSON document combining local PID ownership and box health", async () => {
  const cfg: Config = {
    prefix: "devbox", default: "dev-a", locale: "en_US.UTF-8", launch: "",
    profiles: [{ user: "dev-a", projects: [], desktop: { clientPort: 3390, access: ["tunnel"] } }],
  };
  let output = "";
  const status = await runDoctor(cfg, "dev-a", {
    json: true,
    now: new Date("2026-08-09T12:00:01.000Z"),
    write: (value) => { output += value; },
    runner: (command) => {
      if (command === "ssh") return { status: 0, stdout: JSON.stringify(box()), stderr: "" };
      if (command === "launchctl") return { status: 0, stdout: "state = running\npid = 91\n", stderr: "" };
      return { status: 0, stdout: "ssh 91 user TCP 127.0.0.1:3390 (LISTEN)\n", stderr: "" };
    },
  });
  expect(status).toBe(0);
  expect(JSON.parse(output).components.map((item: HealthResult) => item.id)).toContain("client.rdp-tunnel.dev-a");
});
