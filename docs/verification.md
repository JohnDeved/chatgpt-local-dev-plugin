# Verification record

This file separates automated coverage, real-environment evidence, and evidence that is still outstanding. An unchecked item is not a claimed pass.

## Automated gate

- [x] `npm run check` passes formatting, policy lint, strict TypeScript checking, clean build, and all 25 credential-free tests on Node 24.18.0.
- [x] Temporary-home tests cover Codex/Local Dev parsing, redacted errors, strict selections, nested project hooks, core argument rejection, foreground/background execution, output bounds, stdio and Streamable HTTP proxying, pagination, filters, metadata preservation, required/optional server behavior, setup resume, rollback, service lifecycle, safe status, and uninstall preservation.
- [x] The packed `local-dev` bin has executable mode and `npm link` produces a working command.

## Real macOS environment — 2026-07-13

- [x] `local-dev setup` reused the existing native tunnel runtime and stored runtime-key reference without reading or copying a literal key.
- [x] Native tunnel status reported `process_running`, `healthy`, and `ready`; `/healthz` was live and `/readyz` was ready. Control-plane polling remained separately reported as `unknown` because the native status had no live admin UI snapshot.
- [x] The macOS LaunchAgent was loaded as a persistent `local-dev watchdog` under `/usr/bin/caffeinate -s`; it permits display lock, prevents AC idle sleep, reconnects an unhealthy runtime, and force-recycles the runtime after a detected sleep/wake gap.
- [x] `local-dev status` passed its direct MCP discovery/call smoke test and reported ready.
- [x] The shared registry selected pinned Serena 1.5.3 and Chrome DevTools MCP 1.5.0 entries with explicit allowlists. The production Local Dev registry exposed five native tools, 20 namespaced Serena tools with shell execution absent, and three namespaced Chrome slim tools.
- [x] Through the combined registry, `project.open` activated the repository, Serena edited `README.md`, and `dev.run` ran the complete 17-test repository gate successfully.
- [x] Through the namespaced Chrome DevTools tools, an isolated headless Chrome opened the live tunnel admin UI, evaluated its title/heading/health text, and produced a screenshot artifact.
- [x] The resulting repository diff passed formatting, tests, `git diff --check`, and a credential-pattern scan; the only bearer-like match was an intentional fake value in an HTTP fixture.

## Final connector evidence and owner decision

- [x] A fresh signed-in ChatGPT app named `Local Dev` was connected to the existing Secure MCP Tunnel after the earlier `Local Dev Tunnel` app was found to have a stale compatibility-only manifest. The production app exposed `project.current` and the namespaced downstream registry; the obsolete app was disconnected.
- [x] In a signed-in ChatGPT Work conversation, `local_dev_project_current` returned the production structured result `{ "ok": true, "tool": "project.current", "data": { "path": null }, "error": null }`. `local_dev_serena_get_current_config` then reached Serena through the namespaced proxy and returned its expected no-active-project response, proving both native and downstream calls traversed the private connector.
- Post-reboot repetition was explicitly waived by the repository owner on 2026-07-13 with the direction "Do not reboot." This is an owner-approved scope change, not a claimed reboot pass. Pre-reboot LaunchAgent, direct MCP smoke, native tunnel readiness, and signed-in connector evidence remain recorded above.


## Native menu-bar companion — 2026-09-05

- [x] `npm run check` passed formatting, policy lint, strict TypeScript checking, clean build, all **60** current Node tests, and the macOS native menu-bar build/check. The older test counts above are historical deployment records.
- [x] New regression tests cover approval-required defaults, approval/denial/expiry, explicit auto-approval confirmation, remembered versus session policy, persistent pause precedence, full unmasked local output beyond the MCP tail, returned-error classification, foreground cancellation, cancelled batches, information-form handling, capture failure, unsupported controls, and unsaturated progress.
- [x] Native checks passed incomplete-record handling, original-byte preservation, UTF-8 records, duplicate-free rescans, approval-required defaults, and panel layout.
- [x] The app was built, ad-hoc signed, installed at `/Users/johann/Applications/Local Dev.app`, and opened. `SMAppService.mainApp.status == .enabled` returned true after explicit login registration.
- [x] `node scripts/menu-bar-smoke.mjs` passed with the installed native viewer PID `69270`. The app connected to a fresh instrumented local runtime (`984a7087-7b4`), which captured two actual read-only subprocess checks. Auto-approve was false, and no policy-change event was produced. The local record is `~/.local-dev/activity/984a7087-7b4.jsonl`.
- [x] Repository file collection is now limited to plugin-owned directories, with a regression test proving that independent generated application workspaces are not reformatted or policy-linted as part of this plugin.
- [ ] The existing production tunnel was **not restarted**: it still holds the previous server code in memory. Reconnection is required to activate the new instrumentation for normal ChatGPT calls. This was deliberately left separate from installation to avoid terminating its managed development processes.
- [ ] Human interaction with native Approve/Deny buttons through the real updated tunnel has not been performed. Automated IPC decision tests and the native connection smoke test are distinct evidence.
- [ ] Post-login and post-reboot behavior has not been exercised. Enabled login registration is not a claimed reboot pass.

