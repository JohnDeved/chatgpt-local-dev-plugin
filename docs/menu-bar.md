# Native macOS menu-bar companion

Local Dev has a native SwiftUI menu-bar app. Clicking its persistent status item opens Timeline, Processes, and Settings. The default timeline groups each tool call into one readable entry with its action, file or command, outcome, duration, and approval source. Inputs, recent output, command steps, and nested calls expand inline. Full results and original JSON remain available through optional detail views; the low-level event log is separate under Settings. It remains present while the runtime is idle or disconnected; closing the panel does not quit it. macOS menu-bar visibility and Login Items settings remain under the user's control.

## Build and install

Requirements: macOS 13 or later, the Xcode command-line tools / Swift compiler, and this repository's supported Node version. No additional JavaScript runtime dependencies are added.

```sh
npm run check
npm run menu:install
```

The installer builds and ad-hoc signs `build/menu-bar/Local Dev.app`, installs it in `~/Applications/Local Dev.app`, and opens it. An existing app with the same bundle identifier is retained as a timestamped backup. An unrelated app is not replaced.

Use Settings > Menu bar > Launch Local Dev at login to register the app with macOS. Alternatively, the explicit install-and-login command is:

```sh
node scripts/menu-bar.mjs --install --login --open
```

`npm run menu:check` compiles the app and runs native archive-integrity and layout checks. It explicitly reports SKIPPED on non-macOS platforms; that is not native verification.

An already-running tunnel still has the previous server code in memory. Building does not hot-patch it. Reconnect that runtime to load the new instrumentation after stopping or otherwise accounting for existing development processes. The installer deliberately does not terminate the tunnel, Vite, Chrome, or other user processes. It replaces the running companion app so the old single-instance UI cannot remain in memory after an update. While disconnected, the app checks the saved tunnel status and distinguishes an offline runtime from a running runtime that needs its activity connection refreshed. **Reconnect updated runtime…** uses the saved setup through fixed argv-based tunnel-client commands. It asks for explicit local confirmation before stopping/reconnecting the tunnel. The exact command transcript is available in Connection details. An optional `--request-reconnect` installer flag opens that confirmation; it does not approve it.

## Worker runs and steering

The Timeline now groups calls by a worker run with a displayed goal, a start marker, concise expandable steps, public plan/progress/decision updates, and an explicit ending. Completed runs and command details are collapsed by default. The local composer can queue steering to an open run; it distinguishes queue acceptance, inclusion in a tool response, and assistant acknowledgement. It cannot wake ChatGPT or start a new chat response. Private internal thinking is not available; only explicitly published summaries are shown.

The updated server advertises `run.start`, `run.update`, and `run.finish`. Older running servers require reconnection, and a cached ChatGPT tool list may require refresh. The app keeps pre-upgrade events under Earlier ungrouped activity without inventing run boundaries. See [the worker-run guide](./worker-runs.md) for exact lifecycle and delivery behavior.

## Approval policy

Approval-required is the default. Native commands and other tools not explicitly annotated read-only wait for a local decision before their invocation is dispatched. Configured project hooks and downstream project bindings are also individually recorded and gated. Read-only calls remain recorded but do not prompt. Tool annotations are descriptive, not a sandbox: a downstream server that falsely advertises read-only behavior is outside that guarantee.

The app offers **Auto-approve all**, with an explicit enabling confirmation. This accepts every approval controlled by Local Dev. A persistent banner and menu-bar badge indicate that it is on. Every accepted operation records whether the decision came from the user, the auto-approval policy, or read-only admission.

**Remember across restarts** is separate. Session-only auto-approval is not persisted. It can be selected while disconnected: the native app keeps the confirmed preference in memory and applies it when an activity connection is established. The UI labels it as waiting to apply, rather than silently switching it off or claiming the old runtime is already auto-approving. Enabling Remember is not required for offline selection. The global pause state is persisted and always overrides automatic approval, including already-queued requests. Turning auto-approval off affects operations not yet admitted; it does not terminate running commands.

Pure downstream approval forms (empty forms and recognized approval booleans) can be handled locally. Arbitrary information forms are forwarded to the upstream client and recorded, not populated with invented answers. Local settings do not bypass macOS permissions, browser extension security, external approval mechanisms, or configured access boundaries.

Approvals expire after 110 seconds at most and are cancelled when their parent request is aborted. Upstream clients may have shorter timeouts. A late decision cannot execute an expired request.

Policy changes have no MCP tool. They use the native app's local control connection. The socket is user-owned and permission-restricted, but **same-user programs can access it**. This is not an authorization sandbox against arbitrary code already executing as that macOS user. Agent instructions expressly prohibit changing or forging policy or the control channel.

## Full local records

The local journal captures exact tool requests, arguments, available metadata, returned results, thrown diagnostics, downstream calls/progress/stderr, process requests, the execution environment, separate stdout/stderr, process exits, approval decisions, and controls. Native command output includes the original bytes as base64 alongside incrementally decoded UTF-8 text. There is no masking or truncation in the local journal.

