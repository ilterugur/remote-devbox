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
  DeveloperSpec,
  DevboxSpec,
  EngineId,
  ProjectSpec,
  ResolvedDeveloper,
  ResolvedProject,
  ResolvedSpec,
} from "./types";

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
      };
    });

    return { ...rest, projects };
  });

  return { resolved: hasErrors(issues) ? null : { ...spec, developers }, issues };
}
