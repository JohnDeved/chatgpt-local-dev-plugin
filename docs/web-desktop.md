# Web-technology desktop migration

## Decision and research

The desktop UI uses **React 19.2.8, TypeScript 5.8.3, Vite 8.2.2, CSS Modules, and Lucide**, hosted by **Electrobun 2.0.1 with its Bun main-process option**. The existing Node 24 MCP server and Secure MCP Tunnel remain unchanged. Dependencies are isolated in `desktop/package.json` and `desktop/package-lock.json`; Electrobun is pinned in `desktop/hutch.config.ts`.

Design guidance is Anthropic's frontend-design skill, pinned with its license and source commit in `.agents/skills/frontend-design/`. The product-specific design plan in `desktop/DESIGN.md` deliberately rejects a generic metrics dashboard: the primary object is the user's run, its goal, the actions taken, and the user's pending decisions.

Primary sources consulted on 2026-09-05:

- Skill source: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- Electrobun stable release: https://github.com/blackboardsh/electrobun/releases/tag/v2.0.1
- Runtime options: https://framework.blackboard.sh/electrobun/guides/native-main-process/
- Bun setup: https://framework.blackboard.sh/electrobun/guides/hello-world-bun/
- Typed webview bridge and navigation: https://framework.blackboard.sh/electrobun/apis/browser-view/
- Tray behavior: https://framework.blackboard.sh/electrobun/apis/tray/
- Build configuration: https://framework.blackboard.sh/electrobun/apis/cli/build-configuration/
- Cross-platform targets and caveats: https://framework.blackboard.sh/electrobun/guides/cross-platform-development/
- React/Vite application setup: https://react.dev/learn/build-a-react-app-from-scratch
- Electron process model, considered as an alternative: https://www.electronjs.org/docs/latest/tutorial/process-model
- Tauri process model, considered as an alternative: https://v2.tauri.app/concept/process-model/

Electrobun was selected for a TypeScript host and system webview without bundling Chromium by default. Electron would provide a more uniform browser runtime but includes Chromium; Tauri would add Rust host code to this TypeScript-centered project. This is a fit decision, not a measured claim that this application uses less memory than those alternatives.

Electrobun 2 defaults to Cottontail/Hutch rather than the older Bun-only architecture. This app explicitly selects actual Bun for its filesystem and socket integration. `electrobun prepare` resolved Hutch 0.24.3 and Bun 1.4.0 for the pinned release during verification. Its npm package is a bootstrap; SDK imports resolve from the generated `.hutch/devkit`, not the npm package's placeholder exports.

## UX changes

- **Runs first:** the current goal, explicit start/end boundaries, public update, and recent steps form one readable work log. Completed runs are compact. Original records and full output expand on demand.
- **Attention:** pending approvals and unreviewed failed actions have their own view. A pending action stays actionable without finding it inside a collapsed run.
- **Steering with receipts:** drafts survive reloads; message retries reuse their ID; queued and acknowledged states remain distinct. The composer only targets connected, assistant-declared runs. Observed activity without a successful `run.start` cannot queue steering and reproduce the previous missing-reporting-tool deadlock.
- **Commands with their output:** exact command copying, separate inline scripts, working directories, per-command stdout/stderr filters, wrapping, scroll-follow, and explicit bounded-preview/full-record controls.
- **Recoverable states:** connection errors explain what is missing and expose saved tunnel diagnostics. Reconnect, automatic approval, stop-all, and quit use host-native confirmation where appropriate.
- **Accessible structure:** keyboard-operable disclosures, Cmd/Ctrl+K search, native dialog focus handling, visible focus, reduced-motion support, light/dark/system themes, and narrow-window layouts. Color is accompanied by text labels.

Steering remains a tool-response mechanism, not a way to wake a finished ChatGPT conversation. Plans and decisions are explicitly published public summaries, not a private reasoning transcript. These boundaries are unchanged from `docs/worker-runs.md`.

## Workbench redesign (0.5)

The refreshed interface uses a contrasting indigo navigation rail, a spacious run workspace, a prominent goal/title, and a distinct terminal surface for command output. Run history is browsable rather than an endless page of open cards. Selecting earlier work does not change the steering recipient or discard the draft; incoming activity does not switch the viewed run.

Run elapsed time updates every second while a run is connected and open. Completed durations remain fixed. Both run history and individual action summaries show compact timestamps with their full local timestamp available on hover. No elapsed-time animation implies progress or completion.

