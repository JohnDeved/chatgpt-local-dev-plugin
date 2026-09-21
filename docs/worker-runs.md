# Worker runs, public updates, and local steering

The menu-bar Timeline groups local work into explicitly identified runs. A run has a goal, title, start marker, concise expandable tool steps, optional public updates, and an end marker with a reported outcome. The original activity archive and command/output panels remain available behind the summaries.

## Lifecycle contract

The server exposes three additional native tools:

- `run.start({ goal, title?, plan? })` begins a user-request workflow and returns its run ID. Call it before local work. The full goal is retained; an automatically derived heading is limited to 120 characters.
- `run.update({ runId, summary, kind?, acknowledgedSteeringIds?, goal? })` records a brief public plan, progress, or decision summary. Acknowledgements explicitly identify local steering messages already returned to the assistant. A revised goal can be recorded when the user changes direction.
- `run.finish({ runId, outcome, summary })` ends the run with `completed`, `failed`, or `cancelled`. Call it before the final answer. The summary must report what actually happened, including any incomplete checks.

These reporting tools do not execute arbitrary commands or change approval policy. They remain usable to communicate a plan or acknowledge steering when execution is paused. Actual tool and process dispatch still passes through Local Dev's approval, pause, and steering gates.

A run cannot finish while its tracked tool operations are active or steering remains unacknowledged. Its ending records the number of owned background processes still running; completing a coding task does not imply its development server was stopped. Local cancellation of a command and an assistant-reported cancelled run are distinct events.

If the assistant omits `run.start`, Local Dev records an **observed** run beginning with the first local tool call. It says **Goal not reported** rather than guessing the user's request. A later `run.start` supplies the goal without creating a duplicate run. If the assistant omits `run.finish`, the UI says **end not reported**. Inactivity never produces a synthetic successful ending. A runtime shutdown records interruption, not completion; a lost socket without a shutdown record leaves completion explicitly unknown.

Only client-supplied session metadata is used for automatic attribution. Session values are hashed for the internal owner key. If the client supplies no session identifier, the UI explains that attribution is limited to the runtime and concurrent chats cannot be reliably distinguished. An explicit run in the same context must be finished before a different explicit goal can start; this prevents silently merging unrelated work.

## Concise, expandable timeline

Open runs show their goal, start marker, latest public update, and a few recent steps. Completed runs collapse to the goal/title and outcome with visible start/end markers. Earlier updates and tool steps expand on demand. A tool row expands to its command panels, complete output, and raw details. Pending approvals remain visible even when they predate the recent-step limit.

Pre-upgrade records appear in **Earlier ungrouped activity**. They are not relabeled as completed runs or assigned invented goals. Existing full records are retained.

## Steering from the local app

The composer selects a specific connected, open run. Typing a message does not change permission policy or execute it as code. Selecting **Send** queues the text for inclusion in that run's next MCP tool response. The composer explicitly tells the user that this transmits the instruction to ChatGPT; this is not a local-only annotation.

There are three separate states:

1. **Queued**: the local runtime accepted the message. It has not yet appeared in a model-facing result.
2. **Included in tool response**: the message was attached to a tool-result envelope. This is not proof that the transport delivered it or that ChatGPT read it.
3. **Acknowledged by ChatGPT**: `run.update` identified the returned message ID and supplied a public response describing the next step. This is an acknowledgement, not proof every requested change was implemented.

Before another action starts, unacknowledged steering blocks dispatch. A request already executing may finish and carry the instruction in its response. Native commands check again at process-launch boundaries, so new batch steps do not continue past queued steering. Work already completed is not undone. Internal actions hidden inside an already-dispatched downstream tool cannot be interrupted at arbitrary boundaries by this mechanism; use the existing Stop controls when termination is required.

The message is appended to MCP `content`, not only hidden result metadata. The existing tool output and original structured fields remain intact. Native envelopes additionally declare and return a `localDevRun` field containing the run identity, goal, state, and pending steering, for clients that primarily surface structured results. Arbitrary downstream structured schemas are not changed. Unacknowledged instructions are repeated on subsequent responses until acknowledged. A stable message ID makes retries idempotent. Inputs are limited to 4,000 UTF-16 code units per message and 20 pending messages per run; limits reject rather than silently truncate input. Failed sends retain the draft.

