# Local Dev Plugin — Implementation Plan

> Let ChatGPT Developer Mode work directly on projects on this computer through one private MCP plugin.
>
> Use OpenAI Secure MCP Tunnel for transport. Keep the local server on stdio, reuse Serena and other local MCP servers, and return each tool result directly to ChatGPT without an Actions/OpenAPI layer or model-driven polling.

## 1. Intended experience

### First-time setup

1. Install Local Dev.
2. Run one guided setup.
3. Setup detects or installs `tunnel-client`, Serena, RTK, and optional Chrome DevTools MCP.
4. Setup writes local configuration, creates a Secure MCP Tunnel profile, and installs auto-starting user services.
5. Setup opens ChatGPT Plugins and guides the user to create a private Developer Mode plugin using the configured tunnel.
6. Setup validates tool discovery and runs a harmless smoke test.
7. The final state is **Local Dev is ready**.

After setup, the user only needs the computer online. Rerunning setup repairs or reconfigures the installation.

### Daily workflow

The user enables the private **Local Dev** plugin in a ChatGPT conversation and says:

> Open `acme-dashboard`, fix the settings form, run the checks, and verify it in Chrome.

ChatGPT can then:

1. open the project by name or path;
2. inspect and edit code through Serena;
3. run commands directly or through RTK;
4. start and stop one development server;
5. inspect the local site through Chrome DevTools MCP;
6. inspect the final Git diff;
7. commit only when explicitly requested.

## 2. Architecture

```text
ChatGPT Developer Mode
  │ native MCP request / response
  ▼
OpenAI Secure MCP Tunnel
  │ outbound HTTPS, no public ingress
  ▼
tunnel-client user service
  │ stdio
  ▼
Local Dev MCP server
  ├── native project and command tools
  └── generic tools-only MCP proxy
        ├── Serena MCP
        ├── Chrome DevTools MCP
        └── other configured stdio MCP servers
```

The Local Dev server owns one tool registry. Native tools and selected downstream MCP tools enter the same registry and are exposed directly through MCP.

Version one is limited to:

- one trusted user;
- one active project;
- one background process;
- local stdio downstream MCP servers;
- MCP tools only;
- a static public tool list loaded at startup;
- manual plugin refresh after the exposed tool list changes.

Do not add:

- GPT Actions or OpenAPI generation;
- Cloudflare or public HTTP ingress;
- custom OAuth;
- OpenAI model API calls or model billing;
- Codex as a runtime dependency;
- a database;
- multi-user or multi-session state;
- a task framework;
- plugin-specific proxy modules;
- copied downstream schemas;
- shell command strings or `shell: true`.

## 3. Compatibility gate

Before implementing the full toolchain, build a minimal stdio MCP server with:

- `ping`;
- structured `echo`;
- `sleep`;
- stateful sequence increment/read;
- one harmless consequential tool.

Verify through the private Developer Mode plugin:

- direct request → result behavior;
- exact structured inputs and outputs;
- four- and seven-call chains;
- 30-, 60-, and 120-second calls;
- write confirmation behavior;
- reconnect after restarting `tunnel-client` or the MCP server;
- tool refresh after schema changes;
- bounded large text output.

The gate passes when results return directly without model-driven polling, chaining is reliable, and reconnect behavior is understandable. Remove the benchmark tools after the gate passes.

## 4. MCP tool registry and proxy

At startup:

1. register the five native tools;
2. parse `~/.local-dev/config.json`;
3. start configured downstream stdio MCP servers;
4. initialize one MCP client per server;
5. fetch every page of `tools/list`;
6. apply exact allowlists and denylists;
7. namespace each selected tool as `<alias>.<tool>`;
8. preserve descriptions, input/output schemas, annotations, and supported metadata;
9. register a generic forwarding handler;
10. reject duplicate public names.

Runtime dispatch is generic:

```text
ChatGPT tools/call
  → registry lookup
  → native handler or downstream tools/call
  → bounded MCP result
```

No endpoint- or server-specific implementation code is allowed.

When a downstream server fails:

- optional servers are marked unavailable and their tools return a concise error;
- required servers fail startup;
- the orchestrator does not implement a child-process restart framework;
- the outer user service restarts the whole stack after process failure.

