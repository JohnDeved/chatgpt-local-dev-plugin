# Setup, repair, status, and uninstall

Local Dev supports macOS with Node 22.16 and tunnel-client v0.0.10. After installing or linking this package, the happy path is:

```sh
local-dev setup
```

Setup detects prior state, a tunnel-client path selected by `TUNNEL_CLIENT_BIN` or the installed tunnel-mcp plugin, the shared Codex registry, explicitly bounded server recommendations, and a project root. If tunnel-client is missing, setup offers to install the pinned public macOS release in `~/.local/bin` only after verifying the published SHA-256 checksum.

Before writing, setup prints the detected roots, selected server aliases, and affected files, then asks for confirmation. It preserves the existing Codex TOML byte-for-byte, creates it only when missing, backs up changed files with timestamps, writes atomically, and restores the previous configuration if smoke testing or tunnel setup fails. Literal credentials are rejected; tunnel runtime credentials must be referenced as `env:NAME` or `file:/absolute/path`.

Setup delegates tunnel lifecycle to native `tunnel-client runtimes` commands. It opens the official tunnel and runtime-key pages when a tunnel must be selected, connects the stdio command, and accepts readiness only after native JSON status reports `process_running`, `healthy`, and `ready`. Control-plane polling health is shown separately. A macOS LaunchAgent runs a persistent `local-dev watchdog` under `/usr/bin/caffeinate -i`. Display locking remains available, while idle system sleep is prevented on both AC and battery power. Lid-close sleep and other forced sleep states are still hardware/OS controlled; after any such wake, the watchdog detects the long clock gap after wake and force-recycles the managed runtime so stale ChatGPT-facing routes are replaced. It also reconnects any locally unhealthy or exited runtime. tunnel-client remains the runtime supervisor and starts the Local Dev stdio child.

The final handoff opens ChatGPT connector settings and prints the three private-connector actions. OpenAI authorization and final connector creation remain the only browser interactions.

Use the other two commands for ongoing operation:

```sh
local-dev status
local-dev uninstall
```

`status` checks saved configuration, the loaded login service, native tunnel readiness, control-plane polling, and a direct MCP discovery/call smoke test. It prints concise repair actions and supports `--json`.

`uninstall` unloads the login service, stops and removes only the local runtime alias, and deletes Local Dev state. It does not delete the remote tunnel, shared `~/.codex/config.toml`, or any Codex MCP entry. Timestamped backups inside the Local Dev state directory are removed with that directory.

Advanced setup flags are available through `local-dev --help` for non-interactive automation. `--runtime-key-ref` accepts references only, never a literal key.
