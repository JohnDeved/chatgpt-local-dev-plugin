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

Phase 1 is normally a human compatibility gate. The repository owner explicitly directed implementation to continue on 2026-07-13 after the exact ping, structured echo, tool refresh, and four-call chain passed through the real tunnel. Remaining Phase 1 rows stay unverified and must not be described as passing.

## Prohibited fallbacks

Do not add GPT Actions, an OpenAPI layer, public ingress, model-driven polling, custom OAuth, Cloudflare, OpenAI model API calls, a Codex runtime dependency, a database, multi-user state, shell command strings, per-server adapters, or speculative frameworks. Do not hide a failed compatibility result behind another transport or polling layer.

Do not claim completion from unit/integration tests alone; Phase 6 requires real-environment and reboot evidence.

## Current task

Complete Phase 6: run setup against the real environment, exercise the coding and browser workflow through the private plugin, verify the diff, repeat the required smoke workflow after reboot, and record evidence without exposing credentials.
