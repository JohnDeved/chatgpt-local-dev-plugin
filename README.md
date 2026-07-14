# Local Dev Plugin

Local Dev is a private MCP server for this architecture:

```text
ChatGPT Developer Mode
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client
  -> Local Dev stdio MCP server
```

The owner explicitly waived the unfinished long-running compatibility rows after the real tunnel passed refresh, ping, structured echo, and a four-call chain. The remaining evidence is still marked `UNVERIFIED` in [`docs/compatibility.md`](./docs/compatibility.md).

## Core server

The package targets macOS with Node `22.16.0`.

```sh
nvm install
nvm use
npm ci
npm run check
npm run build
npm start
```

`npm run check` is the exact repository-wide check. The automated integration tests start the stdio server with temporary home directories and no credentials, browser, service, tunnel, or user configuration.

The production server exposes eight native tools:

- `project.open`
- `project.list`
- `project.current`
- `dev.run`
- `dev.poll`
- `dev.stop`
- `question.ask`
- `observability.recent_calls`

It reads the shared Codex MCP registry from `~/.codex/config.toml` without modifying it. Local-only project roots, selected downstream server aliases, optional allowlisted local-media inlining, and argv-based project hooks live in `~/.local-dev/config.json`; see [`docs/configuration.md`](./docs/configuration.md). Selected stdio and Streamable HTTP servers are discovered with pagination, filtered using the Codex settings, namespaced as `<alias>.<tool>`, and forwarded generically.

## ChatGPT UI

Local Dev includes MCP Apps widgets rendered directly in ChatGPT:

- A command/process card for foreground results and the tracked background process, including bounded output, refresh/stop actions, and detected preview URLs.
- A searchable project picker backed by `project.list` and `project.open`.
- A recent-call inspector backed by the redacted in-memory journal.
- A structured question form for one to four agent questions, with single- or multi-select options and custom answers. Submitted answers are posted back into the conversation so the agent can continue.
- The existing image/audio viewer for allowlisted local media.

Downstream MCP tools that advertise an MCP Apps resource have their UI URI namespaced and rewritten through Local Dev. The referenced resource is read from the downstream server on demand. Self-contained HTML widgets are the safest compatibility target; downstream widgets remain responsible for valid CSP metadata and reachable external assets.

See [`docs/chatgpt-ui.md`](./docs/chatgpt-ui.md) for the UI architecture, tool contracts, and extension plan.

## Call dashboard

While the tunnel runtime is running, open the private local dashboard with:

```sh
local-dev dashboard
```

The dashboard shows native and proxied MCP calls live, including the exact tool name, server alias, redacted arguments, status, duration, bounded result data, and image/audio metadata. It listens only on an ephemeral `127.0.0.1` port behind a random per-runtime URL token; the URL is stored locally with user-only permissions. Calls are held in a 200-entry in-memory ring and are never persisted to a database. Credential-like fields and base64 media bytes are redacted. See [`docs/dashboard.md`](./docs/dashboard.md).

## Set up

```sh
cd /ABSOLUTE/PATH/chatgpt-local-dev-plugin
nvm use
npm ci
npm run build
npm link
local-dev setup
```

Setup is resumable and doubles as repair/reconfiguration. Use `local-dev status` for a concise health report, `local-dev status --json` for automation, and `local-dev uninstall` to remove the login service and Local Dev state without deleting shared Codex MCP entries. See [`docs/setup.md`](./docs/setup.md) for write, backup, tunnel, service, and rollback behavior.

Never commit or paste tunnel or downstream credentials. Use an `env:NAME` or `file:/absolute/path` reference for the runtime key; no public ingress or polling fallback is used.

See [`PLAN.md`](./PLAN.md) for the full phased plan.
