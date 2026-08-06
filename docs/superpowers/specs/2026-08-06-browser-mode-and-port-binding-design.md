# Browser Mode and Project Port Binding Design

## Goal

Let the owner of `browser.failover` switch the Devbox browser endpoint between
the Devbox-local browser and the client-local browser without changing the MCP
configuration, and make selected Devbox development ports reachable on the
client when client mode is deliberately enabled.

## Context

The failover endpoint at `127.0.0.1:9222` is a TCP proxy.  It cannot reliably
inspect or reroute individual page navigations after an MCP client attaches.
Therefore URL-based routing is intentionally out of scope.  `localhost` is
resolved by whichever Chrome currently backs that endpoint:

- client mode: the isolated Chrome running on the developer's Mac, reached by
  its reverse SSH tunnel; `localhost` is the Mac;
- server mode: the Devbox fallback Chrome at `127.0.0.1:9422`; `localhost` is
  the Devbox.

Stopping only the client browser supervisor makes HAProxy select its existing
fallback, so a mode change is immediate for new CDP clients and does not
rewrite the Devbox user's MCP configuration or interrupt unrelated desktop,
mount, or sync agents.

## Command surface

The client CLI receives a `browser` command, restricted to the profile that
owns `browser.failover`:

```text
devbox browser mode [server|client|status] [-p <profile>]
devbox browser bind [<project>] [--all] [--port <port>] [-p <profile>]
devbox browser unbind [<project>] [--all] [--port <port>] [-p <profile>]
devbox browser status [-p <profile>]
```

`mode server` writes local mode state and unloads only
`com.devbox.<profile>.browser` and the owned browser-port agents.  The Devbox
CDP endpoint consequently falls back to the Devbox Chrome.

`mode client` writes local mode state, installs/starts the isolated browser
supervisor, and prints a concrete `devbox browser bind --all` hint when
autobind is disabled.  When autobind is enabled, it also reconciles all
declared project ports.

`status` reports the selected mode, browser agent state, and the owned port
agents.  It does not claim that a remote development server is healthy: a
listening local SSH forward only proves the forward, not the application
behind it.

## Configuration and data flow

`browser.failover.autobind` is a new optional Boolean in `devbox.yml`, default
`false`.  It is carried through canonical normalization and the generated
client facts.  The client profile also carries each configured project's
`ports` list, so an installed client binary can bind without a local checkout.

The state file lives beside the existing active-profile state in
`~/.config/remote-devbox/browser-mode-<profile>`.  The absence of this file
means `client`, preserving the pre-feature lifecycle.  An explicit `server`
selection persists across launches and makes `devbox agent up` leave the
browser supervisor and port agents stopped.

## Port agents

Every bound port is one owned launchd daemon:

```text
com.devbox.<profile>.browser-port-<port>
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -L 127.0.0.1:<port>:127.0.0.1:<port> \
  <profile-host>
```

The `browser bind` target is the union of:

- one named configured project;
- every configured project (`--all`); or
- an explicitly supplied single port (`--port`).

Duplicate configured ports collapse to one agent.  A bind request fails closed
when no port target is supplied, a requested project has no declared ports, a
port is invalid, or launchd/SSH cannot claim the local listener.  The command
never kills an unrelated process or falls back to a different local port.

`unbind` removes only labels in the owned `browser-port-<port>` namespace.  It
never removes desktop, mount, browser, or hand-written launchd agents.

## Compatibility and rollout

Existing `devbox agent up` continues to start the client browser by default
when no browser-mode state has been written.  Existing client configuration
without project ports or the new autobind field remains readable and behaves
as `autobind: false` with no automatic port bindings.

After deployment, refresh the client binary/config with the generated
installer.  Operators can select the safe Devbox-local behavior immediately:

```bash
devbox browser mode server -p <chrome_user>
```

To return to a local browser and expose configured Devbox development ports:

```bash
devbox browser mode client -p <chrome_user>
devbox browser bind --all -p <chrome_user>
```

Set `browser.failover.autobind: true`, apply the Devbox configuration, and
refresh the client installer to have the client-mode transition reconcile all
declared ports automatically.

## Verification

Focused Bun tests cover configuration propagation/defaults, mode-state
selection, the restricted profile guard, exact SSH forwarding arguments,
owned-label reconciliation, manual target validation, and the client-mode
hint/autobind decision.  The client build remains the integration gate.  A
post-apply operational check compares CDP browser IDs at 9222, 9322, and 9422
in both modes, then verifies an explicitly bound development port from the
client.
