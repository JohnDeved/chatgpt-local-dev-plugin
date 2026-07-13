# Local Dev Plugin — Plan

> Let a private ChatGPT Developer Mode plugin work directly on projects on this computer through native MCP calls and OpenAI Secure MCP Tunnel.

## Architecture

```text
ChatGPT Developer Mode
  → OpenAI Secure MCP Tunnel
  → tunnel-client user service
  → Local Dev stdio MCP server
      ├── five native development tools
      └── selected tools from Serena, Chrome DevTools, and other stdio MCP servers
```

The Local Dev server owns one tool registry. Native and downstream tools are exposed directly through MCP; each call returns its result to ChatGPT without GPT Actions, OpenAPI, public ingress, or model-driven polling.

Version one supports one trusted user, one active project, one background process, stdio downstream servers, tools only, and a static tool list refreshed manually after configuration changes.

Do not add OAuth, Cloudflare, OpenAI model API calls, Codex dependencies, a database, multi-user state, shell strings, per-server adapters, or speculative frameworks.

## Compatibility gate

Before building the real toolchain, expose temporary MCP tools for `ping`, structured `echo`, `sleep`, sequence increment/read, and one harmless write.

Verify through the private plugin:

- exact structured inputs and outputs;
- four- and seven-call chains;
- 30-, 60-, and 120-second calls;
- write confirmations;
- large bounded text output;
- tool refresh after schema changes;
- reconnect after restarting the server or `tunnel-client`.

Proceed only when results return directly without model polling and chaining/reconnect behavior is reliable. Remove the benchmark tools afterward.

## Native tools

Expose exactly five custom tools:

- `project.open({ query })`: resolve a validated project path or search configured roots by exact, prefix, then contains match; activate downstream project hooks.
- `project.current()`: return the active project.
- `dev.run({ argv, background?, timeoutMs? })`: run an executable array with `shell: false` in the active project; bound output and allow one background process.
- `dev.poll()`: return background state, exit code, output tail, and detected loopback URLs.
- `dev.stop()`: stop and clear the background process.

Project discovery must avoid symlinks, ignored directories, unrestricted traversal, and project switching while a background process runs. Commands run with the local user’s permissions; RTK may be preferred when available.

## Downstream MCP proxy

Read `~/.local-dev/config.json`, start configured stdio MCP servers, fetch all `tools/list` pages, apply exact allowlists, namespace tools as `<alias>.<tool>`, preserve schemas/descriptions/annotations, and forward calls generically.

Adding a compliant MCP server must require configuration only. Serena’s command tools remain disabled because `dev.run` owns execution. Image-only tools stay out of version one.

Required downstream servers fail startup. Optional servers become unavailable with concise tool errors. Process supervision is handled by the outer user service rather than an internal restart framework.

## Setup UX

One idempotent setup command should:

1. detect the OS and required dependencies;
2. install or locate Local Dev, `tunnel-client`, Serena, RTK, and optional Chrome DevTools MCP;
3. write or repair configuration and validate selected tools;
4. create or select a Secure MCP Tunnel and initialize its stdio profile;
5. run `tunnel-client doctor --explain`;
6. install Local Dev and `tunnel-client` as auto-starting user services;
7. open ChatGPT Plugins and guide creation of the private **Local Dev** plugin;
8. confirm tool discovery with a harmless smoke test;
9. print **Local Dev is ready**.

Rerunning setup handles repair, dependency or tunnel changes, plugin refresh guidance, and uninstall. OpenAI tunnel authorization and final plugin creation remain manual.

## Security

- Local Dev uses stdio and opens no listener.
- `tunnel-client` makes outbound HTTPS connections only.
- Store tunnel credentials outside the repository and MCP config.
- Strip tunnel credentials from child environments.
- Restrict project paths and command working directories to configured roots.
- Reject shell strings and unknown tools.
- Preserve read-only/destructive MCP annotations.
- Bound output, retained logs, and execution time.
- Log metadata only, never secrets or full source payloads.
- Keep the plugin private.

## Implementation phases

1. **Compatibility gate** — prove native MCP behavior through Secure MCP Tunnel.
2. **Core server** — registry, project tools, commands, background process, shutdown.
3. **Generic proxy** — discovery, filtering, namespacing, forwarding, hooks.
4. **Setup** — dependencies, tunnel profile, services, repair, uninstall, ChatGPT handoff.
5. **End to end** — open a fixture project, edit with Serena, run checks, start a web server, inspect it with Chrome DevTools, stop it, verify the diff, and repeat a smoke test after reboot.

Keep the implementation as direct functions around one registry map. Avoid provider classes, plugin modules, and lifecycle frameworks.

## Definition of done

The project is complete when:

- one guided setup produces a usable private plugin;
- tool results return directly without model-driven polling;
- all selected downstream tools are exposed without server-specific code;
- only the five native tools are custom;
- Local Dev and `tunnel-client` start automatically;
- project, command, proxy, reconnect, setup/repair, and security edge cases are tested;
- the complete coding and browser workflow passes after reboot;
- no public ingress, OAuth, Actions layer, database, or public shell exists.

## Known limits

Developer Mode plugins carry elevated write-tool risk and must be enabled per conversation. Tool-list changes require refresh. The computer and tunnel client must remain online. Practical duration/output limits are determined by the compatibility gate. Concurrent conversations share one active project and background process.

## References

- ChatGPT Developer Mode: https://developers.openai.com/api/docs/guides/developer-mode
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Apps SDK MCP server guide: https://developers.openai.com/apps-sdk/build/mcp-server
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Serena: https://github.com/oraios/serena
- RTK: https://github.com/rtk-ai/rtk
- Chrome DevTools MCP: https://github.com/ChromeDevTools/chrome-devtools-mcp
