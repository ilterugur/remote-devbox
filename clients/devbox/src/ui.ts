/**
 * ui.ts — `devbox ui`: reach a box service over the SSH connection you already have.
 *
 * The box's web UIs (an agent dashboard, a memory control plane, the desktop's RDP port)
 * listen on loopback. That is the point: a loopback service has no door of its own, so
 * the SSH key that got you onto the box is the only credential involved, and a service
 * that never learned to authenticate is not a hole. `ssh -L` is how you get to it.
 *
 * Which ports exist is discovered, not configured — the box is asked what is listening
 * right now. A list in devbox.yml would be one more thing to keep true, and it would be
 * wrong in exactly the case that matters: a service that moved, or died.
 *
 * Pure builders are exported for tests; runUi orchestrates. Honors DEVBOX_DRYRUN=1.
 */
import { spawn, spawnSync } from "node:child_process";
import { die, hostFor, type Config } from "./config";

export interface BoxListener {
  /** The address it listens on: loopback, or something wider. */
  addr: string;
  port: number;
  /** The process, when the box let us see it — only our own processes are visible. */
  proc: string | null;
  loopback: boolean;
}

/**
 * Ports this project itself creates, where the process name is either invisible (xrdp
 * runs as root) or says nothing. Anything else is named by its process.
 */
const KNOWN_PORTS: Record<number, string> = { 3389: "desktop" };

/** Connecting to the box already uses these; a tunnel to one is a tunnel to nowhere. */
const NOT_TUNNELABLE = new Set([22, 53, 2022]);

const LOOPBACK = /^(127\.|\[::1\]|\[::ffff:127\.)/;

export function parseListeners(ssOutput: string): BoxListener[] {
  const out: BoxListener[] = [];
  for (const line of ssOutput.split("\n")) {
    const f = line.trim().split(/\s+/);
    // state recv-q send-q local peer [users:...]
    if (f.length < 5 || f[0] !== "LISTEN") continue;
    const local = f[3]!;
    const colon = local.lastIndexOf(":");
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port) || NOT_TUNNELABLE.has(port)) continue;
    const addr = local.slice(0, colon);
    // `ss` truncates the process name to a fixed width, so a long one arrives mangled
    // mid-word — "next-server (v1". Everything from the first space on is that damage.
    const proc = /users:\(\("([^"]+)"/.exec(line)?.[1]?.split(" ")[0] || null;
    const loopback = LOOPBACK.test(addr);
    // Everything else on the box belongs to somebody else — hidepid hides the process and
    // a tunnel to it would be a tunnel into another developer's work.
    if (!loopback && !proc) continue;
    out.push({ addr, port, proc, loopback });
  }
  // One entry per port. A service listening on both IPv4 and IPv6 loopback is one service,
  // and TCP cannot give two of them the same port anyway — so a second row is noise that
  // makes `devbox ui postgres` look ambiguous when it is not. Loopback wins the tie,
  // because that is the address the tunnel will actually connect to.
  const byPort = new Map<number, BoxListener>();
  for (const l of out) {
    const seen = byPort.get(l.port);
    if (!seen || (l.loopback && !seen.loopback)) byPort.set(l.port, l);
  }
  // Loopback first (the ones that genuinely need a tunnel), then by port so the order is
  // stable between runs rather than however `ss` happened to walk its table.
  return [...byPort.values()].sort((a, b) => Number(b.loopback) - Number(a.loopback) || a.port - b.port);
}

export const listenerName = (l: BoxListener): string =>
  KNOWN_PORTS[l.port] ?? l.proc ?? `port-${l.port}`;

export type Match = { listener: BoxListener } | { error: string };

/** Match by service name or by port. An ambiguous name is an error, never a guess. */
export function matchListener(list: BoxListener[], query: string): Match {
  const asPort = Number(query);
  if (Number.isInteger(asPort) && asPort > 0) {
    const byPort = list.filter((l) => l.port === asPort);
    if (byPort.length === 1) return { listener: byPort[0]! };
    return { error: `nothing is listening on port ${asPort}` };
  }
  const hits = list.filter((l) => listenerName(l) === query);
  if (hits.length === 1) return { listener: hits[0]! };
  if (hits.length > 1) {
    return { error: `'${query}' matches ports ${hits.map((l) => l.port).join(", ")} — name one` };
  }
  const near = list.filter((l) => listenerName(l).includes(query));
  if (near.length === 1) return { listener: near[0]! };
  return { error: `no service called '${query}'${near.length ? ` (did you mean ${near.map(listenerName).join(", ")}?)` : ""}` };
}

export const buildTunnelArgs = (host: string, localPort: number, remotePort: number): string[] => [
  "-N",
  "-L",
  `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
  host,
];

export function renderListeners(list: BoxListener[]): string {
  if (!list.length) return "nothing is listening that you could tunnel to";
  const width = Math.max(...list.map((l) => listenerName(l).length));
  return list
    .map((l) => {
      const where = l.loopback ? "loopback" : `${l.addr} (reachable without a tunnel)`;
      return `  ${listenerName(l).padEnd(width)}  ${String(l.port).padEnd(5)}  ${where}`;
    })
    .join("\n");
}

export function boxListeners(host: string): BoxListener[] {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, "ss -Hltnp 2>/dev/null"], { encoding: "utf8" });
  if (r.status !== 0) die(`could not ask ${host} what is listening: ${(r.stderr || "").trim()}`);
  return parseListeners(r.stdout ?? "");
}

export function runUi(
  cfg: Config,
  profile: string,
  query: string | undefined,
  opts: { port?: number; open?: boolean } = {},
): void {
  const host = hostFor(cfg, profile);
  const list = boxListeners(host);

  if (!query) {
    console.log(`services on ${host}:\n`);
    console.log(renderListeners(list));
    if (list.length) console.log(`\nopen one with:  devbox ui <name|port>`);
    return;
  }

  const m = matchListener(list, query);
  if ("error" in m) die(`${m.error}\n\n${renderListeners(list)}`);

  const remote = m.listener.port;
  const local = opts.port ?? remote;
  const args = buildTunnelArgs(host, local, remote);

  if (process.env.DEVBOX_DRYRUN) return void process.stdout.write(JSON.stringify(["ssh", ...args]) + "\n");

  const url = `http://127.0.0.1:${local}`;
  console.log(`${listenerName(m.listener)} → ${url}   (box port ${remote}, Ctrl-C to close)`);
  // The desktop speaks RDP, not HTTP: printing a URL for it would be a lie, and handing
  // it to a browser worse than useless.
  const web = listenerName(m.listener) !== "desktop";
  if (!web) console.log(`point your RDP client at 127.0.0.1:${local}`);

  const child = spawn("ssh", args, { stdio: "inherit" });
  if (web && opts.open !== false) {
    // After the tunnel exists, not before: a browser that arrives first sees a refused
    // connection and caches the failure.
    setTimeout(() => {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawnSync(opener, [url], { stdio: "ignore" });
    }, 700);
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}
