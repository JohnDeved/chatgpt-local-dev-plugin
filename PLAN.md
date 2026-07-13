# Local Dev Plugin — Plan

> Let a private ChatGPT Developer Mode plugin work directly on local projects through native MCP calls and OpenAI Secure MCP Tunnel.

## Architecture

```text
ChatGPT Developer Mode
  → OpenAI Secure MCP Tunnel
  → tunnel-client user service
  → Local Dev stdio MCP server
      ├── five native development tools
      └── selected MCP servers from ~/.codex/config.toml
```

Local Dev exposes native and downstream tools through one MCP registry. Each call returns directly to ChatGPT without GPT Actions, OpenAPI, public ingress, or model-driven polling.

Version one supports one trusted user, one active project, one background process, tools only, and a static tool list refreshed after configuration changes.

Do not add custom OAuth, Cloudflare, OpenAI model API calls, a Codex runtime dependency, a database, multi-user state, shell strings, per-server adapters, or speculative frameworks.

## Compatibility gate

First expose temporary MCP tools for `ping`, structured `echo`, `sleep`, sequence increment/read, and one harmless write.

Verify exact inputs/outputs, four- and seven-call chains, 30/60/120-second calls, write confirmations, bounded large output, tool refresh, and reconnect after restarting the server or `tunnel-client`.

Proceed only when results return without model polling and chaining/reconnect behavior is reliable. Remove the benchmark tools afterward.

### Phase 1 implementation note (2026-07-13)

Current OpenAI tunnel documentation still accepts a local stdio command. The current official TypeScript SDK repository recommends split server/client packages, while the OpenAI Apps SDK example still shows the legacy combined package. To keep this temporary compatibility gate focused on transport behavior rather than package-version ambiguity, Phase 1 implements only the bounded MCP stdio subset it needs with Node built-ins and zero runtime dependencies. Revisit the production SDK choice only after the human checkpoint; this note does not authorize Phase 2 work.

### Owner checkpoint waiver (2026-07-13)

The repository owner explicitly directed implementation to continue before every long-running Phase 1 row was executed. Real tunnel tool refresh, exact ping, exact structured echo, and a four-call sequence chain passed without model polling; the remaining rows stay unverified in `docs/compatibility.md`. This is an explicit schedule waiver, not a fabricated compatibility pass, and it does not authorize fallback transports.

### Implementation status (2026-07-13)

Phases 2-5 are implemented. The production server now loads the shared Codex registry read-only, exposes the five native tools, manages one bounded background process, runs argv-only project hooks, and generically proxies selected stdio and Streamable HTTP MCP tools with pagination, inherited filters, aliases, metadata preservation, and required/optional availability behavior. The three-command setup surface performs verified dependency installation, previewed and reversible configuration, direct smoke testing, native tunnel connection/readiness checks, macOS login auto-start, status/repair, uninstall, and the ChatGPT handoff. Temporary-home and fake-server tests require no credentials, tunnel, browser, service, or user configuration. Phase 6 real-environment and reboot evidence remains.

The temporary Phase 1 `ping` tool is intentionally absent from production. Phase 5 therefore proves the same local readiness property with a direct MCP initialize/list/`project.current` smoke call, then separately requires native tunnel `process_running`, `/healthz`, and `/readyz` success. This preserves direct request/response behavior without retaining a sixth custom tool.

Phase 6 is in progress with evidence recorded in `docs/verification.md`. The real setup, combined native/downstream registry, Serena edit, repository check through `dev.run`, Chrome DevTools inspection, tunnel readiness, and login service have passed. Signed-in ChatGPT connector refresh/call and post-reboot repetition remain explicit unchecked requirements until user-authorized browser and reboot actions occur.

## Shared MCP configuration

Use `~/.codex/config.toml` as the canonical MCP registry shared with the ChatGPT desktop app, Codex CLI, and Codex IDE extension.

Local Dev reads enabled `[mcp_servers.<id>]` entries, including stdio/HTTP connection settings, timeouts, required state, and tool filters. It discovers schemas, descriptions, and annotations from each server.

`~/.local-dev/config.json` stores only Local Dev concerns: project roots, selected server IDs, aliases, and project-open hooks. It must not duplicate commands, URLs, credentials, or tool filters.

Skip Codex-managed OAuth or ChatGPT-session-authenticated servers unless independently usable credentials exist. Version one reads the global Codex config only.

## Native tools

Expose exactly five custom tools:

- `project.open({ query })`: resolve a validated path or search configured roots; activate project hooks.
- `project.current()`: return the active project.
- `dev.run({ argv, background?, timeoutMs? })`: execute an argument array with `shell: false`; bound output and allow one background process.
- `dev.poll()`: return background state, exit code, output tail, and detected loopback URLs.
- `dev.stop()`: stop and clear the background process.

Project discovery avoids symlinks, ignored directories, unrestricted traversal, and switching while a background process runs. Commands run with the local user’s permissions; RTK may be preferred when available.

## Downstream MCP proxy

For each selected Codex MCP entry, connect, fetch all `tools/list` pages, apply inherited filters, namespace tools as `<alias>.<tool>`, preserve metadata, and forward calls generically.

Adding or changing an MCP server happens in the shared Codex config, followed by a Local Dev restart and plugin refresh. Serena command tools remain disabled because `dev.run` owns execution. Image-only tools stay out of version one.