The proxy supports tools only in version one. Do not proxy resources, prompts, roots, sampling, or elicitation.

## 5. Native tools

Expose exactly five native tools.

### `project.open`

```ts
{ query: string }
```

Behavior:

1. reject project switching while a background process runs;
2. accept an existing path after expansion, canonicalization, directory validation, and project-marker validation;
3. otherwise search configured roots without following symlinks;
4. match directory basenames by exact, prefix, then contains;
5. open one clear match;
6. return at most ten paths when ambiguous;
7. return `not_found` when nothing matches;
8. set the active project;
9. invoke configured project-open hooks such as Serena `activate_project`.

### `project.current`

Return the active project name and path, or `{ "active": false }`.

### `dev.run`

```ts
{
  argv: string[];
  background?: boolean;
  timeoutMs?: number;
}
```

Rules:

- require an active project and non-empty `argv`;
- use `argv[0]` as the executable and the rest as arguments;
- set `cwd` to the active project;
- use `shell: false`;
- strip tunnel credentials from the child environment;
- bound retained stdout and stderr;
- support long foreground calls within observed ChatGPT/MCP limits;
- support one background process for development servers;
- prefer RTK when supported, while allowing raw executable arrays.

### `dev.poll`

Return background running state, exit code, bounded output tail, and detected loopback URLs.

### `dev.stop`

Stop the background process group where supported, otherwise stop the direct child, then clear process state.

## 6. Configuration

Use one local file:

```text
~/.local-dev/config.json
```

Example:

```json
{
  "roots": ["~/Projects", "~/Code", "~/dev"],
  "mcpServers": {
    "serena": {
      "alias": "code",
      "command": "serena",
      "args": ["start-mcp-server", "--context=codex"],
      "tools": [
        "get_symbols_overview",
        "find_symbol",
        "find_referencing_symbols",
        "search_for_pattern",
        "read_file",
        "list_dir",
        "find_file",
        "replace_symbol_body",
        "insert_before_symbol",
        "insert_after_symbol",
        "rename_symbol",
        "replace_content"
      ],
      "onProjectOpen": {
        "tool": "activate_project",
        "argument": "project"
      }
    },
    "chrome_devtools": {
      "alias": "browser",
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@PINNED_VERSION", "--headless=true", "--isolated=true"],
      "tools": [
        "new_page",
        "navigate_page",
        "take_snapshot",
        "list_console_messages",
        "get_console_message",
        "list_network_requests",
        "get_network_request",
        "click",
        "fill",
        "evaluate_script"
      ]
    }
  }
}
```

Configuration rules:

- setup writes sensible defaults;
- exact allowlists prevent silent tool-surface growth;
- the server key is the default namespace and `alias` is optional;
- only stdio MCP servers are supported;
- one generic project-open hook is supported;
- Serena shell tools remain disabled because `dev.run` owns command execution;
- adding another compliant MCP server requires configuration and plugin refresh, not source changes.

## 7. Security model

- The Local Dev MCP server uses stdio and has no network listener.
- `tunnel-client` initiates outbound HTTPS to OpenAI; no inbound port is opened.
- Store the tunnel runtime API key outside repository and MCP configuration files.
- Remove tunnel and gateway credentials from downstream process environments.
- Restrict project activation and command working directories to configured roots.
- Never accept shell strings.
- Preserve MCP read-only and destructive annotations so ChatGPT can confirm writes appropriately.
- Keep exact tool allowlists and reject unknown tools.
- Cap command output, MCP results, retained logs, and execution time.
- Log concise metadata without secrets, source contents, or full request bodies.
- Keep the Developer Mode plugin private.

This is still a trusted-user development tool: allowed executables run with the local user's permissions.

## 8. One-time setup

Setup must be idempotent and resumable.

It should:

1. detect Linux, macOS, or Windows;
2. verify Node.js and install or locate Local Dev;
3. install or locate the latest supported `tunnel-client`;
4. detect Serena, RTK, and Chrome DevTools MCP;
5. write or repair `~/.local-dev/config.json`;
6. validate every selected MCP server and tool allowlist;
7. guide the user through creating or selecting an OpenAI Secure MCP Tunnel;
8. initialize a named `tunnel-client` stdio profile for the Local Dev server;
9. run `tunnel-client doctor --explain`;
10. install Local Dev and `tunnel-client` as auto-starting user services;
11. open ChatGPT Plugins and show the exact plugin creation steps;
12. wait for tool discovery and run a harmless smoke test;
13. print one readiness summary.

