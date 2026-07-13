# Local Dev Plugin

A planned private ChatGPT Developer Mode plugin for working directly on projects on this computer through native MCP tools and OpenAI Secure MCP Tunnel.

```text
ChatGPT Developer Mode
  → OpenAI Secure MCP Tunnel
  → tunnel-client
  → Local Dev stdio MCP server
  → project tools / terminal / Serena / Chrome DevTools MCP
```

The design intentionally avoids:

- GPT Actions and OpenAPI generation;
- public HTTP ingress or Cloudflare;
- custom OAuth;
- OpenAI model API calls;
- Codex as a runtime dependency;
- model-driven job polling.

The first milestone is a small compatibility gate proving direct MCP results, chained tool use, long-running calls, confirmations, reconnect behavior, and tool refresh through a private Developer Mode plugin.

See [`PLAN.md`](./PLAN.md) for the complete implementation plan, setup UX, security model, tool contracts, phases, tests, and definition of done.

No production code has been implemented yet.
