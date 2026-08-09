import { expect, test } from "bun:test";
import { collectProfileComponents, systemProfileProbe, type ProfileProbe } from "./profile";
import type { CommandRunner } from "./collect";

const healthy: ProfileProbe = {
  homeMode: async () => 0o700,
  umask: () => 0o077,
  sudo: async () => "denied",
  groups: async () => ["dev-a", "devbox-rdp"],
  cgroupControllers: async () => "cpu io memory pids",
};

test("collectProfileComponents proves the profile isolation invariants", async () => {
  const components = await collectProfileComponents("dev-a", healthy);
  const isolation = components.find((component) => component.id === "profile.dev-a.isolation");
  const resources = components.find((component) => component.id === "profile.dev-a.resources");

  expect(isolation?.status).toBe("healthy");
  expect(isolation?.observed).toEqual([
    "home mode 0700",
    "umask 0077",
    "passwordless sudo denied",
    "docker group absent",
  ]);
  expect(resources?.status).toBe("healthy");
});

test("an insecure home, passwordless sudo, or docker group fails isolation", async () => {
  const components = await collectProfileComponents("dev-a", {
    ...healthy,
    homeMode: async () => 0o755,
    sudo: async () => "allowed",
    groups: async () => ["dev-a", "docker"],
  });
  const isolation = components.find((component) => component.id === "profile.dev-a.isolation");

  expect(isolation?.status).toBe("failed");
  expect(isolation?.reason).toBe("profile_isolation_failed");
  expect(isolation?.observed).toContain("passwordless sudo allowed");
});

test("unavailable profile or cgroup evidence is unknown, never healthy", async () => {
  const components = await collectProfileComponents("dev-a", {
    ...healthy,
    homeMode: async () => null,
    cgroupControllers: async () => null,
  });

  expect(components.find((component) => component.id === "profile.dev-a.isolation")?.status).toBe("unknown");
  expect(components.find((component) => component.id === "profile.dev-a.resources")?.status).toBe("unknown");
});

test("system profile probes contain command spawn failures", async () => {
  const unavailable: CommandRunner = async () => {
    throw new Error("EPERM with TOKEN_MUST_NOT_ESCAPE");
  };
  const probe = systemProfileProbe("dev-a", unavailable);

  expect(await probe.sudo()).toBe("denied");
  expect(await probe.groups()).toBeNull();
});