**This does not start a ChatGPT response, inject a new chat turn, or wake a finished conversation.** With no subsequent tool request/result, a queued message cannot reach the assistant through this tool-only connection. The app provides a Copy action when no open run is available so the instruction can be entered in ChatGPT. Steering to finished or disconnected runs is rejected. Pending instructions from interrupted runs are not silently reassigned to another run.

Steering is treated as additional user input, not system instructions and not permission to bypass existing safeguards. Approval-required/auto-approve settings remain exclusively user controlled.

## Public updates, not private thinking

The timeline can show brief plans, progress explanations, and decision summaries explicitly published through `run.update`. They are labeled as public assistant summaries. The MCP tool server does not receive ChatGPT's private internal reasoning stream or all ordinary chat narration. The app neither extracts that stream nor fabricates a thinking transcript. If no public update was supplied, it says so.

## Activation and verification

Build and install with the normal repository workflow:

```sh
npm run check
npm run menu:install
```

An already-running server has to reconnect to load the new backend tools and instructions. The app detects an older connected runtime via its capabilities and displays **Run reporting needs the updated runtime** with a confirmed reconnect action. Restarting only the menu-bar app cannot hot-patch an old server. If the ChatGPT connection cached the tool list, refresh/reconnect it so `run.start`, `run.update`, and `run.finish` are discoverable. Do not represent installation alone as a verified migration of the current tunnel.

`test/runs.test.mjs` covers lifecycle, goals, explicit endings, active-operation guards, interruption, steering state transitions, duplicate retries, atomic acknowledgement validation, session isolation, input limits, public summary schemas, run attribution of nested work and late output, process-launch boundaries, and a real stdio MCP conversation against a temporary home.

Native checks exercise the run reducer, concise goal display, published updates, explicit end markers, disconnected states, steering labels, active target selection, and draft preservation. `scripts/run-native-smoke.mjs` launches a separate native client and MCP server in an isolated temporary home. The native ActivityStore sends a steering message over its real Unix socket; the test MCP client receives it, acknowledges it, and ends the run; the native client verifies the goal, acknowledgement, and completion. This runs as part of native checks and before installation and does not modify the user's actual approval settings or production tunnel.

These checks exercise real native model/IPC/MCP behavior, not automated clicking of every SwiftUI control and not a guarantee that a ChatGPT conversation will honor reporting instructions. Report production-tunnel evidence separately.


## Required work lists and steering implementation status (0.6)

`run.update` accepts `todos` and `steeringTasks`. Both use `queued`, `in_progress`, `paused`, `completed`, and `cancelled`, with optional outcome notes. To-dos have stable IDs and titles; a `steeringId` can link one to a direction in the same run. Delivery (`queued`, `returned`, `acknowledged`) remains separate from implementation. Acknowledging a direction never marks its work completed. Legacy directions without a work status display **Work status not reported**.

```json
{
  "runId": "<current run ID>",
  "summary": "Implementing the timeline while keeping verification queued.",
  "todos": [
    { "id": "timeline", "title": "Implement timeline", "status": "in_progress" },
    { "id": "verify", "title": "Verify and install", "status": "queued" }
  ],
  "steeringTasks": [
    { "id": "<acknowledged direction ID>", "status": "in_progress", "note": "Implementation started; not yet verified." }
  ]
}
```

The MCP dispatcher requires a declared goal and a nonempty to-do list before write-capable or otherwise substantive tools, including project activation that can execute hooks. Read-only reconnaissance is intentionally allowed before planning: bounded project reads/listings plus a conservative set of intrinsic version and Git-metadata commands can inspect the checkout without acquiring write access or prompting for command approval. Unknown commands fail closed into the normal write-capable path. `project.current`, `project.release`, `dev.poll`, `dev.stop`, and reporting tools are also exempt from the **list requirement** so a stale client can inspect/recover; existing pause, approval, and steering protections still apply. A missing cached `todos` field produces an explicit tool-refresh instruction, not silent execution or guessed tasks derived from narration.

