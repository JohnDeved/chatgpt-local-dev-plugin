# Phase 1 compatibility checkpoint

This document is the hard human gate between Phase 1 and Phase 2. Automated local tests are recorded separately from real ChatGPT -> Secure MCP Tunnel observations. **Every real-tunnel result is UNVERIFIED until the supervising human runs it. Never infer a pass from local tests.**

## Pass criteria

Proceed only when all real-tunnel rows pass with direct MCP results, exact structured content, no model-driven polling, reliable chaining, expected write confirmation, bounded output, successful tool refresh, and successful reconnect behavior. A failure must be investigated in this architecture; do not add a public endpoint, GPT Action, OpenAPI layer, or polling fallback.

## Automated local evidence

Run from a clean checkout with a temporary or otherwise non-sensitive environment:

```sh
npm ci
npm run check
```

| Check | Status | Evidence |
| --- | --- | --- |
| Formatting | VERIFIED | `npm run format:check` is part of `npm run check`. |
| Policy lint | VERIFIED | Rejects prohibited runtime/network imports, stack access, stdout logging, dependency drift, and Node-range drift. |
| Typecheck/build | VERIFIED | TypeScript `5.8.3`, ESM, Node `>=24.18.0 <25.0.0`. |
| Unit/integration tests | VERIFIED | All 23 tests pass on Node 24.18.0 using temporary homes and spawned stdio servers without real credentials. |
| Real ChatGPT/tunnel behavior | UNVERIFIED | Must be completed below by the supervising human. |

## Checkpoint setup

Use the exact profile and app names below so the prompts are copyable:

- tunnel-client profile: `local-dev-compat`
- ChatGPT draft app: `Local Dev Compatibility Gate`
- server command: `node /ABSOLUTE/PATH/chatgpt-local-dev-plugin/dist/server.js`

Build and start the profile as documented in the README. Verify `tunnel-client doctor --profile local-dev-compat --explain` reports healthy/ready before testing. Keep the runtime key only in the local shell or existing managed credential store.

For each tool call, expand the ChatGPT tool card and compare the actual input and output JSON, not only the assistant prose. Record whether ChatGPT made exactly the requested number of calls. A repeated call used as polling is a failure.

## Exact single-call inputs and outputs

### Ping

Prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_ping` exactly once with `{"nonce":"gate-001"}`. Do not use built-in tools or call any other tool. After the call, print the raw `structuredContent` JSON exactly.

Expected `structuredContent`:

```json
{
  "ok": true,
  "tool": "compat_ping",
  "data": {
    "pong": true,
    "nonce": "gate-001"
  },
  "error": null
}
```

### Structured echo

Prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_echo` exactly once with `{"value":{"alpha":1,"beta":["two",true],"nested":{"null":null}}}`. Do not use built-in tools or call any other tool. After the call, print the raw `structuredContent` JSON exactly.

Expected `structuredContent`:

```json
{
  "ok": true,
  "tool": "compat_echo",
  "data": {
    "value": {
      "alpha": 1,
      "beta": [
        "two",
        true
      ],
      "nested": {
        "null": null
      }
    },
    "serializedBytes": 54
  },
  "error": null
}
```

| Test | Status | Exact calls expected | Observed input/output | Notes |
| --- | --- | ---: | --- | --- |
| Ping exact input/output | UNVERIFIED | 1 |  |  |
| Structured echo exact input/output | UNVERIFIED | 1 |  |  |

## Four-call chain

Start with a newly started benchmark server so the sequence is `0`.

Prompt:

> Use only the Local Dev Compatibility Gate app. Make exactly four sequential MCP calls and no others: (1) `compat_sequence_increment` with `{"by":1}`, (2) `compat_sequence_increment` with `{"by":2}`, (3) `compat_sequence_increment` with `{"by":4}`, and (4) `compat_sequence_read` with `{}`. Do not poll. After all four return, report each raw `structuredContent.data` object in order.

Expected data in order:

| Call | Tool | Input | Expected `data` |
| ---: | --- | --- | --- |
| 1 | `compat_sequence_increment` | `{"by":1}` | `{"value":1,"incrementedBy":1}` |
| 2 | `compat_sequence_increment` | `{"by":2}` | `{"value":3,"incrementedBy":2}` |
| 3 | `compat_sequence_increment` | `{"by":4}` | `{"value":7,"incrementedBy":4}` |
| 4 | `compat_sequence_read` | `{}` | `{"value":7}` |

| Status | Observed call count | Observed values | Model polling observed? | Notes |
| --- | ---: | --- | --- | --- |
| UNVERIFIED |  |  |  |  |

## Seven-call chain

