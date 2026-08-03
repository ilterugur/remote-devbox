/**
 * plan.ts — the human-readable `devbox plan` report.
 *
 * This is the artifact an operator reads BEFORE an apply, so it prints resolved
 * decisions, not the config as written: each project line shows the git identity,
 * agent profile, container engine and memory space it actually ended up with.
 */
import type { Issue } from "./issues";
import type { ResolvedDeveloper, ResolvedSpec } from "./types";

const LABEL_WIDTH = 12;

const row = (label: string, value: string, indent = ""): string =>
  `${indent}${label.padEnd(LABEL_WIDTH)}${value}`;

export function renderPlan(resolved: ResolvedSpec, issues: Issue[], secretNames: string[] = []): string {
  const p = resolved.platform;
  const lines: string[] = [`devbox plan — ${p.distribution} ${p.version} ${p.architecture}`, ""];

  const keys = resolved.operator.ssh_authorized_keys.length;
  lines.push(row("operator", `${resolved.operator.user} (${keys} ssh key${keys === 1 ? "" : "s"})`));
  lines.push(
    row(
      "network",
      `tailscale ${resolved.network.tailscale.enabled ? "on" : "off"} · ssh ${resolved.network.ssh.exposure}`,
    ),
  );
  lines.push(
    row(
      "containers",
      `default ${resolved.container.default_engine} · installed ${resolved.container.install_engines.join(", ")}`,
    ),
  );
  lines.push(
    row(
      "shared svcs",
      resolved.shared_services?.enabled ? `enabled (${resolved.shared_services.engine})` : "disabled",
    ),
  );

  // Names only — a plan is something you paste into a chat or a ticket.
  lines.push(row("secrets", secretNames.length ? secretNames.join(", ") : "none loaded"));
  const runtimes = Object.entries(resolved.runtimes ?? {}).map(([k, v]) => `${k} ${v}`);
  lines.push(row("runtimes", runtimes.length ? runtimes.join(" · ") : "none"));

  for (const dev of resolved.developers) lines.push("", ...developerLines(dev));

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  lines.push(
    "",
    `${warnings} warning${warnings === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}`,
  );
  return lines.join("\n");
}

function developerLines(dev: ResolvedDeveloper): string[] {
  const lines = [`developer ${dev.user}${dev.adopt_existing ? "  (adopt existing account)" : ""}`];
  const indent = "  ";

  lines.push(row("login keys", String(dev.login_ssh_keys.length), indent));

  const limits = Object.entries(dev.resources ?? {}).map(([k, v]) => `${k} ${v}`);
  lines.push(row("resources", limits.length ? limits.join(" · ") : "unlimited (host defaults)", indent));

  lines.push(row("git", named(Object.keys(dev.git_identities ?? {}), dev.default_git_identity), indent));
  lines.push(
    row(
      "agents",
      Object.keys(dev.agent_profiles ?? {}).length
        ? Object.entries(dev.agent_profiles ?? {})
            .map(([k, v]) => `${k} (${v.provider}${k === dev.default_agent_profile ? ", default" : ""})`)
            .join(", ")
        : "none",
      indent,
    ),
  );

  if (dev.memory?.enabled) {
    const instances = Object.entries(dev.memory.instances ?? {})
      .map(([k, v]) => `${k}→${v.llm_provider}`)
      .join(", ");
    const spaces = Object.entries(dev.memory.spaces ?? {})
      .map(([k, v]) => `${k}→${v.bank}${k === dev.memory?.default_space ? " (default)" : ""}`)
      .join(", ");
    lines.push(row("memory", `${instances || "no instance"} · spaces ${spaces || "none"}`, indent));
  } else {
    lines.push(row("memory", "disabled", indent));
  }

  if (dev.desktop?.enabled) {
    const idle = dev.desktop.idle_logout_minutes;
    lines.push(
      row(
        "desktop",
        [
          `${dev.desktop.environment}/${dev.desktop.transport}`,
          dev.desktop.tailscale_only === false ? "PUBLIC" : "tailnet-only",
          idle ? `idle logout ${idle}m` : "no idle logout",
        ].join(" · "),
        indent,
      ),
    );
  }

  if (!dev.projects.length) {
    lines.push(row("projects", "none", indent));
    return lines;
  }
  lines.push(`${indent}projects`);
  const width = Math.max(...dev.projects.map((p) => p.name.length));
  for (const project of dev.projects) {
    const cells = [
      `git=${project.git_identity ?? "unmanaged"}`,
      `agent=${project.agent_profile ?? "none"}`,
      `engine=${project.container_engine}`,
      `memory=${project.memory_space ?? "off"}`,
    ];
    if (project.ports.length) cells.push(`ports ${project.ports.join(",")}`);
    lines.push(`${indent}  ${project.name.padEnd(width)}  ${cells.join("  ")}`);
  }
  return lines;
}

const named = (keys: string[], fallback: string | null | undefined): string =>
  keys.length ? keys.map((k) => (k === fallback ? `${k} (default)` : k)).join(", ") : "unmanaged";
