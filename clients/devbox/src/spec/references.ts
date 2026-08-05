/**
 * references.ts — cross-section validation.
 *
 * validate.ts proves the shape; this proves the wiring: every name a project or a
 * default points at exists, nothing is declared twice, and no two projects claim the
 * same host port. Runs on a structurally valid spec, so it can index freely.
 */
import { type Issue, err, warn } from "./issues";
import type { DevboxSpec } from "./types";

/** Ports the box itself owns: sshd, Eternal Terminal, xRDP. */
export const RESERVED_PORTS = new Set([22, 2022, 3389]);

interface PortClaim {
  port: number;
  path: string;
  label: string;
}

export function validateReferences(spec: DevboxSpec): Issue[] {
  const issues: Issue[] = [];
  const seenUsers = new Map<string, number>();
  const claims: PortClaim[] = [];

  spec.developers.forEach((dev, i) => {
    const base = `developers[${i}]`;

    const firstIndex = seenUsers.get(dev.user);
    if (firstIndex !== undefined) {
      issues.push(err(`${base}.user`, `duplicate developer '${dev.user}' (already declared at developers[${firstIndex}])`));
    } else {
      seenUsers.set(dev.user, i);
    }
    if (dev.user === spec.operator.user) {
      issues.push(
        warn(
          `${base}.user`,
          "this developer IS the operator account; operator privileges stay, so developer hardening cannot fully apply",
        ),
      );
    }

    const identities = Object.keys(dev.git_identities ?? {});
    const profiles = Object.keys(dev.agent_profiles ?? {});
    const instances = Object.keys(dev.memory?.instances ?? {});
    const spaces = Object.keys(dev.memory?.spaces ?? {});

    if (dev.default_git_identity && !identities.includes(dev.default_git_identity)) {
      issues.push(unknownRef(`${base}.default_git_identity`, dev.default_git_identity, "git identity", identities));
    }
    if (dev.default_agent_profile && !profiles.includes(dev.default_agent_profile)) {
      issues.push(unknownRef(`${base}.default_agent_profile`, dev.default_agent_profile, "agent profile", profiles));
    }
    if (dev.memory?.default_space && !isSpaceRef(dev.memory.default_space, spaces)) {
      issues.push(unknownRef(`${base}.memory.default_space`, dev.memory.default_space, "memory space", spaces));
    }

    for (const [key, space] of Object.entries(dev.memory?.spaces ?? {})) {
      if (!instances.includes(space.instance)) {
        issues.push(
          unknownRef(`${base}.memory.spaces.${key}.instance`, space.instance, "memory instance", instances),
        );
      }
    }
    if (dev.memory && dev.memory.enabled === false && spaces.length > 0) {
      issues.push(warn(`${base}.memory`, `memory is disabled but ${spaces.length} space(s) are declared — they will be ignored`));
    }

    for (const [key, profile] of Object.entries(dev.agent_profiles ?? {})) {
      if (profile.memory_space && !isSpaceRef(profile.memory_space, spaces)) {
        issues.push(
          unknownRef(`${base}.agent_profiles.${key}.memory_space`, profile.memory_space, "memory space", spaces),
        );
      }
    }

    // Cross-section, so it belongs here rather than in the structural pass: whether
    // "tailnet" is reachable depends on network.tailscale, not on the desktop block.
    // Only an explicit ask can conflict: the default already omits tailnet when there
    // is no tailnet, so "I just want a desktop" never trips this.
    const access = dev.desktop?.access ?? [];
    if (dev.desktop?.enabled && access.includes("tailnet") && !spec.network.tailscale.enabled) {
      issues.push(
        err(
          `${base}.desktop.access`,
          "'tailnet' needs network.tailscale.enabled: true — there is no private network to listen on",
        ),
      );
    }
    if (dev.desktop?.enabled && access.includes("unsafe-public")) {
      issues.push(
        warn(
          `${base}.desktop.access`,
          "the desktop will be reachable from the internet, and RDP authenticates with a password — every other door on this box is key-only",
        ),
      );
    }

    if (dev.container_engine && !isEngineInstalled(spec, dev.container_engine)) {
      issues.push(uninstalledEngine(`${base}.container_engine`, dev.container_engine, spec));
    }

    const seenProjects = new Map<string, number>();
    (dev.projects ?? []).forEach((project, j) => {
      const path = `${base}.projects[${j}]`;

      const firstProject = seenProjects.get(project.name);
      if (firstProject !== undefined) {
        issues.push(err(`${path}.name`, `duplicate project '${project.name}' for developer '${dev.user}'`));
      } else {
        seenProjects.set(project.name, j);
      }

      if (project.git_identity && !identities.includes(project.git_identity)) {
        issues.push(unknownRef(`${path}.git_identity`, project.git_identity, "git identity", identities));
      }
      if (project.agent_profile && !profiles.includes(project.agent_profile)) {
        issues.push(unknownRef(`${path}.agent_profile`, project.agent_profile, "agent profile", profiles));
      }
      if (project.memory_space && !isSpaceRef(project.memory_space, spaces)) {
        issues.push(unknownRef(`${path}.memory_space`, project.memory_space, "memory space", spaces));
      }
      if (project.container_engine && !isEngineInstalled(spec, project.container_engine)) {
        issues.push(uninstalledEngine(`${path}.container_engine`, project.container_engine, spec));
      }

      for (const port of project.ports ?? []) {
        claims.push({ port, path: `${path}.ports`, label: `${dev.user}/${project.name}` });
      }
    });
  });

  issues.push(...portIssues(claims));

  // The fallback Chrome runs as a real account, under that account's home and display.
  const chromeUser = spec.browser?.failover?.chrome_user;
  if (chromeUser && !seenUsers.has(chromeUser)) {
    issues.push(
      err("browser.failover.chrome_user", `no developer named '${chromeUser}' — the fallback Chrome needs an account to run as`),
    );
  }

  return issues;
}

/** `none` is a literal, not a lookup — it means "off" everywhere it is accepted. */
const isSpaceRef = (value: string, spaces: string[]): boolean => value === "none" || spaces.includes(value);

const isEngineInstalled = (spec: DevboxSpec, engine: string): boolean =>
  engine === "none" || spec.container.install_engines.includes(engine as never);

const unknownRef = (path: string, value: string, what: string, available: string[]): Issue =>
  err(path, `unknown ${what} '${value}'${available.length ? ` (declared: ${available.join(", ")})` : " (none declared)"}`);

const uninstalledEngine = (path: string, engine: string, spec: DevboxSpec): Issue =>
  err(path, `container engine '${engine}' is not in container.install_engines (${spec.container.install_engines.join(", ")})`);

/**
 * Two passes on purpose: a collision must be reported on BOTH claimants, and the first
 * claimant is only known to be in conflict once the second one shows up.
 */
function portIssues(claims: PortClaim[]): Issue[] {
  const byPort = new Map<number, PortClaim[]>();
  for (const claim of claims) {
    const list = byPort.get(claim.port);
    if (list) list.push(claim);
    else byPort.set(claim.port, [claim]);
  }
  const issues: Issue[] = [];
  for (const claim of claims) {
    if (RESERVED_PORTS.has(claim.port)) {
      issues.push(err(claim.path, `port ${claim.port} is reserved by the box (sshd / Eternal Terminal / xRDP)`));
      continue;
    }
    const others = (byPort.get(claim.port) ?? []).filter((c) => c !== claim);
    if (others.length) {
      issues.push(
        err(claim.path, `port ${claim.port} is also claimed by ${others.map((c) => c.label).join(", ")}`),
      );
    }
  }
  return issues;
}
