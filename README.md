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

The package targets macOS with Node `24.18.0`.

```sh
nvm install
nvm use
npm ci
npm run check
npm run build
npm start
```

`npm run check` is the exact repository-wide check. The automated integration tests start the stdio server with temporary home directories and no credentials, browser, service, tunnel, or user configuration.

The production server exposes seven native tools:

- `project.open`
- `project.current`
- `dev.run`
- `dev.batch`
- `dev.poll`
- `dev.stop`
- `dev.diff`

`project.open` automatically resolves an existing project or creates a durable or temporary project when requested. Temporary projects are removed when the Local Dev runtime closes.

`dev.run` rejects shell-evaluation flags, supports a validated relative `cwd`, returns retained output for nonzero exits and timeouts, and requires `allowNonZero: true` when a nonzero status is expected. `dev.batch` runs two to twenty foreground argv commands sequentially without a shell.

It reads the shared Codex MCP registry from `~/.codex/config.toml` without modifying it. Local-only project roots, selected downstream server aliases, optional allowlisted local-media inlining, argv-based project hooks, and generic downstream project bindings live in `~/.local-dev/config.json`; see [`docs/configuration.md`](./docs/configuration.md). Selected stdio and Streamable HTTP servers are discovered with pagination, filtered using the Codex settings, namespaced as `<alias>.<tool>`, and forwarded generically.

## ChatGPT tool activity

Local Dev is a tool-only MCP server. It does not expose dashboards, MCP Apps resources, embedded widgets, project pickers, question forms, media viewers, or observability tools. Native and proxied tools provide concise `openai/toolInvocation/invoking` and `openai/toolInvocation/invoked` status metadata so ChatGPT can show command activity in its standard tool UI. Any downstream embedded-UI metadata is stripped while non-UI metadata, schemas, annotations, and tool results are preserved.

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
