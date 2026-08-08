import { describe, expect, test } from "bun:test";
import {
  decideRecovery,
  recoveryRegistrationFor,
  validateRecoveryCoverage,
  type RecoveryRegistration,
} from "./recovery";
import type { HealthResult, HealthStatus, RecoveryPolicy } from "./health";

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
    "client.mount.dev-a.workspace",
    "client.sync.dev-a",
    "box.transport",
    "box.snapshot",
  ];
  expect(validateRecoveryCoverage(ids)).toEqual([]);
  expect(recoveryRegistrationFor("unregistered.component")).toBeNull();
  expect(validateRecoveryCoverage(["unregistered.component"])).toEqual(["unregistered.component"]);
});
