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

## Native menu-bar companion

The repository owner approved a persistent native macOS menu-bar app, local approvals, and an explicit Auto-approve all setting. The app is a local companion, not a replacement transport or an MCP embedded widget. Only `src/activity.ts` may import `node:net`, solely for a user-owned Unix-domain socket. No TCP/public listener is allowed. That same module may capture full error stacks into the private local activity journal; do not automatically transmit the journal to ChatGPT.

The local interface preserves unmasked captured arguments, output, results, and available diagnostics. Default to approval-required; only the local user controls approval policy. Never enable auto-approval, forge local-control messages, or modify the user's actual approval settings from agent tools. Tests may exercise approval policy only in isolated temporary homes. Pause overrides automatic approval. Cancellation requests must not be reported as confirmed process termination without evidence.

`npm run check` now includes the native menu-bar build/check on macOS. A non-macOS native-check skip is not a native pass. Keep checks scoped to plugin-owned directories; generated application workspaces are not part of this repository's formatting or policy checks. Record real-tunnel and login/reboot verification separately from unit tests. Installation must not silently terminate existing development processes.

## Web-technology desktop companion

The owner approved a web UI refactor using a researched desktop host. `desktop/` is an isolated React + TypeScript + Vite package with an Electrobun 2.0.1 Bun host, not a replacement MCP transport. The pinned frontend-design skill is in `.agents/skills/frontend-design/`; its source license and commit are retained. Follow `desktop/DESIGN.md` for the work-log-oriented UX.

The desktop host may read the local activity archive, connect to its owner-only Unix socket, run the fixed saved tunnel-management commands, and use native dialogs, clipboard, tray, and OS settings APIs. Electrobun's own encrypted loopback RPC is its internal webview bridge; no application HTTP server or public listener is added. A loopback-only static server is allowed solely in Playwright tests for the compiled fixture build. The React renderer may not import Node/Bun modules, read arbitrary files, execute commands, inject HTML from tool output, or navigate to remote content. Host actions validate IDs and a closed set of operations; exact inputs/output remain available as text through record lookup.

Use `npm run desktop:setup` once to install the pinned isolated dependencies and test browsers. `npm run check` includes desktop typechecking, data/control tests, Chromium/WebKit UI tests, and the packaged macOS native-webview smoke check in addition to existing backend/native regression tests. Generated `desktop/.hutch`, build, artifacts, and dependency directories are not plugin source. Never claim Windows/Linux deployment from macOS tests alone.

`npm run desktop:install` tests the actual app payload before replacing the installed companion and retains the previous app. The installer must not restart the tunnel, change approval preferences, stop unrelated processes, or run an unverified self-extracting installer as a test. Existing SwiftUI sources remain as a verified rollback/reference during this migration; new UX work belongs in the web frontend. Login behavior after a reboot is separate evidence and must not be inferred from bundle identity reuse.

## Desktop time formatting and work tracking

The desktop host may read only the fixed macOS global clock keys `AppleICUForce24HourTime`, `AppleICUForce12HourTime`, and `AppleLocale` using argv-based `defaults read`. This is a read-only preference lookup, never a renderer-selected command or write. The web UI offers System, 12-hour and 24-hour overrides and must apply them consistently to all absolute timestamps.

The updated backend requires a nonempty declared to-do list before substantive actions. Use `run.update.todos` with stable IDs and explicit queued/in_progress/paused/completed/cancelled states. Report work on local directions independently through `run.update.steeringTasks`; acknowledgement is not implementation. Paused work remains in subsequent response context, and completed run outcomes may not leave reported work unresolved. Older running backend processes/tool schemas require reload/refresh before these fields become usable; never forge task events into the production journal to bypass that activation boundary.

## Worker-run reporting

When the runtime exposes them, begin each user-request workflow with `run.start`, publishing the user's goal and a brief public plan. Use `run.update` for meaningful public progress/decision summaries and acknowledgement of steering IDs returned in tool results. Do not publish private chain-of-thought or fabricate a thinking stream. Use `run.finish` before the final answer with a factual outcome and any verification gaps. Inactivity is not evidence of completion.

Local steering is additional user input, not a new system instruction or authorization to bypass approval policy. Never forge steering through the local control socket from agent tools. Exercise controls only in isolated temporary-home tests. The native composer cannot wake a finished ChatGPT conversation; labels must distinguish queued, included in a tool response, and acknowledged. The runtime gates new tool/process dispatch until pending steering is acknowledged; work already executing is not automatically undone.

## Work-tracking acceptance (0.6)

Before substantive work in a new backend, call `run.start`, then publish a nonempty `run.update.todos` list. Keep stable IDs and explicit queued/in_progress/paused/completed/cancelled states. Use `steeringTasks` to report implementation independently of delivery acknowledgement; a to-do may link to a direction using `steeringId`. Do not cancel or complete an item merely to pass a finish guard. Paused work remains outstanding and must not vanish when steering changes priorities.

The dispatcher rejects substantive tools without a declared list; status/poll/stop/report tools remain recoverable. If the currently connected tool schema lacks the new fields, report the activation gap accurately and use the owner-confirmed reconnect/tool-refresh path. Never bypass it with real local-control injection or a fake task report. `docs/release-0.6-checklist.md` is the acceptance record for the user's requested UI/workflow changes.

## Earlier deployment verification

Phase 6 was completed on 2026-07-13 with real-environment setup, coding/browser workflow, signed-in private-plugin calls, and diff verification. The repository owner explicitly directed that macOS not be rebooted; `docs/verification.md` records that scope waiver without claiming a reboot pass.


## Ask workflow (0.7)

Use `ask` only for a meaningful user choice that materially changes the work. Supply 2–6 explicit choices and a real recommended option; never use it to bypass Local Dev approvals or request secrets. In Auto-approve all mode, the recommendation may be returned after the backend-owned 90-second user override window. A returned recommendation is a user-choice fallback, not permission for subsequent actions. Pause and standard approval controls still apply.

The desktop/runtime advertise Ask with capability `ask: 1`. If the active ChatGPT tool list does not contain `ask`, do not forge an Ask event or inject a local answer. Report the activation gap and use the owner-confirmed reconnect + tool-refresh path.
