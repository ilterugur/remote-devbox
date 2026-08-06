# Browser Mode and Port Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a profile-scoped client CLI switch between Devbox-local and client-local browser execution, plus safe project-port forwarding with optional autobind.

**Architecture:** HAProxy remains the stable CDP endpoint. Client mode runs the existing client Chrome reverse tunnel; server mode unloads it so HAProxy selects Devbox Chrome. Each selected project port gets an owned loopback SSH local-forward launchd agent. Browser mode is client-local state and defaults to `client` for compatibility.

**Tech Stack:** Bun, TypeScript, cac, Node filesystem/child-process APIs, macOS launchd, SSH, Ansible/Jinja2.

## Global Constraints

- Keep all listeners loopback-only (`127.0.0.1`).
- `browser.failover.autobind` defaults to `false`.
- Never kill, reuse, or move an unrelated local process owning a requested port.
- Do not rewrite Devbox MCP JSON or URL-route browser traffic.
- Preserve existing client behavior if state/new config fields are absent.
- Use Bun tests and `bun run build`; never `tsc`.

---

### Task 1: Propagate declared project ports and autobind

**Files:**
- Modify: `clients/devbox/src/config.ts`, `clients/devbox/src/config.test.ts`
- Modify: `clients/devbox/src/spec/types.ts`, `clients/devbox/src/spec/normalize.ts`, `clients/devbox/src/spec/normalize.test.ts`, `clients/devbox/src/spec/validate.ts`, `clients/devbox/src/spec/validate.test.ts`
- Modify: `ansible/roles/box_cli/templates/devbox-cli.sh.j2`

**Interfaces:** Produces `Project = { name; repo?; ports: number[] }` and `ProfileBrowserFailover = { cdpPort; clientTunnelPort; autoBind }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("carries declared project ports and failover autobind", () => {
  const p = profilesFromYaml(tmpRepo(`
browser: { failover: { enabled: true, chrome_user: work, autobind: true } }
developers:
  - user: work
    projects: [{ name: app, ports: [5173, 3000] }]
`))![0]!;
  expect(p.projects[0]!.ports).toEqual([5173, 3000]);
  expect(p.browserFailover).toMatchObject({ autoBind: true });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test clients/devbox/src/config.test.ts clients/devbox/src/spec/normalize.test.ts clients/devbox/src/spec/validate.test.ts`

Expected: fails because these fields are not carried.

- [ ] **Step 3: Implement the smallest propagation**

```ts
export type Project = { name: string; repo?: string; ports: number[] };
export type ProfileBrowserFailover = { cdpPort: number; clientTunnelPort: number; autoBind: boolean };
```

Map only positive integer ports; normalize `autobind` to false; validate Boolean; emit both project ports and autobind in generated client JSON.

- [ ] **Step 4: Verify GREEN**

Run: `bun test clients/devbox/src/config.test.ts clients/devbox/src/spec/normalize.test.ts clients/devbox/src/spec/validate.test.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add clients/devbox/src/config.ts clients/devbox/src/config.test.ts clients/devbox/src/spec/types.ts clients/devbox/src/spec/normalize.ts clients/devbox/src/spec/normalize.test.ts clients/devbox/src/spec/validate.ts clients/devbox/src/spec/validate.test.ts ansible/roles/box_cli/templates/devbox-cli.sh.j2
git commit -m "feat: carry browser autobind and project ports to clients"
```

### Task 2: Add browser-mode and binding domain operations

**Files:**
- Modify: `clients/devbox/src/agent.ts`, `clients/devbox/src/agent.test.ts`

**Interfaces:** Produces `BrowserMode`, `readBrowserMode`, `writeBrowserMode`, `browserPortAgent`, `browserPortsFor`, `runBrowserMode`, `runBrowserBind`, `runBrowserUnbind`, and `runBrowserStatus`.

- [ ] **Step 1: Write failing behavior tests**

