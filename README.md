# Local Dev Plugin

Phase 1 is a temporary compatibility gate for this private architecture:

```text
ChatGPT Developer Mode
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client
  -> Local Dev stdio MCP compatibility server
```

This milestone does **not** implement the production Local Dev tools, shared Codex configuration, downstream proxy, setup automation, or services. Continue only after the human checkpoint in [`docs/compatibility.md`](./docs/compatibility.md) passes.

## Local benchmark

The current package targets macOS with Node `22.16.0` and has no runtime dependencies.

```sh
nvm install
nvm use
npm ci
npm run check
npm run build
npm start
```

`npm run check` is the exact repository-wide check. The automated integration tests start the stdio server with temporary home directories and no credentials, browser, service, tunnel, or user configuration.

The default server exposes:

- `compat_ping`
- `compat_echo`
- `compat_sleep`
- `compat_sequence_increment`
- `compat_sequence_read`
- `compat_write_marker`

Set `LOCAL_DEV_COMPAT_ENABLE_REFRESH_PROBE=1` before startup to add the temporary `compat_refresh_probe` discovery tool.

## Real-tunnel checkpoint on macOS

Never commit or paste the runtime key. Use a new local profile so the existing demo backend can remain recoverable until the benchmark is confirmed.

```sh
cd /ABSOLUTE/PATH/chatgpt-local-dev-plugin
nvm use
npm ci
npm run build

export CONTROL_PLANE_API_KEY="<RUNTIME_KEY_IN_LOCAL_SHELL_ONLY>"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile local-dev-compat \
  --tunnel-id "<TUNNEL_ID>" \
  --mcp-command "node /ABSOLUTE/PATH/chatgpt-local-dev-plugin/dist/server.js"

tunnel-client doctor --profile local-dev-compat --explain
tunnel-client run --profile local-dev-compat
```

In ChatGPT, enable Developer Mode, open **Settings -> Plugins**, create a draft app named **Local Dev Compatibility Gate**, choose **Tunnel**, and select the existing tunnel. Then run every prompt and fill every `UNVERIFIED` row in [`docs/compatibility.md`](./docs/compatibility.md).

The official tunnel command shape can change; run `tunnel-client help quickstart` if the installed client rejects the documented `init` flags. Do not replace the stdio architecture with public ingress or polling.

See [`PLAN.md`](./PLAN.md) for the full phased plan. Phases 2-6 remain intentionally unimplemented.