Restart the benchmark server first so the sequence returns to `0`.

Prompt:

> Use only the Local Dev Compatibility Gate app. Make exactly seven sequential MCP calls and no others: (1) `compat_sequence_read` with `{}`, (2) `compat_sequence_increment` with `{"by":1}`, (3) `compat_sequence_increment` with `{"by":2}`, (4) `compat_sequence_read` with `{}`, (5) `compat_sequence_increment` with `{"by":4}`, (6) `compat_sequence_increment` with `{"by":8}`, and (7) `compat_sequence_read` with `{}`. Do not poll. After all seven return, report each raw `structuredContent.data` object in order.

Expected data in order:

| Call | Tool | Expected `data` |
| ---: | --- | --- |
| 1 | `compat_sequence_read` | `{"value":0}` |
| 2 | `compat_sequence_increment` | `{"value":1,"incrementedBy":1}` |
| 3 | `compat_sequence_increment` | `{"value":3,"incrementedBy":2}` |
| 4 | `compat_sequence_read` | `{"value":3}` |
| 5 | `compat_sequence_increment` | `{"value":7,"incrementedBy":4}` |
| 6 | `compat_sequence_increment` | `{"value":15,"incrementedBy":8}` |
| 7 | `compat_sequence_read` | `{"value":15}` |

| Status | Observed call count | Observed values | Model polling observed? | Notes |
| --- | ---: | --- | --- | --- |
| UNVERIFIED |  |  |  |  |

## Long-running calls

Run each duration in a separate turn. The server returns no intermediate result and does not expose elapsed wall-clock time, so the structured result is deterministic. Use the tool-card timestamps or an external stopwatch only for observation.

Prompts:

> Use only the Local Dev Compatibility Gate app. Call `compat_sleep` exactly once with `{"durationMs":30000}`. Do not poll, estimate, or call any other tool. After it returns, print the raw `structuredContent` JSON exactly.

> Use only the Local Dev Compatibility Gate app. Call `compat_sleep` exactly once with `{"durationMs":60000}`. Do not poll, estimate, or call any other tool. After it returns, print the raw `structuredContent` JSON exactly.

> Use only the Local Dev Compatibility Gate app. Call `compat_sleep` exactly once with `{"durationMs":120000}`. Do not poll, estimate, or call any other tool. After it returns, print the raw `structuredContent` JSON exactly.

Expected form, with the requested duration substituted:

```json
{
  "ok": true,
  "tool": "compat_sleep",
  "data": {
    "requestedMs": 30000,
    "completed": true
  },
  "error": null
}
```

| Duration | Status | Exact calls expected | Observed duration | Model polling observed? | Exact output matched? | Notes |
| ---: | --- | ---: | --- | --- | --- | --- |
| 30 seconds | UNVERIFIED | 1 |  |  |  |  |
| 60 seconds | UNVERIFIED | 1 |  |  |  |  |
| 120 seconds | UNVERIFIED | 1 |  |  |  |  |

## Write confirmation and harmless write

Use a new conversation so no remembered approval applies. Confirm that ChatGPT presents a write-action confirmation before execution. The tool creates a new file only under `~/.local-dev/compatibility-writes` and refuses to overwrite it.

Prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_write_marker` exactly once with `{"marker":"checkpoint-001","content":"phase-1-write-ok","confirm":true}`. Do not use any other tool. Let ChatGPT show its normal write confirmation and wait for my approval. After approval and execution, print the raw `structuredContent` JSON exactly.

Expected `structuredContent`:

```json
{
  "ok": true,
  "tool": "compat_write_marker",
  "data": {
    "relativePath": ".local-dev/compatibility-writes/checkpoint-001.txt",
    "bytes": 16,
    "sha256": "12cb0cc4412b2ec38d00da1abef81e08a74db31a31b47f40473c04c43d845032",
    "created": true
  },
  "error": null
}
```

Then repeat the identical prompt. The second call must still require confirmation in a new conversation and must return:

```json
{
  "ok": false,
  "tool": "compat_write_marker",
  "data": null,
  "error": {
    "code": "ALREADY_EXISTS",
    "message": "Marker already exists; choose a new marker name."
  }
}
```

| Test | Status | Confirmation shown before call? | Exact output matched? | File content verified locally? | Notes |
| --- | --- | --- | --- | --- | --- |
| First marker creation | UNVERIFIED |  |  |  |  |
| Duplicate overwrite refusal | UNVERIFIED |  |  |  |  |

## Bounded large output

The echo limit is the serialized JSON value size, capped at `16384` bytes. The optional `repeat` input exists only to make this boundary reproducible without pasting a huge value.

Boundary-success prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_echo` exactly once with `{"value":"x","repeat":16382}`. Do not call any other tool. In the tool output, verify `data.serializedBytes` is `16384` and that the call is not an error. Do not reproduce the full repeated string in prose.

