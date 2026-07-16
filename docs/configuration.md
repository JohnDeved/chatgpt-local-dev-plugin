# Shared configuration and proxy

Local Dev reads the global Codex MCP registry from `~/.codex/config.toml` and Local Dev selections from `~/.local-dev/config.json`. Runtime access is read-only. Missing Local Dev configuration means no roots, hooks, or selected downstream servers; a missing Codex configuration is an error.

The accepted Codex fields follow the current official MCP configuration reference: stdio `command`, `args`, `env`, `env_vars`, `cwd`, and `experimental_environment`; HTTP `url`, `auth`, bearer/header references, OAuth resource, and scopes; common enabled/required, timeouts, filters, and approval modes. Unknown Codex fields are ignored so newer Codex versions remain readable. Disabled entries are not loaded.

Local Dev uses this versioned shape:

```json
{
  "version": 1,
  "projectRoots": ["/absolute/project/root"],
  "browserOriginPolicy": "ask",
  "approvedBrowserOrigins": ["https://chatgpt.com"],
  "selectedServers": [
    { "id": "serena", "alias": "code" },
    { "id": "node_repl", "alias": "chrome" }
  ],
  "projectOpenHooks": [
    { "projectRoot": "/absolute/project/root", "argv": ["npm", "install"] }
  ],
  "projectBindings": [
    {
      "server": "code",
      "tool": "activate_project",
      "arguments": { "project": "${projectPath}" }
    }
  ]
}
```

Project roots must be absolute and unique. `project.open` matches directories by folder name, `package.json` name, or Git remote repository name, so renamed worktrees can still be opened by their canonical project name. Metadata reads are local and bounded. Server ids and aliases must be unique. Hooks use argument arrays only; shell strings are rejected. Local Dev rejects unknown fields to catch misspellings.

`browserOriginPolicy` controls Browser Use origin access. `"ask"` keeps the upstream confirmation flow for unknown origins, while exact entries in `approvedBrowserOrigins` are accepted automatically. `"allow-all"` automatically accepts every valid empty Browser Use `access_browser_origin` request, so navigation works across websites without per-origin configuration or restarts. The policy never auto-accepts other elicitation forms or other browser tools. `approvedBrowserOrigins` entries must be unique HTTP or HTTPS origins without paths.

`projectBindings` synchronizes project-aware downstream MCP servers after Local Dev opens a project. Each binding references a selected server alias and an original downstream tool name. Its JSON-object arguments may contain `${projectPath}` anywhere in string values; Local Dev substitutes the resolved active-project path recursively, invokes the exposed `<server>.<tool>`, and returns bounded per-binding status and warnings in the `project.open` result. Bindings are generic configuration, not server-specific adapters. Missing or failing binding tools do not prevent Local Dev from opening the project.

`inlineMedia` is an explicit per-server opt-in for MCP tools that return an absolute local media path as text instead of a native media content block. Local Dev preserves the text result, appends a canonical MCP `image` or `audio` block, and adds a compact media-count `structuredContent` value when the downstream result has none. A file is included only when it resolves inside an allowlisted absolute root, matches a supported media signature, and does not exceed `maxBytes` (5 MiB by default, 25 MiB maximum). Native MCP media blocks pass through unchanged. Use the optional non-empty `tools` list to scope conversion to specific original downstream tool names; omitting it enables all tools on that selected server. Embedded-UI metadata from downstream tools is stripped. Keep roots narrow; `/tmp` covers Chrome DevTools MCP screenshots on macOS.

An HTTP server explicitly configured with `auth = "oauth"` or `auth = "chatgpt"` is skipped when it has no independently reusable bearer or header credential configuration. A required selected server in that state fails loading. Credential values are never included in configuration error messages.

At startup, Local Dev connects only explicitly selected servers. It follows every `tools/list` page, applies `enabled_tools` and `disabled_tools`, and exposes retained tools as `<alias>.<tool>`. Input/output schemas, descriptions, titles, annotations, metadata, and native MCP media content are preserved. Stdio child environments use the SDK's safe defaults plus configured values; HTTP bearer and environment-backed headers are resolved only when connecting and are never returned in tool errors.

When the selected server id is `node_repl` and its configured command is the bundled `node_repl` executable, Local Dev transparently launches it beneath two sibling OpenAI-signed Node processes. This preserves MCP stdio while satisfying the packaged Chrome extension bridge's native-pipe ancestry check. Codex configuration can remain in its app-generated direct form, and already wrapped or unrelated stdio servers are left unchanged.

A selected server with `required = true` fails startup when it cannot connect or complete discovery. An unavailable optional server is omitted from that static tool list. If a discovered server later becomes unavailable, calls return the stable `DOWNSTREAM_UNAVAILABLE` error without a raw stack trace or credential detail. Restart Local Dev and refresh the ChatGPT plugin after changing the shared registry or selections.
