/**
 * issues.ts — the diagnostic model shared by every spec stage.
 *
 * Validation never throws and never exits: each stage returns the issues it found so
 * `devbox plan` can report ALL problems in one pass. Errors block an apply; warnings
 * don't. `path` is a dotted/bracketed pointer into devbox.yml so the message is
 * actionable without reading the code.
 */
export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  path: string;
  message: string;
}

export const err = (path: string, message: string): Issue => ({ severity: "error", path, message });
export const warn = (path: string, message: string): Issue => ({ severity: "warning", path, message });

export const hasErrors = (issues: Issue[]): boolean => issues.some((i) => i.severity === "error");

/** Errors first, then warnings; original order preserved within each group. */
export function formatIssues(issues: Issue[]): string {
  const line = (i: Issue) => `${i.severity === "error" ? "ERROR " : "warn  "} ${i.path}: ${i.message}`;
  return [
    ...issues.filter((i) => i.severity === "error"),
    ...issues.filter((i) => i.severity === "warning"),
  ]
    .map(line)
    .join("\n");
}
