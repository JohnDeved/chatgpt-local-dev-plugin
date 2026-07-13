# Repository Agent Contract

## Architecture invariants

The only supported architecture is:

```text
ChatGPT Developer Mode
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client user service
  -> Local Dev stdio MCP server
```

Local Dev opens no public listener. The tunnel is outbound-only transport. MCP tool calls return directly to ChatGPT.

## Repository-wide check

Run exactly this command before publishing any phase:

```sh
npm run check
```

It must pass formatting, policy lint, TypeScript typechecking, build, and tests in one invocation.

## Hard checkpoint rule

Phase 1 is a human compatibility gate. Stop after publishing the temporary benchmark server, automated tests, and checkpoint documentation. Do not begin Phase 2 until a human has run every real-tunnel row in `docs/compatibility.md`, replaced `UNVERIFIED` with observations, and explicitly approved continuation.

## Prohibited fallbacks

Do not add GPT Actions, an OpenAPI layer, public ingress, model-driven polling, custom OAuth, Cloudflare, OpenAI model API calls, a Codex runtime dependency, a database, multi-user state, shell command strings, per-server adapters, or speculative frameworks. Do not hide a failed compatibility result behind another transport or polling layer.

Do not implement shared-config loading, production native tools, downstream MCP proxying, setup automation, background services, or any Phase 2-6 behavior during the compatibility gate.

## Current task

Implement and maintain only Phase 1: the temporary stdio MCP compatibility benchmark, its tests, and the human checkpoint runbook. Real Secure MCP Tunnel observations remain `UNVERIFIED` until recorded by the supervising human.