Over-limit prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_echo` exactly once with `{"value":"x","repeat":16383}`. Do not call any other tool. Print the raw `structuredContent` JSON exactly.

Expected over-limit `structuredContent`:

```json
{
  "ok": false,
  "tool": "compat_echo",
  "data": null,
  "error": {
    "code": "OUTPUT_TOO_LARGE",
    "message": "Echo payload exceeds 16384 bytes."
  }
}
```

| Test | Status | Exact calls expected | Observed bytes/error | Output remained bounded? | Notes |
| --- | --- | ---: | --- | --- | --- |
| 16384-byte boundary success | UNVERIFIED | 1 |  |  |  |
| 16385-byte rejection | UNVERIFIED | 1 |  |  |  |

## Tool refresh

1. Stop `tunnel-client run --profile local-dev-compat`.
2. Restart it with the refresh probe enabled:

```sh
LOCAL_DEV_COMPAT_ENABLE_REFRESH_PROBE=1 \
  tunnel-client run --profile local-dev-compat
```

3. In **Settings -> Plugins -> Local Dev Compatibility Gate**, use the app refresh control.
4. Start a new Developer Mode conversation with the app selected.

Prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_refresh_probe` exactly once with `{}`. Do not use another tool. Print the raw `structuredContent` JSON exactly.

Expected `structuredContent`:

```json
{
  "ok": true,
  "tool": "compat_refresh_probe",
  "data": {
    "token": "refresh-v2"
  },
  "error": null
}
```

| Status | Probe absent before refresh? | Probe present after refresh? | Exact call/output matched? | Notes |
| --- | --- | --- | --- | --- |
| UNVERIFIED |  |  |  |  |

After recording the result, restart `tunnel-client` without the environment variable and refresh the app again to return to the six-tool list.

## Reconnect after restarting only the stdio server

Start with `tunnel-client run --profile local-dev-compat` healthy. Call ping once with nonce `before-server-restart`. In another terminal, locate only this benchmark child and terminate it:

```sh
pgrep -fl 'node /ABSOLUTE/PATH/chatgpt-local-dev-plugin/dist/server.js'
kill -TERM <SERVER_PID_FROM_THE_PREVIOUS_COMMAND>
```

Do not kill unrelated Node processes. Observe whether `tunnel-client` recreates/reconnects the stdio child. Then use this prompt:

> Use only the Local Dev Compatibility Gate app. Call `compat_ping` exactly once with `{"nonce":"after-server-restart"}`. Do not call any other tool. Print the raw `structuredContent` JSON exactly.

Expected data after recovery:

```json
{
  "ok": true,
  "tool": "compat_ping",
  "data": {
    "pong": true,
    "nonce": "after-server-restart"
  },
  "error": null
}
```

| Status | Child restart/reconnect observed? | Exact call/output matched? | Recovery required manual tunnel restart? | Notes |
| --- | --- | --- | --- | --- |
| UNVERIFIED |  |  |  |  |

## Reconnect after restarting tunnel-client

1. With a successful ping already recorded, stop `tunnel-client run --profile local-dev-compat` with Ctrl-C.
2. Start it again:

```sh
tunnel-client doctor --profile local-dev-compat --explain
tunnel-client run --profile local-dev-compat
```

3. Use this prompt in the existing conversation, then repeat in a new conversation if the existing one has stale tool state:

> Use only the Local Dev Compatibility Gate app. Call `compat_ping` exactly once with `{"nonce":"after-tunnel-restart"}`. Do not call any other tool. Print the raw `structuredContent` JSON exactly.

| Status | Existing conversation recovered? | New conversation recovered? | Exact call/output matched? | Notes |
| --- | --- | --- | --- | --- |
| UNVERIFIED |  |  |  |  |

## Human decision

| Gate | Status | Decision/notes |
| --- | --- | --- |
| Exact inputs/outputs | UNVERIFIED |  |
| Four-call chain | UNVERIFIED |  |
| Seven-call chain | UNVERIFIED |  |
| 30/60/120-second calls | UNVERIFIED |  |
| Write confirmations | UNVERIFIED |  |
| Bounded large output | UNVERIFIED |  |
| Tool refresh | UNVERIFIED |  |
| Server reconnect | UNVERIFIED |  |
| tunnel-client reconnect | UNVERIFIED |  |
| **Proceed to Phase 2** | **NO - HUMAN CHECKPOINT NOT COMPLETED** | A human must explicitly change this only after every row passes. |
