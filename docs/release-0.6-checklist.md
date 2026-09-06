# Local Dev 0.6 acceptance checklist

Owner's requested scope, retained across verification and installation. Status must describe source, tests, and deployment separately; acknowledgement never means implementation complete.

| Requirement | Acceptance evidence | Status |
|---|---|---|
| Approved lavender design implemented in real React UI | Wide/narrow screenshots reviewed against supplied image; actual installed assets match build | Implemented; screenshots reviewed; installed assets match the verified 0.6 bundle |
| System/12-hour/24-hour timestamps | Host preference lookup, locale fallback, all timestamp/tooltip sites, persisted override, browser/native tests | Implemented, unit/browser tested, included in installed app |
| Newest-first and respectful live following | New call remains in view; reading older calls suspends following; Resume live; no recipient change | Implemented and tested in both engines, including actual visibility below pinned controls and preservation of older output |
| Automatic newest-call expansion | Default on, persisted off, nested ancestors, no reopen on output refresh, no viewport theft | Regression passed; persisted default-on setting, nested ancestors, manual reading protection |
| Tasteful timeline motion | Actual new IDs/status transitions only; CSS and JS both stop on reduced motion/setting off | Regression passed; persisted default-on setting, nested ancestors, manual reading protection |
| Steering work statuses | Queued/in progress/paused/completed/cancelled separate from delivery; no unreported legacy success | Implemented; real desktop/IPC/MCP lifecycle and journal replay passed; production backend activation pending |
| Durable AI to-dos | Required initial list before substantive MCP actions; stable IDs, outstanding work carried in results; no successful finish with unresolved items | Initial-list gate implemented; unresolved-work completion guard and stable linked tasks tested; production backend activation pending |
| Sticky public update | Right-hand independent context on wide screens; pinned compact update on smaller screens; full text accessible | Implemented; independent sticky right update and pinned compact update tested |
| Task/steering persistence | Journal reconstruction after viewer restart; unfinished tasks retained on interruption/failure | Real viewer restart and fresh archive reconstruction tested; interrupted/failed work remains explicit |
| Compatibility and controls | Old runtime/tool-list detection; no silent unsupported steering; stop/status recovery remains available | Capability warning and missing-list recovery tested; no silent restart or policy change |
| Release verification | Full npm run check, polish result disclosed, native smoke, installed DOM/asset check, unchanged approval settings | Full check passed: 84 backend + 37 desktop + 76 browser tests and native checks; installed DOM/assets verified; polish audit remains failing |
| Live backend activation | Real tool schema exposes work updates and required list; do not silently restart managed processes | Built and isolated integration verified; current live runtime still old. Owner-confirmed reconnect and tool refresh are the remaining activation step |

No automatic approval changes, real-user steering injection, dummy checklist success, private reasoning stream, or hidden tunnel restart. Windows/Linux shipping and reboot tests remain separately unverified.


## Installed evidence

Verified on 2026-09-05 at 19:35:59 UTC: installed desktop 0.6.0, PID 28743, DOM readiness true; HTML and assets `index-9CenDwtK.js` / `index-DNgYcaCs.css` match the tested build. Runtime `e1b14fd5-00a` recorded viewer connection sequence 14276. Pre/post-install settings SHA-256 matched; the installer did not restart the tunnel. Prior app: `~/Applications/Local Dev.previous-native-1788636933099.app`. Evidence: `build/release06-install-verification.json`.

The task fields exist in the compiled backend but are not yet exposed by this chat’s running backend/tool schema. Do not characterize acknowledgement-only historical messages as implemented tasks or claim live activation from the isolated tests.