**Auto-expand newest activity** is enabled by default. A genuinely newer tool call opens automatically and closes the preceding automatic chain, including the ancestors needed to reveal nested calls. Output/status updates, replayed older history, and same-ID reordering do not reopen a manually collapsed action. The quick toggle is beside Activity, and the persistent setting lives in Settings > Appearance. Disabling it preserves the current disclosure state and leaves new actions collapsed. The app does not scroll the user to the bottom or redirect a run selection.

Motion is limited to user-visible state changes: disclosure expansion/collapse, chevrons, dialogs, notices, and a restrained run entrance. Reduced-motion preferences disable these transitions. Pending approvals remain visible even when a step filter excludes their tool category; Approve is disabled while paused but Deny remains available.

Edit actions can display a line diff loaded on demand from their recorded inputs/results. Literal replacements compare captured snippets and label the line numbers as excerpt-relative. Pattern replacements and writes without original text are not mislabeled as verified file diffs. Tool-returned patches retain explicit tool-reported provenance. Full source, all diff lines, and original records remain accessible; no current filesystem read is used to invent a historical before state.

The browser regression suite covers these behaviors in Chromium and WebKit, including an advancing test clock, stable completed durations, persisted expansion preference, history/draft isolation, Ctrl/Cmd+Enter steering, paused approvals, diff provenance, keyboard controls, and 390px layouts. The production UI is still bundled locally with the same narrow Electrobun bridge; the redesign does not change execution permissions or approval policy.

## Workbench update (0.5)

The former flat layout is replaced by a contrasting indigo navigation rail, selected-run workspace, larger goal typography, and dark terminal panels. Runs are selected in the history rail rather than mixed into one long page. Narrow windows retain navigation through a compact header and run selector.

**Settings → Appearance → Auto-expand newest activity** is on by default. A matching Following newest/Manual expansion control lives above the activity rail. New tool-call IDs open automatically and close preceding expanded detail; output/status refreshes do not reopen a manually collapsed call. Nested calls expand their ancestor path. Replayed older history does not steal expansion, and no view change redirects the steering recipient or forces scrolling. Turning the setting off restores manual expansion and persists locally.

**Interface animations** enables short disclosure, chevron, dialog, and view transitions. macOS/OS Reduce Motion always overrides this preference. No looping activity ornament or invented progress indication is used. Collapsed panels are inert and removed after their short exit transition.

Run elapsed times update independently once per second. Completed durations use the recorded end; disconnected runs do not continue an apparent live timer. History timestamps show the full local date/time on hover.

Expandable edits show a **requested text diff** for captured literal find/replacement strings, **pattern replacement** for regex, **proposed contents** when no original is recorded, or a **tool-reported diff** when returned. These views explicitly state their evidence limits; neither successful dispatch nor a proposed diff is presented as independent proof of final filesystem contents. Complete inputs and original records remain available.

Motion/reference documentation consulted: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion and https://react.dev/learn/you-might-not-need-an-effect . The implementation uses native CSS and the existing React dependency; no animation framework or remote assets were added.

## Architecture and trust boundary

```text
React renderer (browser-only)
    | typed, validated actions and record IDs
Electrobun Bun host
    | owner-only local socket client + archive reads
Existing Local Dev Node MCP runtime
    | existing outbound Secure MCP Tunnel
ChatGPT
```

The renderer has no filesystem or command execution API. It can request known records by IDs, copy displayed text, explicitly export selected records, and invoke a closed set of local controls. Host-side validation checks operation/run/process ownership and live state before sending a control message. No arbitrary executable, URL, or path comes from the renderer into a privileged action.

The bundled renderer has a restrictive Content Security Policy, no remote fonts/scripts, no HTML injection from tool output, and navigation restricted to the bundled view. Electrobun's internal bridge uses encrypted per-webview loopback websocket transport with its native fallback; this is a framework-owned local IPC implementation, not an application HTTP dashboard or public ingress. No custom HTTP listener is added to the shipped app. Playwright tests use an ephemeral loopback-only static server for their fixture build.

The fixture bridge is compiled only in test mode and removed from production. Browser tests do not receive the user's real archive or approval state. Native integration tests require isolated temporary homes. Same-user programs are not treated as an adversarially isolated OS principal: the local socket permissions are not a sandbox against arbitrary code already running as the machine owner.