The native connection smoke test is not represented as a real-tunnel migration. Generic downstream internal actions and arbitrary subprocess file modifications are not claimed to have complete machine-wide tracing. Full details of captured boundaries, controls, storage, and limitations are documented in `docs/menu-bar.md`.


## Readable timeline and disconnected approval repair — 2026-09-05

- [x] `npm run check` passed all 60 Node tests and expanded native checks after the repair.
- [x] Native regression checks verify session-only auto-approval can be chosen offline without silently resetting or enabling persistence; app restart clears session-only intent, and explicit remembered policy persists.
- [x] Timeline checks cover readable file/edit/command labels, preservation of complete command arguments, many events reduced to one call, output previews, nested call relationships, denial versus failure, disconnected unfinished work, and numeric sequence order for same-timestamp records.
- [x] The native reconnect routine was exercised against an isolated fake tunnel executable. It performed status, stop, and connect in order and preserved the saved MCP command as one argv value. No production tunnel or approval setting was changed by that test.
- [x] The native layout/build check passed for the new 820 × 730 chronological timeline. This is not a claim of automated human interaction with every SwiftUI control.
- [ ] Production reconnection is owner-confirmed because it may interrupt existing managed commands. A visible local reconnect confirmation, not an automatic forced tunnel restart, is the activation path.

- [x] The updated companion was installed and reopened as PID `73784`; the previous companion PID `69270` was no longer running. Login registration remained enabled.
- [x] The installed companion passed the real local IPC/read-only process smoke check again (`a6939900-4e9`), with auto-approve false and no policy-change events. Existing `npm run dev` PID `48958` remained running.
- [ ] `npm run polish` still fails on the earlier backend complexity, unused-code, and nested-workspace audit findings. Its embedded repository check and the targeted `git diff --check` passed.


## Inline command/output panels — 2026-09-05

- [x] `npm run check` passed all 60 Node tests, native checks, and command-panel rendering checks. `git diff --check` passed.
- [x] Commands are visible without opening the row. Each actual batch command owns its own output capture, executable path, working directory, stream filters, and exit/signal status. Queued command plans remain inspectable before execution.
- [x] New native regression checks cover exact original command copying, separate inline source, split ANSI/OSC sequences, independent stdout/stderr parser state, CRLF and carriage-return updates, explicit preview limits, per-command batch isolation, silent successful exits, full archive retrieval without inserted chunk newlines, and original-byte preservation.
- [x] Native light/dark fixture renders are generated at `build/menu-bar/previews/command-output-light.png` and `command-output-dark.png`. These are generated fixture renders, not evidence of human interaction with the user's desktop.
- [x] The complete-output inspector no longer invents a new line at each process-output event. Presentation-only terminal decoding does not modify any archived record.
- [x] The installer self-tests the optimized shipping executable before replacing the companion. Native check builds retain assertion diagnostics for actionable regression failures.
- [ ] Manual interaction with every new filter/copy/wrap/follow control has not been independently verified. Automated model, archive, and rendering checks are separate evidence.


## Worker-run lifecycle, public updates, and steering — 2026-09-05

