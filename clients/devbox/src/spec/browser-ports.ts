/**
 * browser-ports.ts — which port each browser-enabled developer's MCP server listens on.
 *
 * One server per browser-enabled developer, not one for the box. The server does the
 * session's browser file I/O — an upload reads out of that developer's 0700 home, a
 * screenshot is written back into it — so it has to run as that developer, and a
 * process per account needs a port per account.
 *
 * Ports are handed out from `browser.mcp_port` upward in devbox.yml declaration order,
 * so a developer's port is the same on every run of an unchanged file, and it is
 * assigned here rather than counted out in a template: which port a service binds is a
 * policy decision, and policy lives in the generator.
 */

/** Base of the per-developer MCP range. */
export const DEFAULT_MCP_PORT = 9522;
/** The shared CDP endpoint HAProxy fronts. */
export const DEFAULT_CDP_PORT = 9222;
/** The reverse tunnel to the client's own browser. */
export const DEFAULT_CLIENT_TUNNEL_PORT = 9322;
/** The box-local Chrome the endpoint falls back to. */
export const DEFAULT_FALLBACK_CHROME_PORT = 9422;

export const MAX_PORT = 65535;

/** One developer's MCP server: the account it runs as and the port it listens on. */
export interface McpServer {
  user: string;
  port: number;
}

export function assignMcpPorts(users: string[], basePort: number): McpServer[] {
  return users.map((user, index) => ({ user, port: basePort + index }));
}

/** The accounts that get a server, in declaration order. */
export const browserUsers = (developers: { user: string; browser?: boolean }[]): string[] =>
  developers.filter((dev) => dev.browser).map((dev) => dev.user);
