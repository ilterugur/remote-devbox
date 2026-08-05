# Seeing & running the box in real time on your client

Goal: Claude works on the box; you close the client; you reopen it and see the
**current** state of your projects and run the live app — full-sync or close to it.

## Mental model: don't sync — make the client a live window

The cleanest setup is **not** to mirror files. Keep one source of truth on the box
and look at it directly. There's nothing to "sync" because there's only one copy —
what you open is the box's current state. (If you genuinely need a local copy, see
[C] below.)

## Register the box in your editors

Set the machine up from the box once — this writes the `~/.ssh/config` block
(`Host devbox-<user>`) that VS Code / Cursor Remote-SSH, plain `ssh`, **and Zed** all
use, along with the `devbox` CLI itself:

```bash
ssh <you>@<box> 'devbox client-config --installer' > devbox-setup.sh
less devbox-setup.sh && sh devbox-setup.sh
```

Then add Zed's own remote-project list, which is client-side and so is not the box's to
write:

```bash
devbox editors    # Zed ssh_connections pre-listing each profile's ~/projects/<name>
```

Then:

- **VS Code / Cursor:** Remote-SSH → *Connect to Host* → `devbox-work`.
- **Zed:** command palette → *projects: open remote* → pick the profile + project.

It backs up the files and only rewrites its own managed block (Zed config with
comments is left untouched — it prints the snippet to paste instead).

## A) See the live code

- **VS Code / Cursor Remote-SSH** (the dominant approach): open the box's folder
  over SSH and edit the **real files**. When Claude changes a file on the box, you
  see it instantly — same filesystem, no copy. It also auto-forwards dev-server
  ports (see B1).
- **Claude Desktop** (Code → SSH): has built-in visual **diff review** and server
  previews; watch Claude's changes and the running app from the app itself.

## B) Run/experience the live app in your client browser

Dev servers run on the box (start them with `sudo remote-devbox-dev <user> <project>`
so they survive a closed client). Bring them to your client browser one of three ways:

1. **VS Code Remote-SSH auto port-forward (easiest):** run `bun run dev` in the
   remote terminal; VS Code forwards the port to `localhost:5173` on your client.
   HMR just works and **no Vite config change is needed** (the browser sees
   `localhost`).
2. **Tailscale Serve:** on the box, `tailscale serve 5173` → reachable at
   `https://<box>.<tailnet>.ts.net` over TLS, from client **and** phone, without
   exposing any public port.
3. **Manual SSH tunnel:** `ssh -L 5173:localhost:5173 dev@<box>` → `localhost:5173`.

> ⚠️ **Vite HMR gotcha** (only when reaching the dev server over the network, i.e.
> Tailscale/direct — not via VS Code's localhost forward): set `server.host` to
> `0.0.0.0` **and** `server.hmr.host` to the box's hostname in `vite.config`,
> otherwise the browser opens the HMR WebSocket against its own `localhost` and
> live-reload silently fails. Most frameworks have an equivalent
> (`--host` + a public-host/WebSocket setting).

## C) True two-way sync (optional)

Only if you want a real local copy (native tooling, offline edits):

- **[Mutagen](https://mutagen.io/documentation/synchronization)** — real-time
  bidirectional sync over SSH:
  ```bash
  mutagen sync create --name=devbox ./local-path dev@<box>:~/projects/my-monorepo
  ```
- **[Syncthing](https://syncthing.net/)** — continuous folder mirror.

Most people don't need this with Remote-SSH; it adds conflict handling. Use it only
if "the files must also live on my client" is a hard requirement.

## The "close → Claude works → reopen" flow

1. Dev servers run on the box in tmux (`sudo remote-devbox-dev <user> <project>`) →
   survive a closed client.
2. Claude's always-on Remote Control servers keep working (see [mobile.md](mobile.md)).
3. Reopen the client:
   - **VS Code Remote-SSH** reconnects → current files (whatever Claude did).
   - **Remote Control** → rejoin the session where Claude left off.
   - Browser at the **Tailscale Serve / forwarded URL** → the app's current state
     (Vite already hot-reloaded).

Nothing depended on the client, so reopening is inherently "in sync."

## References

- [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh)
- [Tailscale Serve examples](https://tailscale.com/docs/reference/examples/serve)
- [Mutagen — synchronization](https://mutagen.io/documentation/synchronization)