- [x] Resumed after the Local Dev session interruption and confirmed the saved changes. Fixed a Swift exclusive-access conflict, supplied the required `projectOpenHooks` field in the isolated stdio fixture, and updated the native-tool-list assertion to include the three reporting tools.
- [x] `npm run check` passed **71 Node tests**, the native UI/model checks, and the cross-language native-to-IPC-to-MCP steering workflow. The full check also passed inside `npm run polish` after final source/schema changes.
- [x] Native run checks cover observed versus declared starts, complete goals with concise headings, published plan/progress/decision notes, explicit end markers, unknown completion after interruption, steering queue/response/acknowledgement states, draft retention, and connected-run selection.
- [x] Run regression tests cover idempotent start/finish behavior, active-operation and pending-steering finish guards, supplied-session isolation, retry deduplication, atomic acknowledgement validation, input limits, nested and late-output run attribution, and command-boundary steering enforcement.
- [x] Native structured results include declared `localDevRun` context for clients that emphasize structured output. Arbitrary downstream structured schemas remain unchanged. The original tool result is preserved and unacknowledged steering is repeated until acknowledged.
- [x] `scripts/run-native-smoke.mjs` launched a separate native ActivityStore and real stdio MCP server in an isolated temporary home. The native composer sent steering through its Unix socket, the MCP client received and acknowledged it, and the native client observed the goal and explicit completion. No production approval settings or tunnel were changed by this test.
- [x] Native rendering checks generated a synthetic worker-run fixture at `build/menu-bar/previews/worker-runs.png`. This is not a screenshot or a claimed human interaction with production work.
- [ ] The optional `npm run polish` audit is **not clean**: six complexity findings (including the run reporter and activity recording), unused-code findings, and a duplication group remain. Several findings come from independent nested workspaces. This is not represented as a passing audit.
- [x] After the backend reconnected during final verification, real `project.current` and `project.open` calls both returned native `localDevRun` context with the same observed run ID `7579383a-21ff-4dad-b13e-d1e4ea157b6d`. This confirms the new backend is active and run attribution reaches the ChatGPT-facing structured result.
- [ ] The current ChatGPT connector tool list still exposes the older native tool set. Refresh/reconnect that tool list to expose `run.start`, `run.update`, and `run.finish`. No explicit goal, final run outcome, or steering acknowledgement through the real ChatGPT model is claimed; the observed run correctly remains goal-unreported until a reporting tool supplies it.
- [ ] Full ChatGPT run boundaries and summaries depend on explicit reporting. No private thinking stream, automatic conversation wake-up, or success inferred from inactivity is claimed. Post-login/reboot behavior and human interaction with every new control remain unverified.

- [x] The optimized shipping app (bundle build 4) passed its native checks and the isolated native-to-MCP workflow before installation. It was installed at `/Users/johann/Applications/Local Dev.app` and reopened; the previous app was retained as a timestamped backup.
- [x] The installed viewer PID `85728` passed the separate local connection/read-only process smoke test (`00fbfed0-394`). The existing auto-approval preference was read as true; the test produced no policy-change event. No automatic runtime restart was performed by the installer.

See `docs/worker-runs.md` for the lifecycle contract, the three steering states, attribution limits, and the distinction between public summaries and unavailable private reasoning.


## React/Electrobun desktop migration — 2026-09-05

- [x] The frontend-design skill was read from its pinned project copy and used with the product-specific design in `desktop/DESIGN.md`. The skill source, license, and commit are retained in `.agents/skills/frontend-design/`.
- [x] The new isolated `desktop/` package uses React, TypeScript, Vite, CSS Modules, and an Electrobun 2.0.1 Bun host. The existing Node MCP backend and tunnel were not replaced or restarted by this migration.
- [x] The full repository check passed with the original **71 backend tests**, SwiftUI rollback/model checks, native-to-IPC-to-MCP checks, and the added desktop verification. The desktop suite covers **17 data/control/security/installer-handoff tests** and **14 browser interaction tests** across Chromium and WebKit. Browser tests cover command output, approvals, draft persistence, steering readiness, cancellation of automatic approval, search/dialog keyboard behavior, themes, and narrow layouts.
- [x] The production React bundle was loaded in a real Electrobun macOS native webview. The smoke test waited for a React post-render readiness handshake, typed RPC, and a live connection to an isolated ActivityHub. It verified no approval-policy change.
- [x] Light, dark, narrow, and expanded-command fixture screenshots were produced under `build/desktop-previews/`; the light, narrow-dark, and command captures were visually reviewed. They contain synthetic test data, not private user output.
- [x] The installer now extracts and validates the real application payload from Electrobun's stable archive rather than launching its self-extracting installer for testing. An initial smoke attempt did launch the wrapper and created development-ID self-extraction bookkeeping under `~/Library/Application Support/local.dev.web/stable`; it did not replace the installed native companion. Subsequent checks use only isolated test homes and the extracted payload.
- [x] The update handoff verifies exact user-owned companion executable paths. It handles a graceful-close veto by terminating only the validated installed companion binaries, rechecks identities before escalation, and fails rather than claiming unconfirmed termination. Tests exclude the MCP backend, unrelated executables, other users, reused process IDs, and zombies.
- [x] Final installation succeeded at `/Users/johann/Applications/Local Dev.app`. The installed React view confirmed `domCommitted: true` in Bun host PID **99924**. The live backend recorded `viewer.connected` for that PID at `2026-09-05T17:49:14.676Z`, runtime `e1b14fd5-00a`, sequence 2950. The older web companion PIDs 95426/95428 exited.
- [x] A pre/post-install fingerprint comparison confirmed the user's approval settings were byte-for-byte unchanged. No steering or approval-policy control was forged by the installer. The current tunnel remained operational throughout final replacement.
- [x] The prior SwiftUI application remains at `~/Applications/Local Dev.previous-native-1788629626574.app`; the previous web application was also retained at `~/Applications/Local Dev.previous-native-1788630553958.app`. The `native/` source remains as rollback/reference during the migration.
- [x] The installed host's framework-owned listener was observed on loopback `127.0.0.1:50000`, not public ingress. No custom application HTTP server was added. Renderer code does not import privileged host modules or render tool output as HTML; production fixture hooks are compiled out and tested.
- [ ] `npm run polish` is **not clean**. Its full functional check passed, but the most recent audit reported complexity, duplication, and unused-code findings, including newly added frontend/host logic as well as existing backend and independent nested-workspace findings. These remain engineering cleanup work, not a claimed passing quality audit.
- [ ] Windows/Linux native deployment, backend service/process/socket portability, installer signing/notarization, and post-login/reboot behavior are unverified. The web renderer and host boundary prepare those ports; this is a verified macOS build, not a completed cross-platform release.
- [ ] Automatic startup registration was not changed. The OS startup-settings action is provided, but reusing the bundle identifier does not prove login/reboot behavior. Manual interaction with every native confirmation dialog is also distinct from automated browser/host tests.

