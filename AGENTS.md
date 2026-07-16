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

## Polishing workflow

Run `npm run polish` before publishing cleanup or refactoring work. It runs the repository check, gates only Fallow findings introduced by the current working tree, then prints the full dead-code, duplication, and health report.

Use the Ponytail full ladder before editing: understand the complete flow, then delete or reuse before adding; prefer the standard library, native platform, and already-installed dependencies; stop at the smallest safe change. Do not split files or add abstractions solely to improve a metric. Non-trivial logic keeps one runnable regression check. The source ruleset is `DietrichGebert/ponytail`; Fallow is pinned as a development dependency for deterministic local runs.

## Hard checkpoint rule

Phase 1 is normally a human compatibility gate. The repository owner explicitly directed implementation to continue on 2026-07-13 after the exact ping, structured echo, tool refresh, and four-call chain passed through the real tunnel. Remaining Phase 1 rows stay unverified and must not be described as passing.

## Prohibited fallbacks

Do not add GPT Actions, an OpenAPI layer, public ingress, model-driven polling, custom OAuth, Cloudflare, OpenAI model API calls, a Codex runtime dependency, a database, multi-user state, shell command strings, per-server adapters, or speculative frameworks. Do not hide a failed compatibility result behind another transport or polling layer.

Do not claim completion from unit/integration tests alone; Phase 6 requires real-environment evidence. Reboot evidence may only be omitted after an explicit repository-owner waiver, and the omission must not be represented as a pass.

## Current task

Phase 6 was completed on 2026-07-13 with real-environment setup, coding/browser workflow, signed-in private-plugin calls, and diff verification. The repository owner explicitly directed that macOS not be rebooted; `docs/verification.md` records that scope waiver without claiming a reboot pass.
