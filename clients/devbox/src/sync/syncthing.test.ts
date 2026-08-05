import { describe, expect, test } from "bun:test";
import { parseApiKey, parseGuiPort, folderPayload, devicePayload, folderId, ignoreRequest } from "./syncthing";

const xml = `<configuration version="37">
  <gui enabled="true" tls="false">
    <address>127.0.0.1:8385</address>
    <apikey>ABCdef123456</apikey>
  </gui>
</configuration>`;

describe("config.xml parsers", () => {
  test("parseApiKey extracts the GUI api key", () => {
    expect(parseApiKey(xml)).toBe("ABCdef123456");
  });
  test("parseGuiPort extracts the GUI port", () => {
    expect(parseGuiPort(xml)).toBe(8385);
  });
  test("missing apikey throws", () => {
    expect(() => parseApiKey("<configuration></configuration>")).toThrow(/no <apikey>/);
  });
});

describe("REST payload builders", () => {
  test("folderId is stable per profile", () => {
    expect(folderId("work")).toBe("devbox-work");
  });
  test("folderPayload merges defaults, sets sendreceive + trashcan + both devices", () => {
    const defaults = { id: "", label: "", path: "", type: "sendreceive", rescanIntervalS: 3600, fsWatcherEnabled: true, devices: [] as any[], versioning: {} as any };
    const f = folderPayload(defaults, { id: "devbox-work", label: "devbox · work", path: "/home/work/sync", deviceIds: ["AAA", "BBB"] });
    expect(f.id).toBe("devbox-work");
    expect(f.path).toBe("/home/work/sync");
    expect(f.type).toBe("sendreceive");
    expect(f.versioning).toEqual({ type: "trashcan", params: { cleanoutDays: "30" } });
    expect(f.devices.map((d: any) => d.deviceID).sort()).toEqual(["AAA", "BBB"]);
    expect(f.fsWatcherEnabled).toBe(true);
  });
  test("devicePayload pins addresses (Tailscale) or dynamic", () => {
    expect(devicePayload("BBB", "box", ["tcp://100.1.2.3:22000"]).addresses).toEqual(["tcp://100.1.2.3:22000"]);
    expect(devicePayload("AAA", "client", []).addresses).toEqual(["dynamic"]);
  });
});

describe("ignoreRequest", () => {
  test("targets the folder's ignore list and sends the patterns verbatim", () => {
    // Syncthing keeps ignores per folder, not inside the folder config object, so they
    // cannot ride along in folderPayload.
    const r = ignoreRequest("devbox-work", ["node_modules", "/.app-configs/filezilla/queue.sqlite3"]);
    expect(r.path).toBe("/rest/db/ignores?folder=devbox-work");
    expect(r.body).toEqual({ ignore: ["node_modules", "/.app-configs/filezilla/queue.sqlite3"] });
  });

  test("a folder id needing escaping does not break the query", () => {
    expect(ignoreRequest("devbox-a b", []).path).toBe("/rest/db/ignores?folder=devbox-a%20b");
  });

  test("the patterns the engines share mean the same thing to Syncthing", () => {
    // A bare name matches at any depth and a leading slash anchors to the folder root in
    // both engines' syntax, which is what lets one ignore list drive either of them.
    const { body } = ignoreRequest("devbox-work", ["*.swp", "/.app-configs/filezilla/lockfile"]);
    expect(body.ignore[0]!.startsWith("/")).toBe(false);
    expect(body.ignore[1]!.startsWith("/")).toBe(true);
  });
});