```ts
test("browser port gets an owned loopback SSH forward", () => {
  const a = browserPortAgent("ilterugur", 5173, "devbox-ilterugur");
  expect(a.label).toBe("com.devbox.ilterugur.browser-port-5173");
  expect(a.argv).toContain("127.0.0.1:5173:127.0.0.1:5173");
});

test("server mode excludes browser agents while missing state defaults client", () => {
  expect(readBrowserMode("ilterugur", missingHome)).toBe("client");
  expect(browserAgentsFor(cfg, "ilterugur", "server")).toEqual([]);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test clients/devbox/src/agent.test.ts`

Expected: fails because the browser-mode/binding symbols do not exist.

- [ ] **Step 3: Implement minimal owned-agent lifecycle**

```ts
export type BrowserMode = "client" | "server";

export function browserPortAgent(profile: string, port: number, host: string): AgentSpec {
  return {
    label: `com.devbox.${profile}.browser-port-${port}`,
    mode: "daemon",
    argv: ["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:127.0.0.1:${port}`, host],
    description: `Devbox port: 127.0.0.1:${port} -> ${host}:127.0.0.1:${port}`,
  };
}
```

Use `browser-mode-<profile>` state and only `browser-port-<port>` labels. Reuse existing checked `launchctl` bootstrap/bootout behavior; do not use `pkill` or broad label removal.

- [ ] **Step 4: Verify GREEN**

Run: `bun test clients/devbox/src/agent.test.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add clients/devbox/src/agent.ts clients/devbox/src/agent.test.ts
git commit -m "feat: add browser mode and port binding agents"
```

### Task 3: Expose browser commands and the client-mode hint

**Files:**
- Modify: `clients/devbox/src/devbox.ts`
- Modify: `clients/devbox/src/agent.test.ts`
- Modify: `docs/connecting.md`

**Interfaces:** Consumes the Task 2 operations and exposes `devbox browser mode|bind|unbind|status` with `-p`, `--all`, and `--port`.

- [ ] **Step 1: Write failing decision tests**

```ts
test("client mode prints the manual bind hint when autobind is disabled", () => {
  expect(browserModeHint(cfgWithAutobind(false), "ilterugur"))
    .toContain("devbox browser bind --all -p ilterugur");
});

test("client mode chooses all declared ports when autobind is enabled", () => {
  expect(browserAutoBindPorts(cfgWithAutobind(true), "ilterugur")).toEqual([3000, 5173]);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test clients/devbox/src/agent.test.ts`

Expected: fails because the mode decision/hint is not implemented.

- [ ] **Step 3: Register the CLI and write operator documentation**

```ts
cli.command("browser [action]", "manage browser execution mode and Devbox port bindings")
  .option("-p, --profile <profile>", "target profile")
  .option("--all", "all declared project ports")
  .option("--port <port>", "one explicit TCP port");
```

Require exactly one binding target: a project, `--all`, or `--port`. Document that server mode makes browser `localhost` Devbox-local, and client mode makes it Mac-local.

- [ ] **Step 4: Verify GREEN**

Run: `bun test clients/devbox/src/agent.test.ts`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add clients/devbox/src/devbox.ts clients/devbox/src/agent.test.ts docs/connecting.md
git commit -m "feat: expose browser mode and port binding commands"
```

### Task 4: Integration verification and rollout handoff

**Files:**
- Modify: `docs/connecting.md` only if verification identifies a missing command.

- [ ] **Step 1: Run focused coverage**

Run: `bun test clients/devbox/src/config.test.ts clients/devbox/src/agent.test.ts clients/devbox/src/spec/normalize.test.ts clients/devbox/src/spec/validate.test.ts`

Expected: exit 0.

- [ ] **Step 2: Build the distributable client**

Run: `bun run build`

Expected: exit 0.

- [ ] **Step 3: Inspect final scope**

Run: `git diff main...HEAD --check && git diff --stat main...HEAD`

Expected: no whitespace errors; only configuration, CLI/agent, generated facts, docs, and tests change.

- [ ] **Step 4: Commit a final documentation correction only if Step 3 requires it**

```bash
git add docs/connecting.md
git commit -m "docs: explain browser execution modes"
```