Research, architecture, commands, UX choices, security boundaries, and remaining platform work are documented in `docs/web-desktop.md`. The native app is no longer the primary UI; use `npm run desktop:install` for the verified web companion.


## Workbench redesign 0.5 — 2026-09-05

- [x] Reworked the React UI into a contrasting navigation rail and a focused run workspace: prominent goal, live/recent run browser, concise expandable actions, distinct command/output panels, quieter steering composer, and separate approval/process/settings views. The existing Electrobun/native bridge and approval boundaries are retained.
- [x] Added persistent default-on newest-activity expansion, nested ancestor opening, predecessor closing, and an explicit disable setting. Status/output refreshes, older-history replay, and reordering do not reopen a manually collapsed step. Reduced-motion and keyboard-focus behavior are covered separately from timing data.
- [x] Added live run elapsed clocks and small history/action timestamps. Completed duration stays fixed; disconnected runs do not present an indefinitely advancing verified runtime.
- [x] Added on-demand edit comparisons from recorded inputs and results. Requested literal excerpts, regular-expression replacements, proposed file content, and tool-reported patches retain distinct provenance; no filesystem before state is fabricated.
- [x] `npm run check` passed formatting, repository policy lint, TypeScript builds, **71 backend tests**, retained native SwiftUI/model checks, **27 desktop tests**, **48 Chromium/WebKit browser checks**, and the packaged Electrobun native-webview/typed-RPC smoke test. The smoke test confirmed a real isolated runtime connection with no approval-policy change.
- [x] Browser tests cover stable selected history and steering recipient, persisted drafts, newest-step preference, nested expansion, paused approval behavior, command filters that retain pending approvals, Cmd/Ctrl+Enter submission, oversized input rejection, advancing clocks, fixed completed durations, timestamp semantics, edit provenance, and narrow-screen/reduced-motion layouts.
- [x] Reviewed generated light, dark, narrow-history, and edit-diff screenshots under `build/desktop-previews/`. These use synthetic browser fixtures, not screenshots of private source or a claim of full cross-platform deployment.
- [ ] Windows/Linux host packaging, startup behavior, notarized distribution, and post-login/reboot behavior remain unverified. A successful browser test in WebKit/Chromium is not claimed as an OS deployment test.

- [x] The 0.5 production React bundle was packaged, ad-hoc signed, and verified inside the actual Electrobun native webview before installation. Typed RPC and an isolated local runtime connection passed without an approval-policy change.
- [x] `npm run desktop:install` replaced only verified companion processes `1590` and `1592`, retained the previous companion at `/Users/johann/Applications/Local Dev.previous-native-1788632274486.app`, and installed `/Users/johann/Applications/Local Dev.app`. The newly rendered React UI reported ready in process `7852`.
- [x] Reviewed the final WebKit terminal-panel and preferences screenshots in addition to the run, dark, narrow, and edit views. The terminal retains unescaped text safely as text; generated screenshots contain test fixtures only.
- [ ] `npm run polish` completed its embedded functional checks but its Fallow audit remains failing: 27 complexity findings, unused-code/configuration findings, and three duplication groups. This includes newly enlarged renderer components and is not characterized as solely historical or a clean quality audit.
- [ ] The packaging tool reports a missing optional macOS iconset and no configured update release URL. This local build is not a notarized, auto-updating distribution release. Those warnings did not prevent the native smoke test or installed UI readiness check.


