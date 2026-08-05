/**
 * agent.ts — `devbox agent`: the long-lived pieces of the client, described once and
 * handed to launchd.
 *
 * Two shapes cover what we need. A "daemon" is a process that should simply always be
 * running (the desktop tunnel: KeepAlive restarts it when the network drops it). An
 * "interval" is a reconciler that should run again every so often (the mount bridge:
 * `devbox mount up` is idempotent, so re-running it is how a mount survives sleep/wake).
 *
 * Rendering is pure and tested; runAgentUp/Down/Status do the fs and launchctl work.
 * Honors DEVBOX_DRYRUN=1 (print, don't execute).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { hostFor, lazyMountsFor, type Config } from "./config";

export type AgentMode = "daemon" | "interval";

export type AgentSpec = {
  label: string;
  mode: AgentMode;
  argv: string[];
  intervalSeconds?: number;
  description: string;
};

/** The box always listens here; only the client side of the forward is configurable. */
const BOX_RDP_PORT = 3389;

export function agentsFor(cfg: Config, profile: string): AgentSpec[] {
  const p = cfg.profiles.find((x) => x.user === profile);
  if (!p) return [];
  const host = hostFor(cfg, profile);
  const out: AgentSpec[] = [];

  if (p.desktop?.clientPort) {
    const port = p.desktop.clientPort;
    out.push({
      label: `com.devbox.${profile}.desktop`,
      mode: "daemon",
      description: `RDP desktop: 127.0.0.1:${port} -> ${host}:${BOX_RDP_PORT}`,
      argv: [
        "ssh", "-N",
        // Without this a forward that cannot bind leaves a live, useless ssh — launchd
        // would see a healthy process and never restart it.
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-L", `127.0.0.1:${port}:127.0.0.1:${BOX_RDP_PORT}`,
        host,
      ],
    });
  }

  if (lazyMountsFor(cfg, profile).length) {
    out.push({
      label: `com.devbox.${profile}.mount`,
      mode: "interval",
      intervalSeconds: 60,
      description: "lazy mounts: re-establish after sleep, wake or a dropped link",
      argv: ["devbox", "mount", "up"],
    });
  }

  return out;
}

export const plistPath = (label: string, home: string = homedir()): string =>
  join(home, "Library", "LaunchAgents", `${label}.plist`);

export const logDirFor = (home: string = homedir()): string =>
  join(home, ".local", "state", "devbox");

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist(spec: AgentSpec, logDir: string): string {
  const args = spec.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const cadence =
    spec.mode === "daemon"
      ? "  <key>KeepAlive</key>\n  <true/>\n  <key>RunAtLoad</key>\n  <true/>"
      : `  <key>StartInterval</key>\n  <integer>${spec.intervalSeconds ?? 60}</integer>\n  <key>RunAtLoad</key>\n  <true/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${cadence}
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, `${spec.label}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, `${spec.label}.log`))}</string>
</dict>
</plist>
`;
}