Setup reruns handle repair, dependency changes, tunnel/profile changes, schema refresh guidance, and uninstall.

The unavoidable manual steps are OpenAI tunnel authorization and creating/selecting the private Developer Mode plugin in ChatGPT.

## 9. Repository shape

```text
chatgpt-local-dev-plugin/
├── src/
│   ├── index.ts
│   ├── registry.ts
│   ├── projects.ts
│   ├── dev.ts
│   ├── proxy.ts
│   ├── config.ts
│   └── setup.ts
├── tests/
│   ├── registry.test.ts
│   ├── projects.test.ts
│   ├── dev.test.ts
│   ├── proxy.test.ts
│   ├── setup.test.ts
│   └── e2e.test.ts
├── config.example.json
├── package.json
├── README.md
└── PLAN.md
```

Keep one registry map and direct functions. Do not add provider classes, plugin adapters, lifecycle frameworks, or speculative abstractions.

## 10. Implementation phases

### Phase 1 — Developer Mode compatibility gate

Implement the minimal benchmark server, connect it through Secure MCP Tunnel, record behavior, and remove the benchmark tools after success.

### Phase 2 — Core local MCP server

Implement the server, registry, project tools, foreground commands, background process handling, bounded output, and graceful shutdown.

### Phase 3 — Generic MCP proxy

Implement stdio loading, paginated discovery, filtering, namespacing, annotation/schema preservation, forwarding, project hooks, and shutdown.

### Phase 4 — Setup UX

Implement dependency detection, configuration, tunnel-client profile creation, health checks, auto-start services, ChatGPT handoff, repair, and uninstall.

### Phase 5 — End to end

From ChatGPT Developer Mode:

1. open a fixture project;
2. inspect and edit it through Serena;
3. run tests and inspect Git diff;
4. start a fixture web server;
5. inspect it through Chrome DevTools;
6. stop the server;
7. commit only after explicit instruction;
8. restart the machine and repeat a smoke test without manual service startup.

## 11. Test matrix and definition of done

Tests must cover:

- exact, prefix, ambiguous, path, and missing project discovery;
- traversal limits, ignored directories, permission errors, and symlinks;
- foreground command success, failure, timeout, truncation, and `shell: false`;
- background start, poll, URL detection, stop, and cleanup;
- MCP pagination, filtering, namespacing, schema/annotation preservation, forwarding, failure, and shutdown;
- project-open hooks;
- setup rerun, repair, service installation, and uninstall;
- tunnel-client disconnect and reconnect behavior;
- complete coding and browser workflows through the private plugin.

The project is done when:

- one guided setup produces a usable private Developer Mode plugin;
- each tool call returns its result directly without model-driven polling;
- every selected downstream MCP tool is exposed without server-specific code;
- five native tools remain the only custom development tools;
- adding a stdio MCP server requires configuration, not source changes;
- Local Dev and `tunnel-client` start automatically;
- the full coding and browser workflow passes after reboot;
- no public ingress, Actions layer, OAuth implementation, database, or multi-session framework exists.

## 12. Known limitations

- Developer Mode plugins are intended for developers and carry elevated write-tool risk.
- The plugin must be explicitly enabled in a conversation.
- Tool-list changes require refreshing the plugin.
- The computer and `tunnel-client` must be online.
- Exact practical duration and output limits must be established by the compatibility gate.
- Concurrent conversations may interfere because version one has one active project and one background process.
- Arbitrary allowed executables run with the local user's permissions.

## References

- ChatGPT Developer mode: https://developers.openai.com/api/docs/guides/developer-mode
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Build an MCP server: https://developers.openai.com/apps-sdk/build/mcp-server
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Serena: https://github.com/oraios/serena
- RTK: https://github.com/rtk-ai/rtk
- Chrome DevTools MCP: https://github.com/ChromeDevTools/chrome-devtools-mcp
