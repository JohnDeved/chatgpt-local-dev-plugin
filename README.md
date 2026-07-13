# Local Dev Plugin

A planned private ChatGPT Developer Mode plugin that works directly on local projects through native MCP tools and OpenAI Secure MCP Tunnel.

```text
ChatGPT Developer Mode
  → OpenAI Secure MCP Tunnel
  → tunnel-client
  → Local Dev stdio MCP server
      → native project/command tools
      → selected MCP servers from ~/.codex/config.toml
```

Local Dev reuses the MCP registry shared by the ChatGPT desktop app, Codex CLI, and Codex IDE extension. Its own config stores only project roots, selected server IDs, aliases, and project hooks.

The design avoids GPT Actions, OpenAPI generation, public ingress, custom OAuth, OpenAI model API calls, a Codex runtime dependency, and model-driven polling.

The first milestone is a compatibility gate proving direct MCP results, chaining, long-running calls, confirmations, reconnect behavior, and tool refresh through a private plugin.

See [`PLAN.md`](./PLAN.md) for the concise implementation plan.

No production code has been implemented yet.
