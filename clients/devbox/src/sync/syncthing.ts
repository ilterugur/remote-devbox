/**
 * syncthing.ts — Syncthing-backed SyncEngine. Wires device pairing + the single shared
 * folder via each daemon's REST config API: the client directly (127.0.0.1:<guiPort>),
 * the box through an ephemeral `ssh -L` tunnel to its localhost GUI. Pure parsers and
 * payload builders are exported for tests.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { die, sshHostName } from "../config";
import type { SyncEngine, SyncStatus, SyncUpOpts } from "./engine";

// ── pure parsers ─────────────────────────────────────────────────────────────
export function parseApiKey(xml: string): string {
  const m = /<apikey>([^<]+)<\/apikey>/.exec(xml);
  if (!m) die("no <apikey> in Syncthing config.xml (open the GUI once to generate one)");
  return m[1].trim();
}

export function parseGuiPort(xml: string): number {
  const m = /<gui[^>]*>[\s\S]*?<address>[^<]*:(\d+)<\/address>/.exec(xml);
  return m ? parseInt(m[1], 10) : 8384;
}

// ── pure payload builders ────────────────────────────────────────────────────
export const folderId = (profile: string): string => `devbox-${profile}`;

export function folderPayload(
  defaults: Record<string, any>,
  o: { id: string; label: string; path: string; deviceIds: string[] },
): Record<string, any> {
  return {
    ...defaults,
    id: o.id,
    label: o.label,
    path: o.path,
    type: "sendreceive",
    fsWatcherEnabled: true,
    versioning: { type: "trashcan", params: { cleanoutDays: "30" } },
    devices: o.deviceIds.map((deviceID) => ({ deviceID })),
  };
}

export function devicePayload(deviceID: string, name: string, addresses: string[]): Record<string, any> {
  return { deviceID, name, addresses: addresses.length ? addresses : ["dynamic"] };
}

/**
 * Syncthing stores ignores per folder rather than inside the folder config, so they need
 * their own call — they cannot ride along in folderPayload.
 *
 * The pattern strings are shared with Mutagen unchanged: in both syntaxes a bare name
 * matches at any depth and a leading slash anchors to the folder root, which is what lets
 * one ignore list drive either engine.
 */
export function ignoreRequest(id: string, ignores: string[]): { path: string; body: { ignore: string[] } } {
  return { path: `/rest/db/ignores?folder=${encodeURIComponent(id)}`, body: { ignore: [...ignores] } };
}

// ── REST client + engine ─────────────────────────────────────────────────────
type Endpoint = { base: string; key: string };

async function api(ep: Endpoint, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${ep.base}${path}`, {
    method,
    headers: { "X-API-Key": ep.key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`syncthing ${method} ${path} -> ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const myID = async (ep: Endpoint): Promise<string> => (await api(ep, "GET", "/rest/system/status")).myID;

async function ensureDevice(ep: Endpoint, dev: Record<string, any>): Promise<void> {
  const devices: any[] = await api(ep, "GET", "/rest/config/devices");
  if (devices.some((d) => d.deviceID === dev.deviceID)) return;
  await api(ep, "PUT", `/rest/config/devices/${dev.deviceID}`, dev);
}

async function ensureFolder(ep: Endpoint, id: string, label: string, path: string, deviceIds: string[]): Promise<void> {
  const folders: any[] = await api(ep, "GET", "/rest/config/folders");
  if (folders.some((f) => f.id === id)) return;
  const defaults = await api(ep, "GET", "/rest/config/defaults/folder");
  await api(ep, "PUT", `/rest/config/folders/${id}`, folderPayload(defaults, { id, label, path, deviceIds }));
}

async function setIgnores(ep: Endpoint, id: string, ignores: string[]): Promise<void> {
  const { path, body } = ignoreRequest(id, ignores);
  await api(ep, "POST", path, body);
}

function clientEndpoint(): Endpoint {
  const xml = readFileSync(join(homedir(), "Library", "Application Support", "Syncthing", "config.xml"), "utf8");
  return { base: `http://127.0.0.1:${parseGuiPort(xml)}`, key: parseApiKey(xml) };
}

function boxConfigXml(host: string, profile: string): string {
  const cmd = `cat /home/${profile}/.local/state/syncthing/config.xml 2>/dev/null || cat /home/${profile}/.config/syncthing/config.xml`;
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, cmd], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) die(`could not read box Syncthing config for ${profile}: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

export class SyncthingEngine implements SyncEngine {
  readonly id = "syncthing" as const;

  /** Pair both devices + share the single folder via REST (client direct, box via ssh -L). */
  async up(o: SyncUpOpts): Promise<void> {
    const client = clientEndpoint();
    const boxXml = boxConfigXml(o.host, o.profile);
    const boxPort = parseGuiPort(boxXml);
    const boxKey = parseApiKey(boxXml);

    const lport = 18384;
    const tunnel = spawn("ssh", ["-N", "-L", `127.0.0.1:${lport}:127.0.0.1:${boxPort}`, o.host], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // let the tunnel come up
      const box: Endpoint = { base: `http://127.0.0.1:${lport}`, key: boxKey };

      const clientID = await myID(client);
      const boxID = await myID(box);
      const boxAddr = `tcp://${sshHostName(o.host)}:22000`;

      // pair both directions (client dials out to the box's Tailscale address; box accepts)
      await ensureDevice(client, devicePayload(boxID, `devbox-${o.profile}`, [boxAddr]));
      await ensureDevice(box, devicePayload(clientID, "client", []));

      // share the single folder on both, with both devices
      const id = folderId(o.profile);
      await ensureFolder(client, id, `devbox · ${o.profile}`, o.localRoot, [clientID, boxID]);
      await ensureFolder(box, id, `devbox · ${o.profile}`, o.remoteRoot, [clientID, boxID]);

      // Set on every `up`, not just when the folder is created: ensureFolder leaves an
      // existing folder alone, so a changed ignore set would otherwise never reach a
      // client that already had one — and an app config's excludes (FileZilla's transfer
      // queue, its lock marker) would keep propagating.
      await setIgnores(client, id, o.ignores);
      await setIgnores(box, id, o.ignores);
    } catch (e) {
      die(`syncthing wiring failed: ${(e as Error).message}`);
    } finally {
      try { tunnel.kill(); } catch { /* */ }
    }
  }

  async down(profile: string): Promise<void> {
    const client = clientEndpoint();
    try { await api(client, "DELETE", `/rest/config/folders/${folderId(profile)}`); } catch { /* already gone */ }
  }

  async pause(profile: string): Promise<void> { await this.setPaused(profile, true); }
  async resume(profile: string): Promise<void> { await this.setPaused(profile, false); }

  private async setPaused(profile: string, paused: boolean): Promise<void> {
    const client = clientEndpoint();
    try { await api(client, "PATCH", `/rest/config/folders/${folderId(profile)}`, { paused }); } catch { /* */ }
  }

  async status(): Promise<SyncStatus[]> {
    let ep: Endpoint;
    try { ep = clientEndpoint(); } catch { return []; }
    try {
      const folders: any[] = await api(ep, "GET", "/rest/config/folders");
      return folders
        .filter((f) => f.id.startsWith("devbox-"))
        .map((f) => ({ name: f.id, state: f.paused ? "paused" : "active", conflicts: 0 }));
    } catch {
      return [];
    }
  }
}
