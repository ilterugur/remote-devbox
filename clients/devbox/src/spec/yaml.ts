/**
 * yaml.ts — a tiny, deterministic YAML emitter for the generated Ansible vars.
 *
 * Bun.YAML.stringify exists, but its formatting is not part of Bun's API contract and
 * this output is diffed by humans on every `devbox plan`. The value space here is small
 * (string | number | boolean | null | array | plain object), so a short emitter buys
 * stable output plus a round-trip test against Bun.YAML.parse.
 *
 * `undefined` entries are dropped: a normalized spec should never contain them, and
 * emitting `key: undefined` would produce a string, not a null.
 */
const PLAIN_RE = /^[A-Za-z0-9_@./+-]+$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

type Scalar = string | number | boolean | null;

const isScalar = (v: unknown): v is Scalar => v === null || typeof v !== "object";

function scalar(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const quote =
    v === "" || !PLAIN_RE.test(v) || RESERVED.has(v.toLowerCase()) || !Number.isNaN(Number(v));
  return quote ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

function emitEntries(obj: Record<string, unknown>, pad: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isScalar(value)) {
      lines.push(`${pad}${key}: ${scalar(value)}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${pad}${key}: []`);
      else {
        lines.push(`${pad}${key}:`);
        lines.push(...emitList(value, `${pad}  `));
      }
    } else {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((k) => record[k] !== undefined);
      if (keys.length === 0) lines.push(`${pad}${key}: {}`);
      else {
        lines.push(`${pad}${key}:`);
        lines.push(...emitEntries(record, `${pad}  `));
      }
    }
  }
  return lines;
}

function emitList(arr: unknown[], pad: string): string[] {
  const lines: string[] = [];
  for (const item of arr) {
    if (isScalar(item)) {
      lines.push(`${pad}- ${scalar(item)}`);
    } else if (Array.isArray(item)) {
      if (item.length === 0) lines.push(`${pad}- []`);
      else {
        lines.push(`${pad}-`);
        lines.push(...emitList(item, `${pad}  `));
      }
    } else {
      const record = item as Record<string, unknown>;
      const sub = emitEntries(record, `${pad}  `);
      if (sub.length === 0) lines.push(`${pad}- {}`);
      else {
        // Hoist the map's first key onto the dash line: "- user: dev-a".
        sub[0] = `${pad}- ${sub[0]!.slice(pad.length + 2)}`;
        lines.push(...sub);
      }
    }
  }
  return lines;
}

/** Emit a YAML document body (no leading `---`), newline-terminated. */
export function toYaml(value: unknown): string {
  const lines = isScalar(value)
    ? [scalar(value)]
    : Array.isArray(value)
      ? emitList(value, "")
      : emitEntries(value as Record<string, unknown>, "");
  return lines.length ? `${lines.join("\n")}\n` : "";
}