Required servers fail startup. Optional servers return concise unavailable errors. The outer user service restarts the stack; do not build an internal supervision framework.

## Setup UX

The happy path must be one copy-paste command and no manual file editing:

```text
local-dev setup
```

UX requirements:

- detect existing tools, Codex MCP servers, likely project roots, and prior setup automatically;
- preselect safe recommended defaults and hide advanced settings;
- explain every permission or system change before applying it;
- back up changed files and make every step idempotent, resumable, and reversible;
- open required browser pages automatically and provide one-click/copyable values;
- show a live checklist with clear fixes instead of raw stack traces;
- finish with an end-to-end smoke test and a single readiness screen.

Happy path:

1. Run silent preflight checks.
2. Confirm detected project roots and recommended MCP servers.
3. Install only missing dependencies after one confirmation.
4. Safely create or update the shared Codex config and Local Dev selections.
5. Open OpenAI tunnel authorization, create/select the tunnel, and initialize its stdio profile.
6. Run tunnel diagnostics and install auto-start services.
7. Open ChatGPT Plugins with the exact private-plugin steps and values ready to copy.
8. Wait for the first `ping`, run a smoke test, and print **Local Dev is ready**.

Only OpenAI authorization and final plugin creation should require manual interaction. Setup must never require editing TOML/JSON, running service commands, or understanding MCP/tunnel internals.

Keep the user-facing command surface small:

- `local-dev setup` — install, resume, repair, or reconfigure;
- `local-dev status` — concise health and remediation;
- `local-dev uninstall` — remove services and Local Dev state without deleting shared Codex MCP entries by default.

## Security

- Local Dev uses stdio and opens no listener.
- `tunnel-client` makes outbound HTTPS connections only.
- Store tunnel and downstream credentials outside the repository and Local Dev config.
- Never log or return MCP headers, tokens, or child environments.
- Restrict projects and command working directories to configured roots.
- Reject shell strings and unknown tools.
- Require explicit Local Dev server selection even when enabled in Codex.
- Preserve upstream read-only/destructive annotations.
- Bound output, retained logs, and execution time.
- Keep the plugin private.

## Agent execution contract

- Verify current OpenAI tunnel, Developer Mode, Codex config, and MCP SDK behavior from official docs before coding; record any changed assumptions in the plan.
- Treat the compatibility gate as a hard human checkpoint. Provide exact test prompts and record observed limits in `docs/compatibility.md`; do not continue or add polling/public-ingress fallbacks if it fails.
- Use TypeScript ESM, a pinned Node runtime range, exact dependency versions, and a committed lockfile.
- Return stable `structuredContent` for every native tool, with concise text fallback and machine-readable error codes; never expose raw stack traces.
- Runtime access to `~/.codex/config.toml` is read-only. Setup changes require a preview, confirmation, timestamped backup, atomic write, preservation of unknown fields, and rollback on failure.
- Prefer the Codex CLI for MCP config changes when available; otherwise use a TOML-preserving edit rather than rewriting the file.
- CI must use temporary homes and fake stdio/HTTP MCP servers. It must not require real credentials, network tunnels, browsers, services, or user configuration.
- Keep platform-specific installation and service logic behind small adapters. Never claim an OS is supported until install, repair, uninstall, reboot, and smoke tests pass there.
- Each phase ends with implementation, tests, concise docs, and one repository-wide check command. Do not begin the next phase while required checks fail.
- When the plan is ambiguous, choose the smallest implementation consistent with the architecture and document the decision rather than adding abstraction.

## Implementation phases

1. **Compatibility gate** — prove native MCP behavior through Secure MCP Tunnel.
2. **Shared config loader** — parse Codex MCP entries and Local Dev selections safely.
3. **Core server** — registry, project tools, commands, background process, shutdown.
4. **Generic proxy** — stdio/HTTP connections, filtering, namespacing, forwarding, hooks.
5. **Setup UX** — guided install, tunnel/profile, services, status, repair, uninstall, and ChatGPT handoff.
6. **End to end** — edit with Serena, run checks, inspect a web app through Chrome DevTools, verify the diff, and repeat after reboot.

Keep direct functions around one registry map. Avoid provider classes, plugin modules, and lifecycle frameworks.

## Definition of done

The project is complete when:

- one command plus unavoidable browser authorization produces a usable private plugin;
- users never need to edit config files or manage services manually;
- setup can resume, repair, and uninstall cleanly;
- tool results return directly without model-driven polling;
- Codex, ChatGPT desktop, and Local Dev use one MCP registry;
- selected downstream tools are exposed without server-specific code;
- only the five native tools are custom;
- Local Dev and `tunnel-client` start automatically;
- config, project, command, proxy, reconnect, setup, and security cases are tested;
- the complete coding/browser workflow passes after reboot;
- no public ingress, custom OAuth, Actions layer, database, or public shell exists.

## Known limits

Developer Mode plugins carry elevated write-tool risk and must be enabled per conversation. Tool changes require refresh. The computer and tunnel client must stay online. Codex-managed OAuth entries may not be reusable. Practical duration/output limits come from the compatibility gate. Concurrent conversations share one active project and background process.

## References

- ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Codex MCP configuration: https://developers.openai.com/codex/mcp
- Codex config reference: https://developers.openai.com/codex/config-reference
- Apps SDK MCP server guide: https://developers.openai.com/apps-sdk/build/mcp-server
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
