# ChatGPT progress and narration

Local Dev uses two complementary visibility mechanisms.

## Assistant narration

The MCP server instructions tell ChatGPT to:

- announce the immediate next action before a multi-step tool workflow;
- report meaningful milestones or provide an update after roughly three tool calls;
- announce commands and browser actions that may take more than ten seconds;
- avoid both long silent periods and noisy narration of trivial reads.

This is the guaranteed fallback when a client does not request or render MCP progress notifications.

## Tool activity and progress

Every tool exposes the standard OpenAI invocation labels:

- `openai/toolInvocation/invoking`
- `openai/toolInvocation/invoked`

When the MCP client supplies `_meta.progressToken`, Local Dev also emits standard `notifications/progress` messages. Native tools report:

- project search, hook, binding, and activation phases;
- redacted command labels and five-second foreground-command heartbeats;
- command-batch step numbers and executable summaries;
- background-process shutdown phases;
- Git diff collection phases.

Proxied MCP progress is relayed to the original client. Notification delivery is best-effort: a client that ignores or rejects a progress message does not cause the underlying tool call to fail.

Command progress deliberately avoids exposing likely credentials. Values following token-, password-, secret-, authorization-, credential-, and API-key-like flags are replaced with `••••`. Inline source passed through flags such as `node -e` is displayed as `<inline code>`.

## Verification

Run the full repository check:

```sh
npm run check
```

The stdio integration suite verifies a real five-second command heartbeat, project-opening phases, batch step messages, monotonic progress values, downstream progress relay, and the narration instructions returned during MCP initialization.
