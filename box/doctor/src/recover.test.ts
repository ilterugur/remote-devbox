import { describe, expect, test } from "bun:test";
import { recoverBoxComponent } from "./recover";
import type { CommandRunner } from "./collect";
import type { HealthFacts } from "./facts";
import type { HealthDocument, HealthResult } from "./types";

const facts: HealthFacts = {
  schemaVersion: 1,
  components: [
    { id: "desktop.xrdp", unit: "xrdp.service", recovery: "automatic" },
    { id: "desktop.xrdp-sesman", unit: "xrdp-sesman.service", recovery: "confirmation-required" },
    { id: "browser.fallback", unit: "devbox-fallback-chrome.service", recovery: "automatic" },
    {
      id: "memory.dev-a.primary",
      profile: "dev-a",
      unit: "hindsight-primary.service",
      unitScope: "user",
      recovery: "manual",
    },
    {
      id: "remote-control.agent-rc-claude-dev-a-web.service",
      profile: "dev-a",
      unit: "agent-rc-claude-dev-a-web.service",
      recovery: "automatic",
    },
  ],
};

const component = (id: string, status: "healthy" | "failed" = "failed"): HealthResult => ({
  id,
  status,
  expected: ["unit active"],
  observed: [status],
  ...(status === "failed" ? { reason: "unit_failed" } : {}),
  recovery: facts.components.find((fact) => fact.id === id)?.recovery ?? "none",
});

const document = (result: HealthResult): HealthDocument => ({
  schemaVersion: 1,
  status: result.status,
  observedAt: "2026-08-09T12:00:00.000Z",
  components: [result],
});

function fixture(id: string, options: { uid?: number; healthy?: boolean; activeTurn?: boolean } = {}) {
  const commands: string[][] = [];
  let reads = 0;
  const run: CommandRunner = async (argv) => {
    commands.push(argv);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  };
  return {
    commands,
    call: () => recoverBoxComponent(id, {
      uid: options.uid ?? 0,
      facts,
      run,
      hasActiveTurn: async () => options.activeTurn ?? false,
      collectFresh: async () => {
        reads++;
        return document(component(id, options.healthy || reads > 1 ? "healthy" : "failed"));
      },
    }),
  };
}

describe("recoverBoxComponent", () => {
  test("requires root and an exact allowlisted stable component ID", async () => {
    expect(await fixture("desktop.xrdp", { uid: 501 }).call()).toEqual({
      status: "refused",
      reason: "root_required",
    });
    for (const id of ["unknown.component", "desktop.xrdp;reboot", "xrdp.service", "*"]) {
      expect((await fixture(id).call()).status).toBe("refused");
    }
  });

  test("never restarts a healthy or confirmation-required desktop service", async () => {
    const healthy = fixture("desktop.xrdp", { healthy: true });
    expect(await healthy.call()).toEqual({ status: "skipped", reason: "already_healthy" });
    expect(healthy.commands).toEqual([]);

    const sesman = fixture("desktop.xrdp-sesman");
    expect(await sesman.call()).toEqual({ status: "refused", reason: "confirmation_required" });
    expect(sesman.commands).toEqual([]);
  });

  test("starts one exact failed xrdp unit and verifies it afterward", async () => {
    const recovery = fixture("desktop.xrdp");
    expect(await recovery.call()).toEqual({ status: "recovered", reason: "component_healthy" });
    expect(recovery.commands).toEqual([
      ["systemctl", "reset-failed", "xrdp.service"],
      ["systemctl", "start", "xrdp.service"],
    ]);
  });

  test("blocks Remote Control when its exact session is still active", async () => {
    const id = "remote-control.agent-rc-claude-dev-a-web.service";
    const active = fixture(id, { activeTurn: true });
    expect(await active.call()).toEqual({ status: "refused", reason: "active_session" });
    expect(active.commands).toEqual([]);

    const inactive = fixture(id);
    expect((await inactive.call()).status).toBe("recovered");
    expect(inactive.commands[1]).toEqual(["systemctl", "start", "agent-rc-claude-dev-a-web.service"]);
  });

  test("targets memory through the exact user's systemd manager and browser through system scope", async () => {
    const memory = fixture("memory.dev-a.primary");
    expect((await memory.call()).status).toBe("recovered");
    expect(memory.commands[1]).toEqual([
      "systemctl", "--user", "--machine=dev-a@", "start", "hindsight-primary.service",
    ]);

    const browser = fixture("browser.fallback");
    expect((await browser.call()).status).toBe("recovered");
    expect(browser.commands[1]).toEqual(["systemctl", "start", "devbox-fallback-chrome.service"]);
  });
});
