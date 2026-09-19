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
npm run desktop:setup
npm run check
npm run build
npm start
```

`npm run check` is the exact repository-wide check. Run `npm run polish` for a repeatable Fallow change audit plus a repo-wide dead-code, duplication, and health report; agents also follow the Ponytail minimal-change ladder in [`AGENTS.md`](./AGENTS.md). The automated integration tests start the stdio server with temporary home directories and no credentials, browser, service, tunnel, or user configuration.

The production server exposes fifteen native tools:

- `project.open`
- `project.current`
- `project.read`
- `project.files`
- `project.release`
- `project.forceRelease`
- `project.handoff`
- `dev.run`
- `dev.batch`
- `dev.poll`
- `dev.stop`
- `dev.diff`
- `run.start`
- `run.update`
- `run.finish`

`run.start` publishes the goal and beginning of a user-request workflow; `run.update` supplies brief public summaries and acknowledges locally submitted steering; `run.finish` explicitly reports completion, failure, or cancellation. See [`docs/worker-runs.md`](./docs/worker-runs.md) for attribution and delivery limits.

`project.open` automatically resolves an existing project or creates a durable or temporary project when requested. Temporary projects are removed when the Local Dev runtime closes.

`dev.run` rejects shell-evaluation flags, supports a validated relative `cwd`, returns retained output for nonzero exits and timeouts, and requires `allowNonZero: true` when a nonzero status is expected. `dev.batch` runs two to twenty foreground argv commands sequentially without a shell.

It reads the shared Codex MCP registry from `~/.codex/config.toml` without modifying it. Local-only project roots, selected downstream server aliases, optional allowlisted local-media inlining, argv-based project hooks, and generic downstream project bindings live in `~/.local-dev/config.json`; see [`docs/configuration.md`](./docs/configuration.md). Selected stdio and Streamable HTTP servers are discovered with pagination, filtered using the Codex settings, namespaced as `<alias>.<tool>`, and forwarded generically.

## Web-technology tray companion

Local Dev includes a persistent tray companion built with **React, TypeScript, Vite, and Electrobun**. Click its status item to open **Runs**, **Attention**, **Processes**, and **Settings**. Goals and explicit run boundaries lead the timeline; commands, output, and original records expand on demand. Pending approvals have a dedicated Attention view, and steering drafts persist locally. Closing the window leaves the tray companion running.

```sh
npm run check
npm run desktop:install
```

The app is installed at `~/Applications/Local Dev.app`. Existing macOS login registration is not automatically changed; the Settings page opens the OS startup controls. The previous SwiftUI app is retained as a backup during installation. An existing tunnel runtime must reconnect to load the updated server. The app diagnoses this as **Runtime update needed** and offers **Reconnect updated runtime…**, with an explicit warning that existing managed commands may stop. Installing the companion restarts only its UI, not the tunnel or development processes.

Approval-required is the default. **Auto-approve all** requires an explicit confirmation in the local app, remains visibly indicated while enabled, and can optionally be remembered across restarts. **Pause** always overrides auto-approval. The approval policy is not exposed as an MCP tool.

The local journal preserves full, unmasked records with owner-only permissions. It can contain credentials and execution environment values; it is not automatically uploaded or added to the ChatGPT conversation. The model-facing output tail remains bounded without truncating the local archive. No automatic archive deletion is enabled. See [`docs/web-desktop.md`](./docs/web-desktop.md) for the researched stack, security boundary, tests, installation, and cross-platform work remaining. The earlier native implementation is documented in [`docs/menu-bar.md`](./docs/menu-bar.md).

## ChatGPT tool activity

The stdio server remains tool-only: it does not expose MCP Apps widgets or a public dashboard. Optional MCP invocation labels and client-requested progress notifications supplement the independent local display. Progress heartbeats use increasing activity counters rather than invented completion percentages, and returned tool errors no longer receive successful completion labels. Assistant narration is useful but is not a guaranteed visibility mechanism. See [`docs/chatgpt-progress.md`](./docs/chatgpt-progress.md).

## Set up

```sh
cd /ABSOLUTE/PATH/chatgpt-local-dev-plugin
nvm use
npm ci
npm run build
npm link
local-dev setup
```

Setup is resumable and doubles as repair/reconfiguration. The macOS login service runs a persistent tunnel supervisor: display locking remains available, idle system sleep is prevented while on AC power, and a battery/lid sleep is detected after wake so the tunnel runtime is recreated before stale routes can persist. The supervisor also repairs an exited runtime without ChatGPT access. Use `local-dev status` for a concise health report, `local-dev status --json` for automation, and `local-dev uninstall` to remove the login service and Local Dev state without deleting shared Codex MCP entries. See [`docs/setup.md`](./docs/setup.md) for write, backup, tunnel, service, and rollback behavior.

Never commit or paste tunnel or downstream credentials. Use an `env:NAME` or `file:/absolute/path` reference for the runtime key; no public ingress or polling fallback is used.

See [`PLAN.md`](./PLAN.md) for the full phased plan.
