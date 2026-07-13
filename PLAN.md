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

Verify through the private plugin:

- exact structured inputs and outputs;
- four- and seven-call chains;
- 30-, 60-, and 120-second calls;
- write confirmations;
- bounded large output;
- tool refresh after schema changes;
- reconnect after restarting the server or `tunnel-client`.

Proceed only when results return without model polling and chaining/reconnect behavior is reliable. Remove the benchmark tools afterward.

## Shared MCP configuration

Use `~/.codex/config.toml` as the canonical MCP server registry shared with the ChatGPT desktop app, Codex CLI, and Codex IDE extension.

Local Dev reads enabled `[mcp_servers.<id>]` entries and supports:

- stdio `command`, `args`, `env`, `cwd`, and startup/tool timeouts;
- Streamable HTTP `url`, bearer-token environment variables, and explicit headers;
- `required`, `enabled_tools`, and `disabled_tools`;
- schemas, descriptions, and MCP annotations discovered from each server.

`~/.local-dev/config.json` stores only Local Dev concerns: project roots, selected server IDs, aliases, and project-open hooks. It must not duplicate server commands, URLs, credentials, or tool filters.

Servers using Codex-managed OAuth or ChatGPT-session authentication cannot be reused automatically; skip them with a clear diagnostic unless independently usable credentials are configured. Codex approval modes remain client-specific and are not copied; Local Dev preserves upstream MCP read/write annotations.

Version one reads the global Codex config only. Project-scoped `.codex/config.toml` support is deferred because the plugin tool list is static during a session.

## Native tools

Expose exactly five custom tools:

- `project.open({ query })`: resolve a validated path or search configured roots; activate project hooks.
- `project.current()`: return the active project.
- `dev.run({ argv, background?, timeoutMs? })`: execute an argument array with `shell: false`; bound output and allow one background process.
- `dev.poll()`: return background state, exit code, output tail, and detected loopback URLs.
- `dev.stop()`: stop and clear the background process.

Project discovery avoids symlinks, ignored directories, unrestricted traversal, and switching while a background process runs. Commands run with the local user’s permissions; RTK may be preferred when available.

## Downstream MCP proxy

For each selected Codex MCP entry, connect, fetch every `tools/list` page, apply inherited filters, namespace tools as `<alias>.<tool>`, preserve metadata, and forward calls generically.

Adding or changing an MCP server happens in the shared Codex config, followed by a Local Dev restart and plugin refresh. Serena command tools remain disabled because `dev.run` owns execution. Image-only tools stay out of version one.

Required servers fail startup. Optional servers return concise unavailable errors. The outer user service restarts the stack; do not build an internal supervision framework.

## Setup UX

One idempotent setup command should:

1. detect the OS and dependencies;
2. install or locate Local Dev and `tunnel-client`;
3. locate or create `~/.codex/config.toml`;
4. show enabled MCP servers and let the user select which Local Dev may expose;
5. optionally add Serena, RTK, and Chrome DevTools MCP to the shared config, using Codex CLI when available or a backed-up TOML edit otherwise;
6. write Local Dev roots, aliases, selections, and hooks;
7. validate selected servers and tool filters;
8. create/select a Secure MCP Tunnel and initialize its stdio profile;
9. run `tunnel-client doctor --explain`;
10. install auto-starting user services;
11. open ChatGPT Plugins and guide private plugin creation;
12. run a harmless smoke test and print **Local Dev is ready**.

Rerunning setup handles repair, shared-config changes, tunnel changes, plugin refresh guidance, and uninstall. OpenAI tunnel authorization and final plugin creation remain manual.

## Security

- Local Dev uses stdio and opens no listener.
- `tunnel-client` makes outbound HTTPS connections only.
- Store tunnel and downstream credentials outside the repository and Local Dev config.
- Never log or return MCP headers, tokens, or child environments.
- Restrict projects and command working directories to configured roots.
- Reject shell strings and unknown tools.
- Require explicit Local Dev server selection even when a server is enabled in Codex.
- Preserve upstream read-only/destructive annotations.
- Bound output, retained logs, and execution time.
- Keep the plugin private.

## Implementation phases

1. **Compatibility gate** — prove native MCP behavior through Secure MCP Tunnel.
2. **Shared config loader** — parse Codex MCP entries and Local Dev selections safely.
3. **Core server** — registry, project tools, commands, background process, shutdown.
4. **Generic proxy** — stdio/HTTP connections, filtering, namespacing, forwarding, hooks.
5. **Setup** — shared-config onboarding, tunnel profile, services, repair, uninstall, ChatGPT handoff.
6. **End to end** — edit with Serena, run checks, inspect a web app through Chrome DevTools, verify the diff, and repeat after reboot.

Keep direct functions around one registry map. Avoid provider classes, plugin modules, and lifecycle frameworks.

## Definition of done

The project is complete when:

- one guided setup produces a usable private plugin;
- tool results return directly without model-driven polling;
- Codex, ChatGPT desktop, and Local Dev use one MCP server registry;
- selected downstream tools are exposed without server-specific code;
- only the five native tools are custom;
- Local Dev and `tunnel-client` start automatically;
- config parsing, project, command, proxy, reconnect, setup/repair, and security cases are tested;
- the complete coding and browser workflow passes after reboot;
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