## Workbench 0.5.0, motion, and newest-item focus — 2026-09-05

- [x] Resumed after the owner released the local execution pause. Read the repository contract and pinned frontend-design skill; preserved and completed the existing workbench source changes rather than reverting them. The formerly installed flat layout was replaced with the matching indigo navigation rail, selected-run workspace, larger goal heading, and dark command panels.
- [x] Added default-on **Auto-expand newest activity** in Settings → Appearance and a matching timeline toggle. A genuinely new call opens and closes the preceding automatic selection; output/status refreshes and older-history replay do not reopen manually collapsed calls. Nested calls expand their ancestors. Disabling the preference persists and restores manual control. Run selection and steering recipient remain independent.
- [x] Added bounded disclosure/chevron/dialog transitions, a saved Interface animations preference, and OS reduced-motion overrides. Collapsed closing panels are inert and their contents are released after the exit transition. No looping work decoration, fake progress, or forced scroll was introduced.
- [x] Acknowledged the owner's local steering and implemented live per-run elapsed times, compact history timestamps with full-date tooltips, and recorded edit comparisons. Requested snippet changes, regex patterns, proposed contents without originals, and tool-reported patches have explicit provenance; no verified filesystem before-state is invented.
- [x] The complete repository check passed **71 backend tests**, retained SwiftUI/native integration checks, **27 desktop data/control/security/handoff/expansion/diff tests**, and **48 Chromium/WebKit interaction tests**. Native packaging verified the actual production React bundle in the Electrobun system webview, including DOM readiness, typed RPC, a real isolated ActivityHub connection, and no approval-policy change.
- [x] Visually reviewed synthetic workbench, terminal, preferences, and edit-diff screenshots under `build/desktop-previews/`. Interaction tests cover animation on/off/reduced motion, newest-item handoff, nested history, manual collapse on refresh, persisted preferences, unchanged steering drafts/recipients, independently ticking clocks, timestamps, and diff provenance. These are fixture/browser checks, not a claim that every real native control was manually clicked.
- [x] `npm run desktop:install` installed and opened **v0.5.0** at `/Users/johann/Applications/Local Dev.app`. The installed React DOM reported ready in PID **10606**. Runtime `e1b14fd5-00a` recorded its `viewer.connected` event at `2026-09-05T18:21:46.521Z`, sequence 6670.
- [x] A byte-for-byte comparison confirmed the installed HTML, `assets/index-ySvMgmlk.js`, and `assets/index-ZUA5-jEd.css` match the tested production bundle. This verifies the actual installed design changed, not only the repository source. Installation retained the previous companion at `~/Applications/Local Dev.previous-native-1788632505806.app`.
- [x] The pre/post-install approval-settings fingerprint matched. The same live runtime remained connected; the installer did not change approval policy or restart the tunnel. Evidence is saved locally in `build/workbench-install-verification.json`.
- [ ] The optional `npm run polish` audit remains failing: its complete functional check passed, followed by **27 complexity findings, 3 duplication groups, and unused-code/styling findings**, including new frontend and diff code. The report is retained in `build/workbench-polish.log`; this is not a claimed clean quality audit.
- [ ] Windows/Linux deployment, notarization, post-login/reboot behavior, and exhaustive human testing of native controls remain unverified. Existing portability and same-user trust-boundary limits still apply.

The implementation details and controls are documented in `desktop/DESIGN.md` and `docs/web-desktop.md`. The shipped version is visible at the bottom of the sidebar.


## Refined 0.6 interface, motion, live following, and work tracking — 2026-09-05

