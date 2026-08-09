import { describe, expect, test } from "bun:test";
import {
  decideRecovery,
  recoveryRegistrationFor,
  runRecoverySelection,
  validateRecoveryCoverage,
  type RecoveryRegistration,
} from "./recovery";
import type { HealthDocument, HealthResult, HealthStatus, RecoveryPolicy } from "./health";

const registration: RecoveryRegistration = {
  component: "test.component",
  policy: "automatic",
  ownership: "client-agent",
  recoverableReasons: ["agent_not_loaded", "listener_owner_mismatch"],
  maxAttempts: 3,
};

function result(status: HealthStatus, policy: RecoveryPolicy = "automatic", reason = "agent_not_loaded"): HealthResult {
  return {
    id: "test.component",
    status,
    expected: ["running"],
    observed: [status],
    ...(reason ? { reason } : {}),
    recovery: policy,
  };
}

describe("decideRecovery", () => {
  test("skips healthy and service-manager-recovering components", () => {
    expect(decideRecovery(result("healthy"), registration, "all")).toEqual({
      action: "skip",
      reason: "already_healthy",
    });
    expect(decideRecovery(result("recovering"), registration, "all")).toEqual({
      action: "skip",
      reason: "recovery_in_progress",
    });
  });

  test("refuses unknown and blocked evidence even for recover all", () => {
    expect(decideRecovery(result("unknown"), registration, "all")).toEqual({
      action: "refuse",
      reason: "evidence_unknown",
    });
    expect(decideRecovery(result("blocked"), registration, "all")).toEqual({
      action: "refuse",
      reason: "component_blocked",
    });
  });

  test("refuses none and confirmation-required policies", () => {
    expect(decideRecovery(result("failed", "none"), { ...registration, policy: "none" }, "single")).toEqual({
      action: "refuse",
      reason: "recovery_not_supported",
    });
    expect(decideRecovery(
      result("failed", "confirmation-required"),
      { ...registration, policy: "confirmation-required" },
      "single",
    )).toEqual({ action: "refuse", reason: "confirmation_required" });
  });

  test("runs failed or degraded automatic/manual entries only for allowlisted reasons", () => {
    expect(decideRecovery(result("failed"), registration, "all")).toEqual({
      action: "run",
      registration,
    });
    const manual = { ...registration, policy: "manual" as const };
    expect(decideRecovery(result("degraded", "manual"), manual, "single").action).toBe("run");
    expect(decideRecovery(result("failed", "automatic", "unexpected"), registration, "single")).toEqual({
      action: "refuse",
      reason: "reason_not_allowlisted",
    });
  });

  test("fails closed when the observed and registered policies disagree", () => {
    expect(decideRecovery(result("failed", "manual"), registration, "single")).toEqual({
      action: "refuse",
      reason: "policy_mismatch",
    });
  });
});

test("the registry covers stable and profile-scoped component IDs", () => {
  const ids = [
    "desktop.xrdp",
    "desktop.xrdp-sesman",
    "browser.proxy",
    "browser.fallback",
    "memory.dev-a.primary",
    "remote-control.agent-rc-claude-dev-a-web.service",
    "client.rdp-tunnel.dev-a",
    "client.browser.dev-a",
    "client.agent.com.devbox.dev-a.browser-port-5173",
    "client.agent.com.devbox.dev-a.browser-autobind-port-3000",
    "client.agent.com.devbox.dev-a.mount",
    "client.mount.dev-a.workspace",
    "client.sync.dev-a",
    "box.transport",
    "box.snapshot",
    "profile.dev-a.isolation",
    "profile.dev-a.resources",
  ];
  expect(validateRecoveryCoverage(ids)).toEqual([]);
  expect(recoveryRegistrationFor("unregistered.component")).toBeNull();
  expect(validateRecoveryCoverage(["unregistered.component"])).toEqual(["unregistered.component"]);
});

const healthDocument = (components: HealthResult[]): HealthDocument => ({
  schemaVersion: 1,
  status: components.some((item) => item.status === "failed") ? "failed" : "healthy",
  observedAt: "2026-08-09T12:00:00.000Z",
  components,
});

describe("runRecoverySelection", () => {
  test("runs one eligible client action, then requires a healthy post-probe", async () => {
    const target = { ...result("failed"), id: "client.rdp-tunnel.dev-a" };
    let healthy = false;
    const acted: string[] = [];
    const outcome = await runRecoverySelection(target.id, {
      collect: async () => healthDocument([{ ...target, ...(healthy ? { status: "healthy", reason: undefined } : {}) }]),
      act: async (item) => { acted.push(item.id); healthy = true; return { status: "acted", reason: "agent_bootstrapped" }; },
    });
    expect(acted).toEqual([target.id]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines).toEqual([`${target.id} recovered: healthy after agent_bootstrapped`]);
  });

  test("recover all skips healthy entries and never broadens confirmation or unknown entries", async () => {
    const components: HealthResult[] = [
      { ...result("healthy"), id: "client.rdp-tunnel.dev-a" },
      { ...result("unknown", "none", "transport_failed"), id: "box.transport" },
      { ...result("failed", "confirmation-required", "unit_failed"), id: "desktop.xrdp-sesman" },
    ];
    let called = false;
    const outcome = await runRecoverySelection("all", {
      collect: async () => healthDocument(components),
      act: async () => { called = true; return { status: "acted", reason: "unexpected" }; },
    });
    expect(called).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join("\n")).toContain("already_healthy");
    expect(outcome.lines.join("\n")).toContain("evidence_unknown");
    expect(outcome.lines.join("\n")).toContain("confirmation_required");
  });

  test("box actions are surfaced as exact operator commands, never run by the client", async () => {
    const target = { ...result("failed", "automatic", "unit_failed"), id: "desktop.xrdp" };
    let called = false;
    const outcome = await runRecoverySelection(target.id, {
      collect: async () => healthDocument([target]),
      act: async () => { called = true; return { status: "acted", reason: "unexpected" }; },
    });
    expect(called).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toContain("sudo /usr/local/libexec/remote-devbox-doctor recover desktop.xrdp");
  });

  test("fails closed for missing targets, action failures, and unhealthy post-probes", async () => {
    const target = { ...result("failed"), id: "client.rdp-tunnel.dev-a" };
    expect((await runRecoverySelection("missing", {
      collect: async () => healthDocument([target]),
      act: async () => ({ status: "acted", reason: "unexpected" }),
    })).exitCode).toBe(1);
    expect((await runRecoverySelection(target.id, {
      collect: async () => healthDocument([target]),
      act: async () => ({ status: "failed", reason: "action_failed" }),
    })).lines[0]).toContain("action_failed");
    expect((await runRecoverySelection(target.id, {
      collect: async () => healthDocument([target]),
      act: async () => ({ status: "acted", reason: "agent_restarted" }),
      wait: async () => {},
    })).lines[0]).toContain("post_probe_failed");
  });
});
