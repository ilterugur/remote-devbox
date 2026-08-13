/**
 * plan.ts — the human-readable `devbox plan` report.
 *
 * This is the artifact an operator reads BEFORE an apply, so it prints resolved
 * decisions, not the config as written: each project line shows the git identity,
 * agent profile, container engine and memory space it actually ended up with.
 */
import type { Issue } from "./issues";
import { defaultDesktopAccess, defaultSshAccess } from "./resolve";
import { assignClientPorts } from "./client-ports";
import { formatMemoryLimit, isMemoryWeight } from "./memory-limit";
import { resolveEntry } from "../app-configs/registry";
import { DEFAULT_CLI_TARGETS } from "./types";
import type { ClientFacts, ResolvedDeveloper, ResolvedSpec } from "./types";

const LABEL_WIDTH = 12;

const row = (label: string, value: string, indent = ""): string =>
  `${indent}${label.padEnd(LABEL_WIDTH)}${value}`;

export function renderPlan(
  resolved: ResolvedSpec,
  issues: Issue[],
  secretNames: string[] = [],
  client: ClientFacts = { keyboard: null },
): string {
  const p = resolved.platform;
  const lines: string[] = [`devbox plan — ${p.distribution} ${p.version} ${p.architecture}`, ""];

  const keys = resolved.operator.ssh_authorized_keys.length;
  lines.push(row("operator", `${resolved.operator.user} (${keys} ssh key${keys === 1 ? "" : "s"})`));
  lines.push(
    row(
      "network",
      `tailscale ${resolved.network.tailscale.enabled ? "on" : "off"} · ssh via ${(resolved.network.ssh.access ?? defaultSshAccess(resolved.network.tailscale.enabled)).join(" + ")}`,
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

  const targets = resolved.clients?.cli_targets ?? DEFAULT_CLI_TARGETS;
  lines.push(row("client cli", targets.length ? `published for ${targets.join(", ")}` : "not published"));

  // Names only — a plan is something you paste into a chat or a ticket.
  lines.push(row("secrets", secretNames.length ? secretNames.join(", ") : "none loaded"));
  const runtimes = Object.entries(resolved.runtimes ?? {}).map(([k, v]) => `${k} ${v}`);
  lines.push(row("runtimes", runtimes.length ? runtimes.join(" · ") : "none"));

  // The client port is decided across developers, not within one, so it is resolved here
  // and handed down — a plan that showed the desktop but not the address a client dials
  // would hide the one number the developer has to type into their RDP client.
  const clientPorts = assignClientPorts(
    resolved.developers.map((d) => ({
      user: d.user,
      desktopEnabled: d.desktop?.enabled ?? false,
      clientPort: d.desktop?.client_port,
    })),
  );

  for (const dev of resolved.developers) {
    lines.push(
      "",
      ...developerLines(
        dev,
        resolved.network.tailscale.enabled,
        client,
        clientPorts.get(dev.user),
        resolved.host?.heavy_job_gate?.enabled ?? true,
      ),
    );
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  lines.push(
    "",
    `${warnings} warning${warnings === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}`,
  );
  return lines.join("\n");
}

function developerLines(
  dev: ResolvedDeveloper,
  tailscale: boolean,
  client: ClientFacts,
  clientPort?: number,
  hostHeavyJobGateEnabled = true,
): string[] {
  const lines = [`developer ${dev.user}${dev.adopt_existing ? "  (adopt existing account)" : ""}`];
  const indent = "  ";

  lines.push(row("login keys", String(dev.login_ssh_keys.length), indent));
  lines.push(row("heavy jobs", (dev.heavy_job_gate?.enabled ?? hostHeavyJobGateEnabled) ? "on" : "off", indent));

  const memoryHigh = dev.resources?.memory_high;
  const limits = [
    ...(memoryHigh !== undefined
      ? [`memory_high ${isMemoryWeight(memoryHigh) ? "weight " : ""}${formatMemoryLimit(memoryHigh)}`]
      : []),
    ...Object.entries(dev.resources ?? {})
      .filter(([key]) => key !== "memory_high")
      .map(([key, value]) => `${key} ${value}`),
  ];
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
          `via ${(dev.desktop.access ?? defaultDesktopAccess(tailscale)).join(" + ")}`,
          clientPort ? `client dials 127.0.0.1:${clientPort}` : "no client port",
          idle ? `idle logout ${idle}m` : "no idle logout",
          describeKeyboard(dev, client),
        ].join(" · "),
        indent,
      ),
    );
  }

  // Only shown when the disk is on: an "off" line for every developer would be noise on
  // the boxes that never use it, but a disk that IS on and goes unmentioned makes the
  // plan look like the feature was never declared.
  const mounts = dev.file_bridge?.lazy_mounts ?? [];
  if (dev.file_bridge?.sync_disk || mounts.length) {
    const apps = dev.app_configs?.enabled ? (dev.app_configs.paths ?? []) : [];
    const labels = apps.map((raw) => {
      const r = resolveEntry(raw);
      return "entry" in r ? r.entry.label : String(raw);
    });
    const parts = dev.file_bridge?.sync_disk
      ? [
          `sync disk via ${dev.file_bridge.engine ?? "mutagen"}`,
          labels.length ? `app configs ${labels.join(", ")}` : "no app configs",
        ]
      : ["no sync disk"];
    if (mounts.length) {
      const when = dev.file_bridge?.lazy_mount_on_connect ? " (on connect)" : "";
      parts.push(`mounts ${mounts.map((m) => m.label).join(", ")}${when}`);
    }
    lines.push(row("file bridge", parts.join(" · "), indent));
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

/**
 * Where the session's layout came from, not just what it is: the detected one is the
 * operator's own keyboard, which is a guess for every other developer on the box.
 */
function describeKeyboard(dev: ResolvedDeveloper, client: ClientFacts): string {
  const stated = dev.desktop?.keyboard;
  if (stated) return `keyboard ${xkb(stated.layout, stated.variant)}`;
  if (client.keyboard) return `keyboard ${xkb(client.keyboard.layout, client.keyboard.variant)} (detected from this client)`;
  return "keyboard us (box default — undetected)";
}

const xkb = (layout: string, variant: string | null | undefined): string =>
  variant ? `${layout}(${variant})` : layout;

const named = (keys: string[], fallback: string | null | undefined): string =>
  keys.length ? keys.map((k) => (k === fallback ? `${k} (default)` : k)).join(", ") : "unmanaged";