- [x] Implemented the lavender desktop interface as actual React components: dimensional action/brand icons, layered activity cards, a compact run overview, readable terminal wells, newest-first activity, and a separate context column at wide widths. The latest public update remains visible beside the log; compact windows use an expandable pinned update.
- [x] Added identity/state-driven browser animation: new visible calls receive one arrival reveal and actual completion/failure transitions receive a bounded acknowledgement. Historical initial rows, older replay, and output chunks do not replay these effects. Tests confirm both saved animation preferences and OS reduced-motion settings cancel/prevent JavaScript effects as well as CSS transitions.
- [x] Added System/12-hour/24-hour formatting across run, history, action and tooltip timestamps. The host reads only fixed macOS clock preference keys with argv-based read-only defaults commands. Locale fallback, explicit overrides and midnight formatting are covered by regression tests.
- [x] Added independent live following in the newest-first view, anchor preservation while reading older work, explicit Pause/Resume live controls, and protection against newest-item expansion collapsing older content while it is being inspected. A narrow-layout regression verifies new action headers appear below the pinned controls rather than underneath them.
- [x] Added explicit queued/in_progress/paused/completed/cancelled task status for steering, separately from queued/returned/acknowledged delivery receipts. Run to-dos use stable IDs and retain paused work; outstanding directions and to-dos are repeated in tool responses. The rebuilt server requires a declared list before substantive work and rejects completed outcomes while reported tasks remain unresolved.
- [x] The final functional check passed **84 backend tests, 37 desktop tests, and 76 Chromium/WebKit UI checks**, plus retained SwiftUI model/rendering checks, native-to-IPC-to-MCP integration, and the packaged Electrobun native-webview/typed-RPC smoke test.
- [x] Reviewed final desktop, task-context, terminal, dark and compact fixture screenshots. A compressed narrow-screen run title was corrected and tested for minimum readable width. The screenshots use synthetic fixture content, not exported private source or production logs.
- [x] `npm run polish` passed its embedded functional check but the Fallow audit is **not clean**: it reported 36 complexity findings, three clone groups, and unused-code/configuration/dependency findings across the working tree. This includes new UI/host logic and is not represented as exclusively pre-existing debt.
- [x] Installed the tested 0.6.0 companion at `/Users/johann/Applications/Local Dev.app`. The installer replaced only verified companion PIDs 10604/10606 and retained `/Users/johann/Applications/Local Dev.previous-native-1788636602362.app` as rollback.
- [x] The installed React view confirmed readiness in PID **25564**. The production journal recorded that viewer's connection at `2026-09-05T19:30:03.081Z`, runtime `e1b14fd5-00a`, sequence 13363. Installed JavaScript `index-9CenDwtK.js` and CSS `index-DNgYcaCs.css` matched the verified build byte-for-byte.
- [x] A private pre/post-install fingerprint comparison confirmed the owner's actual approval settings were byte-for-byte unchanged. The installer did not reconnect the production tunnel or modify approval/task state. Installation evidence is retained locally in `build/studio-install-evidence.json`.
- [ ] The live ChatGPT connector still exposes the earlier run-reporting schema. The new `run.update.todos` and `run.update.steeringTasks` contract requires the user's confirmed runtime reconnect and tool-schema refresh. The UI explicitly distinguishes this activation gap; no old acknowledgements were relabeled as implemented tasks and no production task events were forged.
- [ ] Windows/Linux deployment, notarization, and login/reboot behavior remain unverified. The local packager still warns about an optional iconset and missing update distribution URL; those are not represented as distribution-ready features.


## Completed 0.6 feature set and installed reference UI — 2026-09-05

- [x] Checked every owner request against `docs/release-0.6-checklist.md`: approved lavender reference, system time formatting, live following, default-on newest expansion, reduced motion, steering work states, sticky public updates, persistent to-dos, recovery controls, and actual installation. Acknowledgement was not treated as proof of implementation.
- [x] Added the missing enforced initial plan: substantive MCP calls require `run.start` plus a nonempty `run.update.todos` list. Current-status, poll, stop, and reporting remain exempt from the list requirement for recovery; approval, pause, and pending-steering controls are not bypassed. Success is rejected without a list or with unresolved tracked work.
- [x] Steering and to-dos support queued, in_progress, paused, completed, and cancelled, with independent delivery receipts and outcome notes. Stable to-do IDs and optional validated steeringId links retain work while priorities change. Invalid updates are atomic, repeated updates idempotent, and unfinished tasks are included in later model-visible responses. Legacy unreported tasks are not invented.
- [x] A real DesktopService ↔ private IPC ↔ stdio MCP integration test verified all work states, paused original work while handling a direction, blocked premature completion, viewer restart, and fresh archive reconstruction. No policy change occurred. Interruption/failure keeps last reported work state; tasks are not silently moved to another conversation.
- [x] System-aware timestamp tests cover fixed macOS preference reads, locale fallback, 12/24-hour overrides, midnight formatting, history and full tooltips. The host refreshes its read-only clock preference periodically; elapsed durations are unaffected.
- [x] Live following now places the newest actual action below pinned controls instead of merely scrolling to the run heading. Browsing older content suspends both scrolling and automatic disclosure changes, preserves the inspected row, and offers explicit Resume live. A narrow-window regression caught and fixed a small overlap with the sticky public update.
- [x] The complete `npm run check` passed **84 backend tests**, **37 desktop tests**, **76 Chromium/WebKit UI checks**, retained SwiftUI/model checks, native-to-MCP checks, and the packaged Electrobun native-webview test. The latter confirmed production React DOM readiness, typed RPC, and a real isolated runtime connection without modifying approval policy.
- [x] Reviewed generated WebKit reference-layout, task-context, compact, and dark-theme screenshots against the approved image. Actual controls and truthful empty states replace unsupported mockup examples. The tests/screenshot fixtures are not private user activity.
- [x] Declared the MCP SDK explicitly in the isolated desktop devDependencies at the same pinned version as the backend, resolving the new test package's unlisted dependency. The real end-to-end desktop workflow passed again after installation of that dependency.
- [x] Installed **Local Dev 0.6.0** at `/Users/johann/Applications/Local Dev.app`. The React view reported ready in PID **28743**, and runtime `e1b14fd5-00a` recorded `viewer.connected` at `2026-09-05T19:35:33.851Z`, sequence 14276. The installer replaced only verified companion processes and retained the previous app at `~/Applications/Local Dev.previous-native-1788636933099.app`.
- [x] Installed HTML and `assets/index-9CenDwtK.js` / `assets/index-DNgYcaCs.css` matched the verified production build byte-for-byte. Direct before/after SHA-256 checks confirmed the approval settings were unchanged. Evidence is in `build/release06-install-verification.json`.
- [ ] The live ChatGPT backend still exposes the earlier run.update schema. The new UI explicitly detects this and offers an owner-confirmed reconnect; the owner must then refresh the ChatGPT tool definitions to expose todos and steeringTasks. No silent backend/tunnel restart was performed. Isolated integration success is not represented as a real-model work-status acknowledgement.
- [ ] The optional `npm run polish` audit passed its embedded complete functional check but failed its code-health audit with **36 complexity findings, 3 duplicate groups, unused-code/style findings**, including new frontend/backend logic. The explicit SDK declaration addresses the unlisted test dependency; this is not a claim of a fully clean audit.
- [ ] Windows/Linux deployment, notarized distribution, and post-login/reboot behavior remain outside the verified macOS build. The packager still warns about its optional macOS iconset and unconfigured updater release URL; neither prevented native smoke verification or installed readiness.

