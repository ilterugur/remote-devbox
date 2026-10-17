import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const COMMAND_BOUNDARY = /(^|(?:&&|\|\||[;|\n])\s*)((?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)*)(?:\/[^\s;&|]+\/)(bunx?|node|npm|npx|pnpm|yarn|tsc|turbo|next|prisma|cargo)(?=\s|$)/gu;

/**
 * OMP's native shell normally resolves these commands through PATH and therefore the
 * devbox gate. An explicit mise/toolchain path bypasses PATH entirely. Strip only the
 * directory of an executable in command position; arguments and non-toolchain paths are
 * untouched, and the gate still decides whether the resulting invocation is heavy.
 */
export function routeToolchainExecutablesThroughGate(command: string): string {
  return command.replace(COMMAND_BOUNDARY, (_match, boundary: string, assignments: string, executable: string) =>
    `${boundary}${assignments}${executable}`,
  );
}

export default function ompHeavyGate(pi: ExtensionAPI): void {
  pi.on("tool_call", event => {
    if (event.toolName !== "bash" || !process.env.DEVBOX_HEAVY_JOB_CATEGORIES) return;
    const command = event.input.command;
    if (typeof command !== "string") return;
    const routed = routeToolchainExecutablesThroughGate(command);
    if (routed === command) return;
    return { input: { ...event.input, command: routed } };
  });
}