All original JSONL records remain unmasked on disk. The visible index is incremental and bounded for display; full input/result/output and image content can be retrieved from the original bytes. No remote upload or automatic archive deletion is introduced. Draft/theme preferences are local browser storage; approval persistence still uses the existing private runtime settings file and explicit user choices.

## Build, checks, and installation

Initial setup:

```sh
npm ci
npm run desktop:setup
```

Daily verification and installation:

```sh
npm run check
npm run desktop:install
```

Useful focused commands:

```sh
npm run desktop:check
npm run desktop:build
npm --prefix desktop run test:ui
```

The root repository check preserves the backend and SwiftUI regression checks and adds desktop typechecking, unit/control integration tests, Chromium/WebKit UI tests, and a packaged macOS native-webview smoke check. The retained `native/` sources are the rollback/reference implementation; new presentation work belongs under `desktop/src/renderer`.

Electrobun's stable build output is a self-extracting installer. The package script does **not** launch that wrapper for verification. It decompresses the locally built archive using Node's zstd support, validates its relative archive paths, extracts the real app payload, sets menu-bar-only metadata, ad-hoc signs it, and tests that payload. This avoids running installation side effects against the user's application-support directory during a smoke test.

The installer stages the verified payload in `~/Applications`, verifies that the existing target is Local Dev, replaces only the exact running companion application, and retains the previous app as a timestamped backup. It does not restart the tunnel, send approval-policy changes, or stop commands managed by the backend. The macOS bundle identifier remains `local.dev.menubar` for continuity. Existing login registration is not automatically toggled; use the OS startup settings control to review it. Post-login/reboot behavior must be verified separately.

Local builds are ad-hoc signed, not notarized distribution releases. Windows/Linux installers, signing, login integration, and native platform smoke tests are not claimed complete. The renderer and host boundaries are prepared for those ports, but the existing backend's process-group, Unix-socket, and service-management assumptions still require platform-specific work—especially on Windows.

## Verification scope

The desktop core suite exercises exact command quoting, split ANSI/OSC decoding, per-process output isolation, explicit run boundaries, bounded previews, exact archive reconstruction, invalid-action rejection, real socket steering/acknowledgement, approval/pause enforcement, offline confirmation, and safe preference persistence.

The browser suite runs in both Chromium and WebKit. It checks run expansion, command/stream controls, raw-record access, inert malicious-looking output text, approval actions, persistent steering drafts, observed-run gating, cancelled auto-approval, keyboard search/dialogs, themes, and narrow-window overflow. Screenshots are saved under `build/desktop-previews/`; these contain synthetic fixtures, not user source or secrets.

The native smoke check launches the production React bundle inside the actual Electrobun native webview, confirms typed RPC and a real connection to an isolated ActivityHub, and verifies that no approval policy was changed. This proves native loading and bridge operation; it is distinct from automated clicking of every native dialog, post-login behavior, and Windows/Linux deployment.


## Refined interface and work tracking (0.6)

The 0.6 interface uses a lighter lavender shell, layered white activity surfaces, stronger action icons and readable command wells. The latest action leads the timeline; earlier work remains inspectable underneath. Wide windows have a separate context column with the latest public update, run to-dos, steering work status, and recorded run facts. The public update stays visible when the timeline scrolls. Compact windows retain a pinned, expandable update rather than compressing the timeline into unusable columns.

Visual references are documented in `desktop/DESIGN.md`: Mercury's activity-log work on Dribbble and NotReal's product-UI study on Behance informed hierarchy, selective emphasis and purposeful motion. The shipped UI consists of real interactive components, not an embedded portfolio screenshot. An early action-index concept was dropped in favor of the clearer newest-first log and explicit Latest control.

Arrival animation is triggered by a genuinely new action ID, not output chunks. Real completed/failed transitions receive a short acknowledgement. Historical initial rows and replayed older records do not animate as if new. Browser animations are cancelled when OS Reduce Motion or the saved Interface animations setting disables motion. Hidden/closed panels remain inert and release their output effects after closing.

### Clock format and live following

Settings > Appearance contains **Time format**: System, 12-hour, or 24-hour. System reads the Mac's existing clock override when present and otherwise uses locale formatting. Reopening the panel or selecting System refreshes that read-only lookup. The selected policy applies to run/action/history timestamps and full timestamp tooltips; elapsed durations retain their normal hours/minutes/seconds format.