Implementation and UI deployment are complete. Live backend activation remains an explicit owner-controlled step, not forgotten work hidden behind an acknowledgement.


## Space-efficiency update 0.6.1 — 2026-09-05

- [x] Measured the same two-call fixture at 1440×900, 1180×820, 1080×760, 760×680 and 390×780 in Chromium and WebKit before changing the layout. Baseline/update screenshots and measured rectangles are retained in `build/space-audit/`.
- [x] Consolidated duplicated follow/filter/expansion controls into one measured sticky toolbar; removed the repeated public note inside the active action; kept a single visible current update in the wide rail or compact pinned strip. Secondary facts, reported plan and quick settings have named keyboard-accessible disclosures. Exact record access, full goals/updates, task states and approval actions remain reachable.
- [x] Narrowed the redundant timestamp gutter, combined command/copy controls, and moved lower-priority tool metadata below output. The explicit-recipient composer uses 79–86px in the Chromium fixture instead of 113–127px, and grows for multiline drafts. Compact navigation uses named icon buttons instead of consuming a separate full brand/navigation stack. Body/code text was not reduced to obtain the space gains.
- [x] At 1080×760, initial visible expanded-action height improved from 147px to 335px and content width from 735px to 820px. At 760×680 it improved from 55px to 223px; at 390×780 from 0px to 228px. Rounded Chromium measurements are in `build/space-audit/comparison.json`; these are controlled fixture results, not universal guarantees for arbitrary long content.
- [x] Fixed a scroll/disclosure regression: reading suspension does not toggle the persisted auto-expansion preference. Automatic viewport changes cannot reopen manually collapsed actions. Explicit Resume live returns to an exclusive newest-action ancestor chain when automatic expansion is enabled. Unit and browser regressions cover both paths.
- [x] `npm run check` passed **84 backend tests, 38 desktop tests, and 92 Chromium/WebKit checks**, plus the retained SwiftUI/native integration checks and the packaged Electrobun native-webview/typed-RPC check. New tests protect minimum visible output, composer/gutter dimensions, long-goal access, full executable access, shared quick settings, multiline draft/recipient retention, and keyboard usability of compact navigation.
- [x] Visually reviewed the updated desktop and narrow fixture screenshots, including actual initial command-output visibility. No production source/log text was used as screenshot content.
- [x] Ran `npm run polish`; its functional check passed, but Fallow remains failing with 36 complexity findings, three clone groups and 30 dead-code/configuration findings across the working tree, including frontend code. Full audit output is saved as `build/space-audit/polish.log`; this is not a claimed clean audit.
- [x] Installed 0.6.1 at `/Users/johann/Applications/Local Dev.app`, replacing only verified companion processes 28741/28743. Previous companion retained at `/Users/johann/Applications/Local Dev.previous-native-1788638470663.app`.
- [x] Installed React DOM readiness confirmed in PID 34910; runtime `e1b14fd5-00a` recorded its viewer connection at `2026-09-05T20:01:11.368Z`, sequence 16629. Installed HTML, JS `index-aV3xeiuv.js` and CSS `index-BUgw9Efy.css` are byte-identical to the checked production bundle. The approval-settings fingerprint is unchanged. Evidence: `build/space-audit/install-evidence.json`.
- [ ] This update does not restart the MCP backend or resolve the earlier tool-schema activation boundary. Windows/Linux deployment, notarization, and reboot/login checks remain outside this layout verification. Optional iconset/update-URL packaging warnings remain unchanged.


