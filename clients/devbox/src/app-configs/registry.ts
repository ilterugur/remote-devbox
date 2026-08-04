/**
 * registry.ts — the known application configs and how each one is linked.
 *
 * A `paths` entry is either a registry key (string) or a full definition (object).
 * Resolution happens once, at generate time on the client, so the Ansible role and
 * the CLI both consume identical, fully-resolved entries.
 */

export type LinkMode = "dir" | "file" | "ssh-include";

export type ResolvedEntry = {
  label: string;
  /** macOS path the application actually reads. */
  client: string;
  /** Linux path on the box. */
  box: string;
  mode: LinkMode;
  /** Names never carried into the sync disk (machine-local or sync-hostile). */
  excludes: string[];
};

export const MODES: LinkMode[] = ["dir", "file", "ssh-include"];

export const REGISTRY: Record<string, Omit<ResolvedEntry, "label">> = {
  filezilla: {
    client: "~/.config/filezilla",
    box: "~/.config/filezilla",
    mode: "dir",
    // queue.sqlite3 is the machine-local transfer queue; two-way syncing SQLite corrupts it.
    excludes: ["queue.sqlite3", "*.lock"],
  },
  ssh_config: {
    client: "~/.ssh/config",
    box: "~/.ssh/config",
    // No symlink: an Include line inside a managed block. Keys, authorized_keys and
    // known_hosts are never touched.
    mode: "ssh-include",
    excludes: [],
  },
};

export const STORE_ROOT = ".app-configs";

export function resolveEntry(raw: string | Record<string, unknown>): { entry: ResolvedEntry } | { error: string } {
  const known = Object.keys(REGISTRY).join(", ");
  if (typeof raw === "string") {
    const hit = REGISTRY[raw];
    if (!hit) return { error: `unknown app config "${raw}" — known: ${known}` };
    return { entry: { label: raw, ...hit, excludes: [...hit.excludes] } };
  }
  const label = typeof raw.label === "string" ? raw.label : "";
  if (!label) return { error: "an app config entry needs a label" };
  for (const field of ["client", "box", "mode"] as const) {
    if (typeof raw[field] !== "string") return { error: `app config "${label}" is missing ${field}` };
  }
  const mode = String(raw.mode) as LinkMode;
  if (!MODES.includes(mode)) return { error: `app config "${label}" has mode "${mode}" — must be one of: ${MODES.join(", ")}` };
  const excludes = Array.isArray(raw.excludes) ? raw.excludes.map(String) : [];
  return { entry: { label, client: String(raw.client), box: String(raw.box), mode, excludes } };
}

/** Where the real files live inside the sync disk, relative to its root. */
export const storeRelPath = (e: ResolvedEntry): string => `${STORE_ROOT}/${e.label}`;

/** For file-shaped modes, the single file inside the store. */
export function payloadRelPath(e: ResolvedEntry): string {
  const base = e.mode === "ssh-include" ? "config" : e.client.split("/").pop() || e.label;
  return `${storeRelPath(e)}/${base}`;
}
