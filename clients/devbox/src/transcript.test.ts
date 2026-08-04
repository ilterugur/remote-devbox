import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "./config";
import { applyMappings, backupLocal, buildMappings, rewriteJsonl } from "./transcript";

describe("buildMappings", () => {
  const src = "/Users/alnzy/Documents/Projects/dev-a/claude-devbox";
  const remote = "/home/devbox/projects/claude-devbox";

  test("includes the project root and its dash-encoded variant, longest-first", () => {
    const m = buildMappings(src, remote, {});
    expect(m.some((x) => x.from === src && x.to === remote)).toBe(true);
    expect(m.some((x) => x.from === encodeCwd(src) && x.to === encodeCwd(remote))).toBe(true);
    for (let i = 1; i < m.length; i++) expect(m[i - 1].from.length >= m[i].from.length).toBe(true);
  });

  test("--map entries are honored", () => {
    const m = buildMappings(src, remote, { map: ["/opt/homebrew=/usr/local"] });
    expect(m.some((x) => x.from === "/opt/homebrew" && x.to === "/usr/local")).toBe(true);
  });

  test("home remap (push direction): /Users/<you> -> /home/<profile>", () => {
    const m = buildMappings(src, remote, { homeFrom: src, homeTo: "/home/devbox" });
    const home = m.find((x) => x.from === "/Users/alnzy");
    expect(home?.to).toBe("/home/devbox");
    // project root is longer than the home prefix, so it appears earlier
    expect(m.findIndex((x) => x.from === src)).toBeLessThan(m.findIndex((x) => x.from === "/Users/alnzy"));
  });

  test("home remap (pull direction): /home/<profile> -> /Users/<you>", () => {
    const m = buildMappings(remote, src, { homeFrom: remote, homeTo: "/Users/alnzy" });
    const home = m.find((x) => x.from === "/home/devbox");
    expect(home?.to).toBe("/Users/alnzy");
  });
});

describe("applyMappings / rewriteJsonl", () => {
  const src = "/Users/alnzy/Documents/Projects/dev-a/claude-devbox";
  const remote = "/home/devbox/projects/claude-devbox";

  test("push: rewrites cwd + dash-encoded reference, keeps valid JSON", () => {
    const mappings = buildMappings(src, remote, {});
    const line = JSON.stringify({
      type: "user",
      cwd: src,
      message: { content: `see ~/.claude/projects/${encodeCwd(src)}/x.jsonl` },
    });
    const out = rewriteJsonl(line + "\n", mappings);
    const rec = JSON.parse(out.trim());
    expect(rec.cwd).toBe(remote);
    expect(rec.message.content).toContain(encodeCwd(remote));
    expect(rec.message.content).not.toContain(encodeCwd(src));
  });

  test("pull: the reverse direction rewrites box cwd back to the client cwd", () => {
    const mappings = buildMappings(remote, src, {});
    const line = JSON.stringify({
      type: "user",
      cwd: remote,
      message: { content: `see ~/.claude/projects/${encodeCwd(remote)}/x.jsonl` },
    });
    const rec = JSON.parse(rewriteJsonl(line + "\n", mappings).trim());
    expect(rec.cwd).toBe(src);
    expect(rec.message.content).toContain(encodeCwd(src));
    expect(rec.message.content).not.toContain(encodeCwd(remote));
  });

  test("home remap does not clobber the more specific project-root rewrite", () => {
    const mappings = buildMappings(src, remote, { homeFrom: src, homeTo: "/home/devbox" });
    const text = `${src}/src/x.ts and /Users/alnzy/.claude/hooks/h.sh`;
    expect(applyMappings(text, mappings)).toBe(`${remote}/src/x.ts and /home/devbox/.claude/hooks/h.sh`);
  });

  test("single pass: a later mapping never clobbers an earlier mapping's output", () => {
    const mappings = buildMappings("/Users/alnzy/proj", "/tmp/X-Users-alnzy-Y", {
      homeFrom: "/Users/alnzy/proj",
      homeTo: "/home/work",
    });
    expect(applyMappings("/Users/alnzy/proj/src/file.ts", mappings)).toBe("/tmp/X-Users-alnzy-Y/src/file.ts");
    expect(applyMappings("-Users-alnzy-proj", mappings)).toBe("-tmp-X-Users-alnzy-Y");
  });

  test("longest-prefix wins at a position (overlapping --map prefixes)", () => {
    const mappings = buildMappings("/x", "/y", { map: ["/data=/srv/data", "/srv=/mnt/srv"] });
    expect(applyMappings("/data/a /srv/b", mappings)).toBe("/srv/data/a /mnt/srv/b");
  });

  test("drops blank/partial trailing lines", () => {
    const mappings = buildMappings(src, remote, {});
    const out = rewriteJsonl(`${JSON.stringify({ type: "user", cwd: src })}\n\n`, mappings);
    expect(out.trim().split("\n").length).toBe(1);
  });

  test("throws if a mapping breaks JSON validity", () => {
    const bad = [{ from: "X", to: '"' }];
    expect(() => rewriteJsonl(JSON.stringify({ a: "X" }) + "\n", bad)).toThrow(/invalid JSON/);
  });
});

describe("backupLocal", () => {
  test("backs up an existing transcript + sidecar to .bak-<ts>, no-op when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "devbox-bak-"));
    const file = join(dir, "s.jsonl");
    const sidecar = join(dir, "s");
    writeFileSync(file, "line\n");
    mkdirSync(sidecar);
    writeFileSync(join(sidecar, "agent.jsonl"), "a\n");

    expect(backupLocal(file, sidecar, "TS")).toBe(true);
    expect(existsSync(`${file}.bak-TS`)).toBe(true);
    expect(readFileSync(`${file}.bak-TS`, "utf8")).toBe("line\n");
    expect(existsSync(join(`${sidecar}.bak-TS`, "agent.jsonl"))).toBe(true);

    // nothing to back up
    expect(backupLocal(join(dir, "nope.jsonl"), join(dir, "nope"), "TS2")).toBe(false);
  });
});
