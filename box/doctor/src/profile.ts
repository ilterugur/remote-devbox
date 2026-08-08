import { readFileSync, statSync } from "node:fs";
import { runCommand, type CommandRunner } from "./collect";
import type { HealthResult, HealthStatus } from "./types";

export interface ProfileProbe {
  homeMode: () => Promise<number | null>;
  umask: () => number | null;
  sudo: () => Promise<"allowed" | "denied" | "unknown">;
  groups: () => Promise<string[] | null>;
  cgroupControllers: () => Promise<string | null>;
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = {
    healthy: 0, recovering: 1, degraded: 2, unknown: 3, blocked: 4, failed: 5,
  };
  return rank[b] > rank[a] ? b : a;
}

const octal = (value: number) => value.toString(8).padStart(4, "0");

export async function collectProfileComponents(profile: string, probe: ProfileProbe): Promise<HealthResult[]> {
  const [homeMode, sudo, groups, controllers] = await Promise.all([
    probe.homeMode(),
    probe.sudo(),
    probe.groups(),
    probe.cgroupControllers(),
  ]);
  const umask = probe.umask();

  let isolationStatus: HealthStatus = "healthy";
  const observed: string[] = [];
  if (homeMode === null) {
    isolationStatus = worst(isolationStatus, "unknown");
    observed.push("home mode unavailable");
  } else {
    observed.push(`home mode ${octal(homeMode)}`);
    if (homeMode !== 0o700) isolationStatus = worst(isolationStatus, "failed");
  }
  if (umask === null) {
    isolationStatus = worst(isolationStatus, "unknown");
    observed.push("umask unavailable");
  } else {
    observed.push(`umask ${octal(umask)}`);
    if (umask !== 0o077) isolationStatus = worst(isolationStatus, "failed");
  }
  observed.push(`passwordless sudo ${sudo}`);
  if (sudo === "allowed") isolationStatus = worst(isolationStatus, "failed");
  if (sudo === "unknown") isolationStatus = worst(isolationStatus, "unknown");
  if (groups === null) {
    isolationStatus = worst(isolationStatus, "unknown");
    observed.push("group membership unavailable");
  } else {
    const inDocker = groups.includes("docker");
    observed.push(`docker group ${inDocker ? "present" : "absent"}`);
    if (inDocker) isolationStatus = worst(isolationStatus, "failed");
  }

  let resourceStatus: HealthStatus = "healthy";
  const resourceObserved: string[] = [];
  if (controllers === null) {
    resourceStatus = "unknown";
    resourceObserved.push("cgroup controllers unavailable");
  } else if (!controllers.split(/\s+/).includes("memory")) {
    resourceStatus = "failed";
    resourceObserved.push(`delegated controllers: ${controllers || "none"}`);
  } else {
    resourceObserved.push(`delegated controllers: ${controllers}`);
  }

  return [
    {
      id: `profile.${profile}.isolation`,
      profile,
      status: isolationStatus,
      expected: ["home mode 0700", "umask 0077", "passwordless sudo denied", "docker group absent"],
      observed,
      ...(isolationStatus === "healthy" ? {} : { reason: isolationStatus === "failed" ? "profile_isolation_failed" : "profile_evidence_unavailable" }),
      recovery: "none",
    },
    {
      id: `profile.${profile}.resources`,
      profile,
      status: resourceStatus,
      expected: ["memory cgroup controller delegated"],
      observed: resourceObserved,
      ...(resourceStatus === "healthy" ? {} : { reason: resourceStatus === "failed" ? "cgroup_not_delegated" : "profile_evidence_unavailable" }),
      recovery: "none",
    },
  ];
}

export function systemProfileProbe(profile: string, run: CommandRunner = runCommand): ProfileProbe {
  const uid = process.getuid?.();
  return {
    homeMode: async () => {
      try {
        return statSync(`/home/${profile}`).mode & 0o777;
      } catch {
        return null;
      }
    },
    umask: () => process.umask(),
    sudo: async () => {
      try {
        const result = await run(["sudo", "-n", "true"]);
        return result.exitCode === 0 ? "allowed" : "denied";
      } catch {
        return "denied";
      }
    },
    groups: async () => {
      try {
        const result = await run(["id", "-nG"]);
        return result.exitCode === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean) : null;
      } catch {
        return null;
      }
    },
    cgroupControllers: async () => {
      if (uid === undefined) return null;
      try {
        return readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/cgroup.controllers`, "utf8").trim();
      } catch {
        return null;
      }
    },
  };
}