**Follow live activity** is independent of **Auto-expand newest activity**. In the newest-first layout, new work stays at the leading edge. Reading earlier work suspends following and exposes Resume live. The selected run, draft, and steering recipient do not change. Auto-expansion still follows new identities, and a status/output refresh does not reopen a manually closed action.

### To-dos and steering implementation state

The backend adds `run.update.todos` and `run.update.steeringTasks`. These fields report queued, in_progress, paused, completed, or cancelled work, with stable IDs and optional outcome notes. To-dos require a title when first introduced. A steering message still has a separate queued/returned/acknowledged delivery receipt: an acknowledgement never marks its work completed.

Before substantive tools are dispatched, the updated server requires a declared nonempty to-do list. Read-only current-status inspection and process polling/stopping remain available for recovery. Unfinished to-dos and steering work are repeated in subsequent tool-response context. Reporting a completed run is rejected while those items remain open; failed or cancelled run outcomes retain unfinished items rather than rewriting them as successful.

Example reporting payload (for `run.update`):

```json
{
  "runId": "<run ID>",
  "summary": "The interface is implemented; verification is next.",
  "todos": [
    { "id": "design", "title": "Refine the interface", "status": "completed", "note": "Visual review completed" },
    { "id": "verify", "title": "Verify the installed app", "status": "in_progress" }
  ],
  "steeringTasks": [
    { "id": "<acknowledged steering ID>", "status": "completed", "note": "Implemented and checked" }
  ]
}
```

Task state is explicitly assistant-reported, not a claim of independent filesystem verification. Old records without task state say that work status was not reported. The renderer never invents tasks by splitting prose, and it does not write completed statuses into old journals.

**Activation:** desktop presentation changes load when the companion is replaced. The new work-tracking API lives in the MCP backend and requires that running runtime to reload the rebuilt server and its tool schema. Installing the UI alone cannot hot-patch it. Use the existing user-confirmed reconnect path when it is safe to interrupt managed work; no forced tunnel restart is part of this redesign installation.


## Space-efficient workspace (0.6.1)

The lavender visual identity is retained, but working content has priority over repeated chrome. One sticky timeline toolbar now contains filters, auto-expansion, and live pause/resume. The public update appears in the right rail on wide windows or as a compact expandable strip above the timeline, not again inside the active action. The sticky strip offset is measured from the toolbar so wrapping controls do not cover actions.

The node gutter is narrower because absolute timestamps already appear on every action. Commands share a row with their copy control; expandable execution metadata retains the full executable/directory. Lower-priority tool metadata is below the output. The steering composer uses a single input row plus an always-visible recipient row and grows for multiline input/focus. Offline/oversized-draft explanations remain visible. Run details, reported plan and quick settings have labeled keyboard-accessible disclosures; tasks and public updates remain prominent. Narrow navigation keeps its named, keyboard-accessible controls in an icon row.

A manual-collapse regression exposed by the changed scroll geometry was fixed: reading suspension is no longer treated as turning the auto-expansion preference off and back on. Returning to a viewport cannot reopen manually collapsed work. Explicit Resume live resumes the newest automatic chain when auto-expansion is enabled; normal history inspection preserves its disclosures.

Repeatable measurements use the same two-call fixture, frozen clock, and window sizes in Chromium/WebKit. In Chromium at 1080×760, visible height of the initial expanded action increased from 146.7px to 334.8px, its width from 735px to 820px, and the composer decreased from 127.4px to 84px. At 390×780, initial visible action height increased from 0px to 227.7px and the composer decreased from 112.8px to 79px. Some command output is initially visible at all five tested sizes. These are fixture/layout measurements, not a claim about every possible long goal/output.

`space audit` browser tests protect the minimum visible output area, composer height and gutter width; baseline/updated metrics and screenshots are in `build/space-audit/`. No body or code text was reduced to obtain the gains. Full goals, updates, command paths, original records, permissions, steering delivery, work status and the earlier backend activation boundary are retained.


### Terminal tail behavior (0.6.2)

Command output no longer creates a nested wheel-scroll region by default. The compact view contains only the final three lines of the selected All/stdout/stderr stream and is not keyboard-scrollable. Expand output explicitly enables the bounded scrollable terminal and follow-new-output control; collapsing returns to the last three lines. For preview-limited records, expansion retrieves the retained full output before treating it as complete. Copy displayed output follows the visible state. The wide latest-update card is a normal right-rail item rather than sticky, while the compact inline update remains available.
