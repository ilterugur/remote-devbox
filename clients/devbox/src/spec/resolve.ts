/**
 * resolve.ts — the default/override chains of the developer model.
 *
 * Every ambiguity is an ERROR, never a silent pick: two git identities with no default
 * and no per-project override is exactly how you push to the wrong GitHub account. The
 * output has no optional fields left — Ansible consumes decisions, not policy.
 *
 *   git identity      project → developer default → sole identity → none → ambiguous
 *   agent profile     project → developer default → sole profile  → none → ambiguous
 *   container engine  project → developer → global default → "none"
 *   memory space      memory off → project → agent profile → developer default →
 *                     sole space → none → ambiguous
 */
import { type Issue, err, hasErrors } from "./issues";
import type {
  DesktopAccess,
  SshAccess,
  DeveloperSpec,
  DevboxSpec,
  EngineId,
  ProjectSpec,
  RcResourceSpec,
  RcSpawn,
  ResolvedDeveloper,
  ResolvedProject,
  ResolvedRcUnit,
  ResolvedSpec,
} from "./types";

/**
 * Every private path that exists, and nothing that does not. Defaulting to a list that
 * names the tailnet on a box without Tailscale would turn "I just want a desktop" into a
 * validation error; asking for it explicitly still does, which is the useful half.
 */
export const defaultDesktopAccess = (tailscaleEnabled: boolean): DesktopAccess[] =>
  tailscaleEnabled ? ["tunnel", "tailnet"] : ["tunnel"];

/**
 * SSH keeps a public path by default on purpose: losing Tailscale must not lock you out
 * of the box. That asymmetry with the desktop — which has no such recovery role — is the
 * whole reason these are two separate settings.
 */
export const defaultSshAccess = (tailscaleEnabled: boolean): SshAccess[] =>
  tailscaleEnabled ? ["public", "tailnet"] : ["public"];

interface Choice {
  value: string | null;
  issue?: Issue;
}

/** override → explicit default → sole candidate → nothing declared → ambiguous. */
function chooseNamed(
  override: string | undefined,
  fallback: string | undefined,
  available: string[],
  path: string,
  what: string,
): Choice {
  if (override) return { value: override };
  if (fallback) return { value: fallback };
  if (available.length === 1) return { value: available[0]! };
  if (available.length === 0) return { value: null };
  return {
    value: null,
    issue: err(
      path,
      `${available.length} ${what}s are declared (${available.join(", ")}) but neither a default nor a per-project choice — pick one`,
    ),
  };
}

export function resolveEngine(spec: DevboxSpec, dev: DeveloperSpec, project: ProjectSpec): EngineId {
  return project.container_engine ?? dev.container_engine ?? spec.container.default_engine ?? "none";
}

export function resolveGitIdentity(dev: DeveloperSpec, project: ProjectSpec, path: string): Choice {
  return chooseNamed(
    project.git_identity,
    dev.default_git_identity,
    Object.keys(dev.git_identities ?? {}),
    path,
    "git identity",
  );
}

export function resolveAgentProfile(dev: DeveloperSpec, project: ProjectSpec, path: string): Choice {
  return chooseNamed(
    project.agent_profile,
    dev.default_agent_profile,
    Object.keys(dev.agent_profiles ?? {}),
    path,
    "agent profile",
  );
}

/**
 * Note the ordering dependency: the agent profile must already be resolved, because a
 * profile can pin its own space — that is what lets one developer keep a work agent and
 * a personal agent on separate banks without touching any project entry.
 */
export function resolveMemorySpace(
  dev: DeveloperSpec,
  project: ProjectSpec,
  agentProfile: string | null,
  path: string,
): Choice {
  if (dev.memory?.enabled !== true) return { value: null };
  if (project.memory_space) {
    return { value: project.memory_space === "none" ? null : project.memory_space };
  }
  const fromAgent = agentProfile ? dev.agent_profiles?.[agentProfile]?.memory_space : undefined;
  if (fromAgent) return { value: fromAgent === "none" ? null : fromAgent };
  return chooseNamed(
    undefined,
    dev.memory.default_space,
    Object.keys(dev.memory.spaces ?? {}),
    path,
    "memory space",
  );
}

/**
 * Box-wide fallbacks. Deliberately no memory_* key: a ceiling inherited from an earlier,
 * smaller box is the failure this model exists to prevent. The relative knobs are safe to
 * default — they only decide who yields first, never how much anyone may have. `oom_policy`
 * belongs here for the same reason: it decides what happens when a ceiling is crossed, not
 * where the ceiling sits.
 */
export const RC_DEFAULTS = {
  spawn: "worktree" as RcSpawn,
  capacity: 4,
  resources: {
    cpu_weight: 80,
    io_weight: 80,
    nice: 5,
    oom_score_adjust: 300,
    oom_policy: "continue",
  } as RcResourceSpec,
};

/**
 * One unit per project, or null when Remote Control does not apply. The agent profile
 * must already be resolved: the unit runs that profile's provider binary, so a project
 * with no profile has nothing to run.
 */
export function resolveRemoteControl(
  spec: DevboxSpec,
  dev: DeveloperSpec,
  project: ProjectSpec,
  agentProfile: string | null,
): ResolvedRcUnit | null {
  const box = spec.remote_control ?? {};
  if (box.enabled === false) return null;
  const override = project.remote_control;
  if (override === false || override?.enabled === false) return null;
  if (!agentProfile) return null;
  const provider = dev.agent_profiles?.[agentProfile]?.provider;
  if (!provider) return null;

  return {
    agent: provider,
    agent_profile: agentProfile,
    name: override?.name ?? `${dev.user} · ${project.name}`,
    spawn: override?.spawn ?? box.spawn ?? RC_DEFAULTS.spawn,
    capacity: override?.capacity ?? box.capacity ?? RC_DEFAULTS.capacity,
    resources: { ...RC_DEFAULTS.resources, ...(box.resources ?? {}), ...(override?.resources ?? {}) },
    build_env: { ...(box.build_env ?? {}), ...(override?.build_env ?? {}) },
  };
}

export function resolveSpec(spec: DevboxSpec): { resolved: ResolvedSpec | null; issues: Issue[] } {
  const issues: Issue[] = [];

  const developers: ResolvedDeveloper[] = spec.developers.map((dev, i) => {
    const base = `developers[${i}]`;
    const { projects: declared, ...rest } = dev;

    const projects: ResolvedProject[] = (declared ?? []).map((project, j) => {
      const path = `${base}.projects[${j}]`;
      const git = resolveGitIdentity(dev, project, `${path}.git_identity`);
      const agent = resolveAgentProfile(dev, project, `${path}.agent_profile`);
      const memory = resolveMemorySpace(dev, project, agent.value, `${path}.memory_space`);
      for (const choice of [git, agent, memory]) if (choice.issue) issues.push(choice.issue);

      return {
        name: project.name,
        repo: project.repo,
        branch: project.branch ?? "main",
        git_identity: git.value,
        agent_profile: agent.value,
        container_engine: resolveEngine(spec, dev, project),
        memory_space: memory.value,
        ports: project.ports ?? [],
        install: project.install ?? true,
        update: project.update ?? false,
        remote_control: resolveRemoteControl(spec, dev, project, agent.value),
      };
    });

    return { ...rest, projects };
  });

  return { resolved: hasErrors(issues) ? null : { ...spec, developers }, issues };
}
