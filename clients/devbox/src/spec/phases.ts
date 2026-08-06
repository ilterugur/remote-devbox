/**
 * phases.ts — the provisioning phases `devbox apply` can target.
 *
 * A phase is a named slice of the playbook, in the order it is safe to run: operator
 * access is proven before sshd is touched, accounts exist before anything is installed
 * into their homes, and the desktop comes last because it asserts the hardening earlier
 * phases established. Running a later phase alone is fine on a provisioned box; running
 * one on a fresh box without its predecessors is not, which is what `order` encodes.
 */
export interface Phase {
  name: string;
  /** Ansible tags this phase maps to. Empty means "the whole playbook". */
  tags: string[];
  summary: string;
}

export const PHASES: Phase[] = [
  { name: "preflight", tags: ["preflight"], summary: "read-only host, capacity and adoption checks" },
  { name: "base", tags: ["base", "operator"], summary: "packages, swap, zram, operator account" },
  { name: "security", tags: ["security"], summary: "sshd hardening, firewall, fail2ban" },
  { name: "network", tags: ["tailscale", "mosh", "et"], summary: "tailnet and roaming terminals" },
  { name: "runtime", tags: ["runtime"], summary: "shared toolchain via mise" },
  { name: "developers", tags: ["developers"], summary: "accounts, isolation, resource slices, git identities" },
  { name: "agents", tags: ["agents"], summary: "agent profiles and launchers" },
  { name: "projects", tags: ["projects"], summary: "clones, per-repo identity, dependencies" },
  { name: "rc", tags: ["rc"], summary: "always-on Remote Control servers, one per project" },
  { name: "browser", tags: ["browser"], summary: "headless Chrome and the browser MCP servers" },
  { name: "containers", tags: ["containers"], summary: "rootless engines and the engine map" },
  { name: "memory", tags: ["memory"], summary: "memory daemons, banks and agent wiring" },
  { name: "desktop", tags: ["desktop"], summary: "XFCE/xRDP for developers that asked for one" },
  { name: "bridge", tags: ["bridge"], summary: "the client-box file bridge and app configs" },
  // Opt-in and destructive-by-nature, so it is never part of `apply all`.
  { name: "prune", tags: ["prune"], summary: "remove what devbox.yml no longer declares (asks first)" },
];

export const phaseByName = (name: string): Phase | undefined =>
  PHASES.find((p) => p.name === name);

/** Tags for a phase name, or `null` for "run everything". */
export function tagsFor(phase: string | undefined): string[] | null {
  if (!phase || phase === "all") return null;
  const found = phaseByName(phase);
  if (!found) throw new Error(`unknown phase '${phase}' (have: ${PHASES.map((p) => p.name).join(", ")}, all)`);
  return found.tags;
}

export const describePhases = (): string =>
  PHASES.map((p) => `  ${p.name.padEnd(12)}${p.summary}`).join("\n");