The model-facing command tail remains bounded. That limit does **not** discard the local full output. The app's live event index and paginated navigation are also separate from the complete archive: selecting a record loads the original bytes. The optional detail sheet provides Readable details, Full output, and Original JSON, copy/export controls, and previews for returned image blocks. The primary timeline is not an event-JSON list. The Output view is a readable stream with timestamps; Raw events preserves each captured payload, including original output bytes.

Archives live at `~/.local-dev/activity/<runtime-id>.jsonl`, with owner-only directory/file permissions. They may contain credentials, source code, complete environment variables, and personal data. They are not automatically added to ChatGPT responses or uploaded. Normal MCP requests and responses still traverse the existing configured transport.

No automatic retention deletion is enabled in this release. Settings explains that archives grow until managed by the user. Use Open archive in Finder to inspect and manage completed-session files. Removing a currently open archive or encountering a recording error faults the runtime, blocks new work, and requests cancellation of owned work instead of silently continuing without capture.

Visibility covers instrumented boundaries, not a machine-wide syscall audit. A generic downstream tool may omit internal browser or filesystem activity. The app does not claim that an unreported action was independently observed. Exact edit requests and any returned diffs are available; arbitrary subprocess file changes are not automatically reconstructed into before/after diffs.

## Command and output panels

Command summaries are visible as concise tool steps. Expanding a step opens the command/output panels inline; original inputs and output remain fully accessible. Each native command has its own bordered panel with the invocation, complete executable path, working directory, output, exit/signal state, and elapsed time. Batch commands keep their own stdout/stderr instead of sharing an ambiguous combined preview. Commands awaiting admission are shown as not started, not as silent successes.

Known inline interpreter source (for example, Node `-e` or Python `-c`) is displayed separately from the invocation. The invocation explicitly marks where the script belongs; **Copy command** always copies the complete original argv rendered with quoting, never that visual placeholder. Script source is independently selectable and copyable.

Output provides All, stdout, and stderr filters, selectable monospaced text, line wrapping, copy, and following of newly appended output. Following respects an existing text selection or a user who scrolled away from the bottom. **Expand output** opens a larger inline scroll area. When the bounded preview has omitted earlier output, **Load full output** reads the original records; the omitted-prefix notice remains until the full load succeeds. **Raw** opens the unmodified records. A stderr badge describes the stream, not an invented failure; the actual exit status is shown separately.

The readable output view removes ANSI/OSC control sequences without executing them. It handles sequences split between chunks and keeps parser state separate for stdout and stderr. CRLF becomes one newline; carriage-return progress updates are displayed as separate lines rather than erasing earlier history. Backspaces are shown visibly. No new newline is inserted merely because a captured chunk ended. Original byte payloads and JSONL files are unchanged.

The native test suite exercises exact command copying, script extraction, preview limits, control-sequence decoding, batch separation, no-output exits, and complete archive reads. It also renders synthetic light/dark command-panel previews to `build/menu-bar/previews/`. These are test fixtures, not screenshots of user work. Installation now runs the shipping native binary's self-test before replacing the installed app.

## Process controls

- Stop operation aborts the request and any nested work inheriting its signal. Batches cannot start a later step after cancellation, even with stopOnError disabled.
- Stop process group targets only a group created by Local Dev's native command boundary. It sends SIGTERM, escalates to SIGKILL when necessary, and distinguishes unconfirmed termination.
- Pause blocks new admission without suspending existing processes.
- Stop all work pauses admission and requests cancellation/termination of owned work. It does not kill arbitrary PIDs or unrelated user processes.
- Quitting the app first requests and waits for confirmation of paused admission. It does not label still-running processes as stopped.

A tool call finishing is distinct from a background service exiting. Active services remain visible after the starting call completes. Processes that deliberately escape their process group and work hidden inside independent downstream servers cannot be guaranteed stopped by the native process-group control.

## Private architecture

```text
ChatGPT -> Secure MCP Tunnel -> Local Dev stdio MCP server
                                      |
                           execution-side activity + gate
                                      |
                  owner-only Unix socket and local JSONL files
                                      |
                           native macOS menu-bar app
```

There is no public listener, local HTTP server, database, model-driven polling, browser dashboard, or added cloud service. The app incrementally reads its local archive and receives current runtime state over a private Unix socket. A lagging live viewer can reconnect and recover from the archive without losing original output.

`src/activity.ts` is the sole permitted `node:net` and raw error-stack boundary. Stack details are retained locally, not automatically included in model-facing errors. MCP stdout remains reserved for JSON-RPC.

## Regression coverage

The repository check includes approval/denial/expiry, explicit auto-approval confirmation, policy persistence, pause precedence, complete output beyond the model-facing tail, returned-error classification, cancellation, cancelled batches, unsupported control rejection, recording failure, and long monotonic progress. Native checks cover incomplete journal records, UTF-8 preservation, raw-byte identity, duplicate-free rescans, approval-required defaults, and panel layout.

Protocol/unit tests do not prove the complete real-tunnel user experience. Installation, native connection smoke checks, real-tunnel reconnection, user interaction with approval buttons, and login/reboot behavior must be reported separately, with unperformed checks explicitly unverified.
