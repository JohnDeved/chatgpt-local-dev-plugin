# Shared configuration and proxy

Local Dev reads the global Codex MCP registry from `~/.codex/config.toml` and Local Dev selections from `~/.local-dev/config.json`. Runtime access is read-only. Missing Local Dev configuration means no roots, hooks, or selected downstream servers; a missing Codex configuration is an error.

The accepted Codex fields follow the current official MCP configuration reference: stdio `command`, `args`, `env`, `env_vars`, `cwd`, and `experimental_environment`; HTTP `url`, `auth`, bearer/header references, OAuth resource, and scopes; common enabled/required, timeouts, filters, and approval modes. Unknown Codex fields are ignored so newer Codex versions remain readable. Disabled entries are not loaded.

Local Dev uses this versioned shape:

```json
{
  "version": 1,
  "projectRoots": ["/absolute/project/root"],
  "selectedServers": [{ "id": "serena", "alias": "code" }],
  "projectOpenHooks": [
    { "projectRoot": "/absolute/project/root", "argv": ["npm", "install"] }
  ]
}
```

Project roots must be absolute and unique. Server ids and aliases must be unique. Hooks use argument arrays only; shell strings are rejected. Local Dev rejects unknown fields to catch misspellings.

An HTTP server explicitly configured with `auth = "oauth"` or `auth = "chatgpt"` is skipped when it has no independently reusable bearer or header credential configuration. A required selected server in that state fails loading. Credential values are never included in configuration error messages.

At startup, Local Dev connects only explicitly selected servers. It follows every `tools/list` page, applies `enabled_tools` and `disabled_tools`, and exposes retained tools as `<alias>.<tool>`. Input/output schemas, descriptions, titles, annotations, and metadata are preserved. Stdio child environments use the SDK's safe defaults plus configured values; HTTP bearer and environment-backed headers are resolved only when connecting and are never returned in tool errors.

A selected server with `required = true` fails startup when it cannot connect or complete discovery. An unavailable optional server is omitted from that static tool list. If a discovered server later becomes unavailable, calls return the stable `DOWNSTREAM_UNAVAILABLE` error without a raw stack trace or credential detail. Restart Local Dev and refresh the ChatGPT plugin after changing the shared registry or selections.
