# Local activity, ChatGPT progress, and narration

## Independent local visibility

The native macOS menu-bar app is the primary visibility mechanism. `src/activity.ts` records requests, decisions, execution, output, results, and errors independently of client progress tokens or assistant narration. It also enforces approval and pause policy before dispatch. See [the menu-bar guide](./menu-bar.md).

The local archive is unredacted and contains complete captured payloads. It is not automatically exported or included in model-facing tool results. It is a local execution-boundary record, not a claim to observe every internal action of an arbitrary downstream tool.

## Assistant narration

Server instructions still ask ChatGPT to announce multi-step work, identify tools and command arguments, and provide meaningful milestone updates. Those instructions are useful but cannot guarantee that an assistant will narrate. The local interface does not depend on them.

## Optional MCP activity and progress

Tools continue to expose `openai/toolInvocation/invoking` and `openai/toolInvocation/invoked` labels. When the MCP client provides `_meta.progressToken`, the server also sends `notifications/progress`.

Unknown-duration work uses strictly increasing activity counters with no invented total. A five-second heartbeat therefore cannot reach a false 100% completion or repeat a saturated progress value. Native tools still report project phases, exact command arguments, command-batch steps, shutdown activity, and diff collection. Downstream progress messages and available fractions remain relayed for compatibility; their full reported values are also recorded locally.

Notification delivery is best-effort and does not replace the local archive. Clients can ignore or decline notifications without making otherwise successful work fail. The server checks returned tool-error results before choosing its final progress label.

Command arguments sent in progress notifications are transmitted to the MCP client; they are not merely displayed on the local machine. The complete local execution environment and diagnostic archive are separate and are not automatically attached to those notifications. Existing credential-path protections on model-facing `dev.diff` output are unchanged.

## Verification

Run:

```sh
npm run check
```

The stdio suite covers project phases, command heartbeats, batch messages, downstream progress relay, exact command display, and initialization instructions. The activity suite additionally verifies capture without a progress token, hundreds of strictly increasing updates, full local output beyond the model-facing tail, and error-aware terminal states. The native build checks archive integrity and layout separately.

Passing protocol tests alone does not establish that the real tunnel, native approval interaction, login startup, or reboot behavior has been verified. Report those observations independently.
