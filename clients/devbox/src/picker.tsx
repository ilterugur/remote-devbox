import { MouseProvider, useMouse, useOnMouseClick } from "@zenobius/ink-mouse";
import { Box, type DOMElement, render, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";

export type PickResult = string | "__home__" | "__new__" | null;
export type PickProfile = { user: string; projects: string[] };

const CLAY = "#d77757"; // clawd's body orange (rgb 215,119,87) — Claude Code's accent
const MAX_ROWS = 12;
const ACTIONS = [
  { value: "__home__" as const, label: "open in HOME" },
  { value: "__new__" as const, label: "new project" },
];

/** ink-mouse registers one click listener per clickable <Row> on a single shared
 *  EventEmitter. With more than ~10 rows that trips Node's default max-listeners cap
 *  and floods the terminal with MaxListenersExceededWarning. Lift the cap once from
 *  inside the provider (so we have the emitter in context) — clicks are bounded by
 *  the visible rows, not a genuine leak. Renders nothing. */
function LiftListenerCap() {
  const { events } = useMouse();
  useEffect(() => {
    // `emitter` is a private field of ink-mouse's TypedEventEmitter — reach through it.
    (events as unknown as { emitter?: { setMaxListeners?: (n: number) => void } })?.emitter?.setMaxListeners?.(0);
  }, [events]);
  return null;
}

/** Subsequence fuzzy match (e.g. "isc" matches "example-app"). */
function fuzzy(label: string, query: string): boolean {
  const s = label.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

/** clawd — Claude Code's own mascot, block art straight from the CLI, lightly animated:
 *  mostly idle, with the odd glance left/right and an arms-up wave. Drawn in clawd's
 *  orange with NO background fill, so it blends into a dark terminal (a fill shows up as
 *  a grey box on themes that map ANSI "black" to grey). Every pose is 9 cells × 3 rows
 *  so nothing jitters between frames. */
const POSES: Record<string, [string, string, string]> = {
  idle: [" ▐▛███▜▌ ", "▝▜█████▛▘", "  ▘▘ ▝▝  "],
  left: [" ▐▟███▟▌ ", "▝▜█████▛▘", "  ▘▘ ▝▝  "],
  right: [" ▐▙███▙▌ ", "▝▜█████▛▘", "  ▘▘ ▝▝  "],
  wave: ["▗▟▛███▜▙▖", " ▜█████▛ ", "  ▘▘ ▝▝  "],
};
// Frame timeline (one entry per tick): mostly idle, with occasional motion.
const FRAMES = ["idle", "idle", "idle", "idle", "idle", "left", "idle", "idle", "right", "idle", "idle", "idle", "idle", "wave", "idle", "idle"];

function Mascot() {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF((n) => (n + 1) % FRAMES.length), 450);
    return () => clearInterval(t);
  }, []);
  return (
    <Box flexDirection="column" marginRight={2}>
      {POSES[FRAMES[f]].map((line, i) => (
        <Text key={i} color={CLAY}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** Ink's useInput also receives raw mouse-report bytes (ink-mouse parses them for
 *  hover/click, but Ink still hands the same data to useInput). Detect those so they
 *  never land in the filter — SGR mouse: ESC[<b;x;y(M|m); legacy X10: ESC[M… */
function looksLikeMouse(s: string): boolean {
  return s.includes("\x1b") || s.includes("[<") || s.includes("[M") || /<?\d+;\d+;\d+[Mm]/.test(s);
}

/** A clickable row — click via ink-mouse; the selection highlight is keyboard-driven
 *  (arrows). Hover/mouse-motion was dropped on purpose: Warp doesn't deliver motion
 *  events reliably, and click + keyboard cover everything. Each row is its own component
 *  so the click hook stays stable across filtering (rules of hooks). */
function Row({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const ref = useRef<DOMElement>(null) as React.RefObject<DOMElement>;
  useOnMouseClick(ref, (c) => c && onClick());
  return (
    <Box ref={ref}>
      <Text color={active ? CLAY : undefined} bold={active}>
        {active ? "❯ " : "  "}
        {label}
      </Text>
    </Box>
  );
}

function Picker({
  profiles,
  active,
  onDone,
}: {
  profiles: PickProfile[];
  active: string;
  onDone: (profile: string, r: PickResult) => void;
}) {
  const start = Math.max(0, profiles.findIndex((p) => p.user === active));
  const [pIdx, setPIdx] = useState(start);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<0 | 1>(0); // 0 = projects, 1 = actions
  const [row, setRow] = useState(0);
  const [aRow, setARow] = useState(0);

  const profile = profiles[pIdx]?.user ?? active;
  const projects = profiles[pIdx]?.projects ?? [];
  const filtered = query ? projects.filter((p) => fuzzy(p, query)) : projects;
  const sel = Math.max(0, Math.min(row, filtered.length - 1));

  const cycleProfile = () => {
    if (profiles.length < 2) return;
    setPIdx((i) => (i + 1) % profiles.length);
    setQuery("");
    setRow(0);
    setPane(0);
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return onDone(profile, null);
    if (key.ctrl && input === "p") return cycleProfile();
    if (key.tab || key.leftArrow || key.rightArrow) return setPane((p) => (p === 0 ? 1 : 0));
    if (key.upArrow) return pane === 0 ? setRow(Math.max(0, sel - 1)) : setARow((i) => Math.max(0, i - 1));
    if (key.downArrow)
      return pane === 0 ? setRow(Math.min(filtered.length - 1, sel + 1)) : setARow((i) => Math.min(ACTIONS.length - 1, i + 1));
    if (key.return) {
      if (pane === 1) return onDone(profile, ACTIONS[aRow].value);
      if (filtered[sel]) return onDone(profile, filtered[sel]);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setRow(0);
      setPane(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab && !looksLikeMouse(input)) {
      setQuery((q) => q + input);
      setRow(0);
      setPane(0);
    }
  });

  const profRef = useRef<DOMElement>(null) as React.RefObject<DOMElement>;
  useOnMouseClick(profRef, (c) => c && cycleProfile());
  const shown = filtered.slice(0, MAX_ROWS);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Mascot />
        <Box flexDirection="column">
          <Text>
            <Text bold color={CLAY}>
              devbox
            </Text>
            <Text dimColor>{"  ·  remote dev"}</Text>
          </Text>
          <Box ref={profRef}>
            <Text dimColor>profile </Text>
            <Text color={CLAY}>{profile}</Text>
            {profiles.length > 1 && <Text dimColor>{`  (${pIdx + 1}/${profiles.length} · click or ⌃p)`}</Text>}
          </Box>
        </Box>
      </Box>

      <Box>
        <Box flexDirection="column" width="60%" borderStyle="round" borderColor={pane === 0 ? CLAY : "gray"} paddingX={1}>
          <Text dimColor>
            projects{"  "}
            {query ? <Text color={CLAY}>/{query}</Text> : <Text dimColor>type to filter</Text>}
          </Text>
          {shown.length === 0 ? (
            <Text dimColor>{"  — no match —"}</Text>
          ) : (
            shown.map((p, i) => (
              <Row key={p} label={p} active={pane === 0 && i === sel} onClick={() => onDone(profile, p)} />
            ))
          )}
          {filtered.length > MAX_ROWS && <Text dimColor>{`  …${filtered.length - MAX_ROWS} more`}</Text>}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor={pane === 1 ? CLAY : "gray"} paddingX={1} marginLeft={1}>
          <Text dimColor>actions</Text>
          {ACTIONS.map((a, i) => (
            <Row key={a.value} label={a.label} active={pane === 1 && i === aRow} onClick={() => onDone(profile, a.value)} />
          ))}
        </Box>
      </Box>

      <Box paddingX={1}>
        <Text dimColor>
          {"↑↓ move · ⇄ tab · ↵/click open"}
          {profiles.length > 1 ? " · ⌃p profile" : ""}
          {" · esc quit"}
        </Text>
      </Box>
    </Box>
  );
}

/** Two-pane, mouse-clickable picker. Resolves with the (possibly switched) profile + choice. */
export function pickUI(profiles: PickProfile[], active: string): Promise<{ profile: string; result: PickResult }> {
  return new Promise((resolve) => {
    const app = render(
      <MouseProvider>
        <LiftListenerCap />
        <Picker
          profiles={profiles}
          active={active}
          onDone={(profile, result) => {
            app.unmount();
            resolve({ profile, result });
          }}
        />
      </MouseProvider>,
    );
  });
}

// ── session picker (devbox push --pick) ──────────────────────────────────────

export type SessionPick = { id: string; mtime: number; firstPrompt: string };

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function SessionPicker({
  sessions,
  onDone,
  title = "devbox push",
}: {
  sessions: SessionPick[];
  onDone: (s: SessionPick | null) => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [row, setRow] = useState(0);
  const filtered = query ? sessions.filter((s) => fuzzy(`${s.firstPrompt} ${s.id}`, query)) : sessions;
  const sel = Math.max(0, Math.min(row, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return onDone(null);
    if (key.upArrow) return setRow(Math.max(0, sel - 1));
    if (key.downArrow) return setRow(Math.min(filtered.length - 1, sel + 1));
    if (key.return) return void (filtered[sel] && onDone(filtered[sel]));
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setRow(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab && !looksLikeMouse(input)) {
      setQuery((q) => q + input);
      setRow(0);
    }
  });

  const shown = filtered.slice(0, MAX_ROWS);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Mascot />
        <Box flexDirection="column">
          <Text>
            <Text bold color={CLAY}>
              {title}
            </Text>
            <Text dimColor>{"  ·  pick a session"}</Text>
          </Text>
          <Text dimColor>{query ? <Text color={CLAY}>/{query}</Text> : "type to filter"}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={CLAY} paddingX={1}>
        {shown.length === 0 ? (
          <Text dimColor>{"  — no match —"}</Text>
        ) : (
          shown.map((s, i) => (
            <Row
              key={s.id}
              label={`${relTime(s.mtime).padEnd(7)}  ${truncate(s.firstPrompt || s.id, 56)}`}
              active={i === sel}
              onClick={() => onDone(s)}
            />
          ))
        )}
        {filtered.length > MAX_ROWS && <Text dimColor>{`  …${filtered.length - MAX_ROWS} more`}</Text>}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{"↑↓ move · ↵/click open · esc quit"}</Text>
      </Box>
    </Box>
  );
}

/** Single-pane fuzzy picker over recent sessions. Resolves the chosen session, or null. */
export function pickSessionUI(sessions: SessionPick[], title?: string): Promise<SessionPick | null> {
  return new Promise((resolve) => {
    const app = render(
      <MouseProvider>
        <LiftListenerCap />
        <SessionPicker
          sessions={sessions}
          title={title}
          onDone={(s) => {
            app.unmount();
            resolve(s);
          }}
        />
      </MouseProvider>,
    );
  });
}