Successful run completion requires a list and no unresolved tracked to-do or steering work. Failed/cancelled outcomes retain unfinished states. Cancellation is an explicit outcome, not equivalent to implementation. Outstanding items are included in subsequent model-visible tool responses and native structured envelopes. Updating another item never discards paused work. The whole work update is validated before changes are recorded; identical task updates do not duplicate task events.

`run.todoUpdated` and `steering.taskUpdated` events preserve reported work in the local archive and are reconstructed after viewer restart. Runtime interruption does not invent new task outcomes. Unfinished work remains visible in that interrupted run; it is not silently reassigned to an unrelated conversation after reconnect. A new run must explicitly adopt remaining scope.

The desktop shows a sticky latest public update, a to-do card, and separate steering work states. At wide widths these stay beside the timeline; the compact public update remains pinned on smaller windows and the full context is expandable. States are assistant reports, not independent proof of filesystem effects.

Backend activation is separate from UI installation. A connected older runtime without `workTracking` shows an explicit reconnect notice. A new runtime with no published list refuses new steering until the assistant has demonstrated that its reporting tools are ready. The owner confirms reconnect because managed processes may stop, then ChatGPT refreshes its tool definitions. The installer does not change approval policy or silently restart the tunnel.


## Ask tool (0.7)

Use `ask` when a real user preference or product choice materially changes the work. It is intentionally available after `run.start` and before the required substantive-work to-do list. Provide 2–6 choices with stable short IDs, readable labels, optional descriptions, and exactly one `recommended` option. Do not use Ask for routine command/edit permission, and do not ask the user to paste secrets.

When Auto-approve all is off, Ask waits for the user's explicit choice. When Auto-approve all is active, Local Dev exposes the question for 90 seconds, shows the recommended option and countdown, and then returns that recommendation only if the user did not answer. The user can override the recommendation throughout the countdown. Pause or disabling auto-approve suspends the fallback; custom text is accepted only when `allowOther` is true.

The backend owns the timeout, so hiding/closing the desktop panel does not silently cancel the decision period. Multiple questions have independent deadlines. Local controls only submit an option ID already present on that Ask, or bounded custom text. Ask responses are journaled with `source: user` or `source: auto-recommended` and remain distinct from approval events. Any command/edit that follows still passes through normal Local Dev admission and approval policy.

An older connected runtime advertises no `ask` capability. The 0.7 desktop shows an activation warning rather than pretending the tool exists. Reconnect is owner-confirmed because managed commands can stop; after reconnect ChatGPT must refresh its Local Dev tool definitions before `ask` appears in the conversation.


## Background-process lifecycle

Runs own background processes by their recorded run ID. The default `backgroundProcessPolicy` is `cleanup`: before `run.finish` can record a `completed` outcome, Local Dev asks every still-running process owned by that run to stop and requires confirmed termination. If any owned process remains, completion is rejected with `RUN_PROCESS_CLEANUP_UNCONFIRMED`; the run stays open so the process can be inspected or stopped explicitly. Other runs and unrelated OS processes are never included.

Use `backgroundProcessPolicy: "keep"` only when keeping a service alive is the intended result—for example, the task is specifically to start a preview/dev server for the user. The policy can be declared with `run.start` or changed with `run.update`. A completed `keep` run records the remaining process count instead of stopping those processes. Failed/cancelled outcomes retain their existing semantics and do not claim successful cleanup.


## To-do elapsed timing

Every reported run to-do keeps lifecycle timestamps (`createdAt`, `updatedAt`, and terminal `endedAt`) plus active-work timing state. `queued` has no timer. Entering `in_progress` starts `activeStartedAt`; leaving `in_progress` accumulates that segment into `activeElapsedMs`. `paused` freezes the accumulated value without counting pause time. Returning to `in_progress` starts a new segment on top of the prior accumulated duration. `completed` and `cancelled` freeze active time permanently unless the item is explicitly reopened. Older archived to-dos that predate active timing fields do not invent paused/completed work time; an old `in_progress` item may fall back to its most recent `updatedAt` as the current segment start.
