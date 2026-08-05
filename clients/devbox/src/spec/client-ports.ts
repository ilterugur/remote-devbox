/**
 * client-ports.ts — which local port a client's RDP entry dials for each developer.
 *
 * The box always listens on 3389; this is the CLIENT side of the always-on tunnel, so
 * two developers driven from one machine need two ports. Explicit values in devbox.yml
 * are honoured exactly — a saved RDP entry must never move on its own — and the rest are
 * handed the lowest free port at or above 3389, in devbox.yml order.
 */
export const DEFAULT_CLIENT_PORT = 3389;

export type ClientPortInput = { user: string; desktopEnabled: boolean; clientPort?: number };

export function assignClientPorts(devs: ClientPortInput[]): Map<string, number> {
  const out = new Map<string, number>();
  const desktops = devs.filter((d) => d.desktopEnabled);
  const taken = new Set<number>(desktops.flatMap((d) => (d.clientPort ? [d.clientPort] : [])));
  let next = DEFAULT_CLIENT_PORT;
  for (const d of desktops) {
    if (d.clientPort) {
      out.set(d.user, d.clientPort);
      continue;
    }
    while (taken.has(next)) next++;
    taken.add(next);
    out.set(d.user, next);
  }
  return out;
}
