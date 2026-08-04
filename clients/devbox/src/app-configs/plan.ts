/**
 * plan.ts — the pure decision layer for `devbox config link` / `unlink`.
 *
 * Deciding which side wins is the one genuinely dangerous moment in this feature:
 * linking means one side's content stops being read. That decision lives here, with
 * no filesystem or ssh in sight, so every combination is table-testable.
 */
import type { ResolvedEntry } from "./registry";

export type SideKind = "absent" | "empty" | "content" | "linked" | "foreign-link";
export type SideState = { kind: SideKind; summary: string };
export type Decision = "already-linked" | "seed-empty" | "use-client" | "use-box" | "ask" | "refuse";
export type LinkPlan = { decision: Decision; reason: string };

const hasContent = (s: SideState) => s.kind === "content";
const bare = (s: SideState) => s.kind === "absent" || s.kind === "empty" || s.kind === "linked";

export function planAppConfigLink(
  entry: ResolvedEntry,
  client: SideState,
  box: SideState,
  store: SideKind,
): LinkPlan {
  if (client.kind === "foreign-link" || box.kind === "foreign-link") {
    return { decision: "refuse", reason: `${entry.label}: an existing link points somewhere else — resolve it by hand` };
  }
  if (client.kind === "linked" && box.kind === "linked") {
    return { decision: "already-linked", reason: `${entry.label}: already linked on both sides` };
  }
  // Once the store holds the canonical copy, a bare side just gets linked to it —
  // there is nothing left to choose.
  if (store === "content" && bare(client) && bare(box)) {
    return { decision: "use-client", reason: `${entry.label}: linking to the existing synced copy` };
  }
  if (hasContent(client) && hasContent(box)) {
    return {
      decision: "ask",
      reason: `${entry.label} — client: ${client.summary} · box: ${box.summary}`,
    };
  }
  if (hasContent(client)) return { decision: "use-client", reason: `${entry.label}: only the client has content (${client.summary})` };
  if (hasContent(box)) return { decision: "use-box", reason: `${entry.label}: only the box has content (${box.summary})` };
  return { decision: "seed-empty", reason: `${entry.label}: nothing on either side — creating an empty store` };
}

export function planAppConfigUnlink(entry: ResolvedEntry, side: SideState): { action: "restore" | "skip"; reason: string } {
  if (side.kind === "linked") return { action: "restore", reason: `${entry.label}: restoring real files and removing the link` };
  return { action: "skip", reason: `${entry.label}: not linked — nothing to restore` };
}
