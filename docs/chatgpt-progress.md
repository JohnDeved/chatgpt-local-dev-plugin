# ChatGPT progress and narration

Local Dev uses two complementary visibility mechanisms.

## Assistant narration

The MCP server instructions tell ChatGPT to:

- announce the immediate next action before a multi-step tool workflow;
- report meaningful milestones or provide an update after roughly three tool calls;
- name the exact Local Dev tool and command arguments being used;
- announce commands and browser actions that may take more than ten seconds;
- avoid both long silent periods and noisy narration of trivial reads.

This is the guaranteed fallback when a client does not request or render MCP progress notifications.

## Tool activity and progress

Every tool exposes the standard OpenAI invocation labels:

- `openai/toolInvocation/invoking`
- `openai/toolInvocation/invoked`

When the MCP client supplies `_meta.progressToken`, Local Dev also emits standard `notifications/progress` messages. Native tools report:

- project search, hook, binding, and activation phases;
- exact command paths and arguments with five-second foreground-command heartbeats;
- command-batch step numbers and complete command summaries;
- background-process shutdown phases;
- Git diff collection phases.

Proxied MCP progress is relayed to the original client. Notification delivery is best-effort: a client that ignores or rejects a progress message does not cause the underlying tool call to fail.

Command progress shows the complete executable path and every argument exactly as Local Dev received them, including inline source and credential-like values. Progress messages are forwarded without normalization or truncation. Separate `dev.diff` handling for recognized credential-file paths remains unchanged because those file contents would be transmitted into the ChatGPT conversation rather than only displayed on the local machine.

## Verification

Run the full repository check:

```sh
npm run check
```

The stdio integration suite verifies a real five-second command heartbeat, project-opening phases, batch step messages, monotonic progress values, downstream progress relay, exact command display, and the narration instructions returned during MCP initialization.