## Terminal tail / right-rail update 0.6.2 — 2026-09-05

- [x] Wide right-rail Latest update is no longer sticky inside its independently scrollable context rail. The compact inline update behavior remains unchanged.
- [x] Collapsed command output renders only the final three lines of the selected All/stdout/stderr stream. It has no internal scrolling and no tab stop, so wheel input over the preview scrolls the main timeline.
- [x] Expand output explicitly switches to the full selected stream and bounded terminal scrolling; Follow new output appears only in this expanded state. Collapsing returns to the three-line tail. Preview-limited records still retrieve retained full output through the existing detail bridge.
- [x] Copy displayed output now copies the visible three-line tail while collapsed and the full selected stream while expanded. Command copy, output stream filters, wrapping, original record access, approvals, steering and live-follow behavior remain intact.
- [x] Browser regressions verify wheel propagation in collapsed mode and internal terminal scrolling only after expansion in Chromium and WebKit. The right-rail position regression verifies Latest update is not sticky.
- [x] Full repository verification passed **84 backend tests, 38 desktop tests, and 96 Chromium/WebKit checks**, plus native menu-bar/integration and packaged Electrobun native-webview checks.
- [x] Installed 0.6.2 at `/Users/johann/Applications/Local Dev.app`. React readiness confirmed in PID 40654; installed HTML/JS/CSS match the checked production bundle. Runtime `e1b14fd5-00a` recorded the new viewer at `2026-09-05T20:42:47.728Z`, sequence 17640. Approval settings are unchanged. Evidence: `build/output-preview-install-evidence.json`.
- [x] Previous companion retained at `/Users/johann/Applications/Local Dev.previous-native-1788640966995.app`. The tunnel/backend was not restarted.
- [ ] `npm run polish` still fails its broader Fallow health audit with 36 complexity findings, 30 unused/dead-code findings and three clone groups; the functional check inside it passed.


## macOS system clock correction 0.6.3 — 2026-09-05

- [x] Reproduced the owner’s mismatch on the actual Mac. Both AppleICUForce12HourTime and AppleICUForce24HourTime are absent, while `AppleLocale` is `en_US@rg=dezzzz`; Node’s environment locale was therefore incorrectly producing AM/PM.
- [x] System mode now reads the fixed, read-only `AppleLocale` key in addition to explicit force-hour keys. ICU `rg` region overrides are translated into an effective Intl locale (this machine: `en-DE`), and `hours`/`hc` h11/h12/h23/h24 modifiers are understood. Explicit force-hour keys still take precedence.
- [x] Direct host verification returned `{ hour12: false, locale: "en-DE", source: "macos" }` and formatted the live clock as `22:52` without AM/PM.
- [x] Settings now exposes **System (24-hour)** on this Mac, plus explicit **12-hour** and **24-hour** overrides. The persisted override applies to run/history/action timestamps and full timestamp tooltips; elapsed durations remain unchanged.
- [x] Time-format unit tests cover regional overrides, explicit hour-cycle modifiers, force-key precedence, missing preferences, midnight, history and tooltip formats. Chromium and WebKit verify the System (24-hour) label and switching/persistence of 12-hour and 24-hour overrides.
- [x] Full repository check passed **84 backend tests, 41 desktop tests, and 96 Chromium/WebKit checks**, plus the native menu-bar and packaged Electrobun native-webview integration checks.
- [x] Installed 0.6.3 at `/Users/johann/Applications/Local Dev.app`; React readiness confirmed in PID 42703. Installed HTML, JS `index-BlLR8HPa.js`, and CSS `index-BeJvP3O-.css` match the checked production build. Runtime `e1b14fd5-00a` recorded viewer connection sequence 18410 at `2026-09-05T20:54:10.895Z`. Approval settings are unchanged. Evidence: `build/system-clock-install-evidence.json`.
- [x] Previous companion retained at `/Users/johann/Applications/Local Dev.previous-native-1788641650052.app`. No backend/tunnel reconnect was performed.
