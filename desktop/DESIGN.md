# Local Dev 0.6 — approved lavender reference

## Deliverable

Implement the user's attached Local Dev reference as working React/Electrobun UI. Do not generate another mockup. The supplied image overrides the earlier dark-sidebar and execution-studio explorations.

Read the pinned frontend-design skill. The subject remains a real local execution companion: goals, tool calls, approvals, output, and steering. This design change does not alter execution permissions or transport.

## Direct visual mapping

- Pale, softly translucent lavender left sidebar with a dimensional violet terminal mark, violet selected navigation, and a bottom local-connection card.
- White/lavender workspace with a quiet top breadcrumb/search bar. The actual goal leads, beside a violet target medallion. No dark overview slab.
- Newest-first timeline with an external timestamp/node spine, individual elevated cards, green read icons, violet edit icons, and deep terminal icons. The newest expanded card gets a fine violet focus border; not a repeating animation.
- The expanded command is a dark inset terminal with the real command, full output controls, working directory, and exit state. The latest explicitly published assistant update appears as a lavender note associated with the run, not an invented per-command explanation.
- A right context column at desktop width contains Selected/Current run, Plan (only reported plan text), and live view-preference switches. On smaller windows, it moves below the main run as an accessible context disclosure rather than squeezing the timeline.
- A luminous but restrained steering composer stays available below the workspace. Its target and delivery limitation remain explicit.

Core tokens: pearl `#FBFBFF`, lavender `#F0EEFF`, ink `#202142`, muted `#686C90`, violet `#6354FF`, green `#249D68`. Semantic amber and red are reserved for waiting/failed activity. Shadows use violet-gray at low opacity. Shape hierarchy: 18px panels, 14px timeline cards, 10px controls, a circular target medallion.

Typography uses local system sans (SF/Segoe UI) for compact, crisp reading and local monospace for commands. Run heading 25–29px, action titles 14px, prose 13px, metadata 11px. No remote font or raster artwork is required: surfaces and icon treatments are CSS/SVG.

```text
Lavender sidebar  | breadcrumb            search / controls
                  | target + actual goal                 | Current run
Runs              | state / began / count / elapsed       | facts from records
Attention         | newest node -- expanded command card | Reported plan
Processes         |                 dark terminal        | text, no inferred ticks
Settings          |                 public update        | View preferences
Run history       | older node -- compact action card    | functional switches
Connection card   | explicit run boundary                 |
                  | steering input / recipient / Send    |
```

## Fidelity and product truth

Match the image's composition, color, depth, spacing, and timeline—not its example data. Do not invent a git branch, filesystem path, checklist completion, attachment support, project creation control, or live worker state. Show only a recorded command directory when available and label it as such. Plans remain public text rather than inferred checklists. Explicit `run.update.todos` and `steeringTasks` now provide a separate typed work-status model; render only those reported statuses and preserve unreported legacy states. Unreported context gets a clear empty state. Existing run history replaces the mockup's unsupported Add project action.

The right column is not decorative: View all expands actual recorded notes, quick settings use the same persisted preferences as Settings, and selected-run status distinguishes disconnected, waiting, idle-between-tools, and ended work. A connected runtime is not automatically a busy worker.

## Motion and accessibility

Reuse and test native CSS/Web Animations. A newly observed tool-call ID receives one brief reveal; a real terminal status change receives one acknowledgement. Older-history replay, output chunks, and elapsed clocks do not retrigger effects. Keep 230ms accordion transitions, inert collapsed panels, and focus recovery. Interface animations and OS Reduce Motion cancel CSS and JavaScript motion. No endless glow, forced scroll, retyped output, or fabricated thinking.

Keep default-on newest-call expansion and its manual disable setting. Compute newest identity using chronological data even though the display is newest-first. Nested ancestry stays open as necessary. Reading history must not retarget a steering draft.

## Verification

Test actual React components in Chromium and WebKit, including wide reference composition, dark mode, 1080px and 390px layouts, keyboard accessibility, right-column controls, truthful absent context, newest-first ordering, timeline motion lifecycle, full output, approvals, and steering. Review screenshots against the provided image. Build and smoke-test the packaged native webview, then replace only the tested companion with a backup and verify the installed asset bytes and approval-settings fingerprint.


## Space-efficiency pass — 0.6.1

Keep the approved pearl/lavender/violet identity and existing body/code text sizes. The task is to reclaim working space, not create a different theme or a tiny-text density mode.

Baseline measurements in `build/space-audit/before-*.json` show that a 1080×760 window exposes no command output initially, and a 390×780 window exposes no action. The fixed composer uses roughly 110–127px, duplicated follow/update regions add vertical overhead, and the action gutter plus padding uses roughly 100px on desktop.

Layout: retain one compact goal header; combine filter, auto-expansion and pause/resume-following into a single sticky toolbar; show the latest public note once per layout; narrow the node gutter because each action already carries an absolute timestamp. The command and its copy control share a row. Terminal output controls, full results and original records remain directly accessible. The composer uses one input row and one explicit-recipient row, growing for multiline drafts instead of reserving empty height. Secondary run facts, plan and quick preferences become named native disclosures in the right context panel. Public updates and every reported task/status remain priority content.

```text
navigation | compact goal + status                     | Latest public update
           | Activity / filters / auto-expand / follow | To-dos and directions
           | newest action + command / output         | Run details [expand]
           | older action                             | Plan [expand]
           | explicit start / end                     | View settings [expand]
           | [Steering instruction              Send] |
           | To: explicit recipient / delivery hint   |
```

Use one measured toolbar-height variable for the sticky note offset, not overlapping fixed-height guesses. Preserve full goals/updates through labeled expansion controls. Keep all approvals visible and all task statuses distinct. Test the same fixture and browser/window sizes before and after; protect minimum visible working area, keyboard controls, long content, narrow views, reduced motion, live-follow viewport preservation, and native packaging. No change to the backend activation boundary or approval policy.


### Terminal output refinement — 0.6.2

Compact command output is a true three-line tail, not a small nested scroll container. It renders the final three lines of the selected stream with no internal scroll region or tab stop, so ordinary wheel scrolling stays with the timeline. **Expand output** explicitly switches to the full selected stream (loading the retained archive when necessary), bounded terminal scrolling, and follow-output controls. **Copy displayed output** copies the same tail when compact and the full selected stream when expanded. The right-rail latest update remains available but is not sticky within that rail; compact inline update behavior is unchanged.


### System clock correction — 0.6.3

System time mode must follow macOS regional/hour-cycle settings even when explicit AppleICUForce12/24HourTime keys are absent. AppleLocale can encode a regional override (for example `en_US@rg=dezzzz`), so the host converts that fixed read-only locale into an effective Intl locale (`en-DE` here) before choosing the hour cycle. Explicit force keys and `@hours=h11/h12/h23/h24` still take precedence. Settings shows the detected result as **System (12-hour)** or **System (24-hour)** and retains manual 12-hour / 24-hour overrides.


## Ask — timed user choice (0.7.0)

Ask is a first-class clarification surface, not an approval card. ChatGPT supplies one concise question, 2–6 explicit options, and one explicit recommended option; custom text is available only when the tool sets allowOther. The card uses the existing lavender visual system, marks the recommendation visibly, stays keyboard usable at 390px, appears in the main workspace and Attention, and brings a newly pending question forward once through the tray/window shell. Countdown updates never repeatedly steal focus.

In manual policy there is no timeout. With Auto-approve all active, the backend starts a 90-second deadline and the card shows **Recommended in 1:30**. The user can choose any option or allowed custom answer before the deadline. If there is still no answer, the backend—not the renderer—returns exactly the declared recommended option. Pause or disabling auto-approve removes the deadline without discarding the question. Re-enabling auto-approve starts a fresh deadline; changing Remember alone does not restart one already running. Concurrent questions keep independent deadlines.

Ask is read-only and can be used after run.start but before the substantive-work to-do list, so a genuine ambiguity can be resolved before committing to a plan. It never auto-creates a free-text answer and does not bypass later command/edit approvals. The local journal records ask.requested, ask.answered and ask.cancelled; answers distinguish user from auto-recommended sources. Runtime close, operation abort and capture faults cancel pending questions rather than firing a late recommendation.


## Quiet utility pass — 0.7.1

The interface should read as a developer utility, not an AI concept dashboard. Keep the lavender accent as identity, but remove decorative gradients, glow, glass blur, orb-like controls, oversized rounded cards, and marketing copy. Use neutral flat surfaces, one violet accent, 6–8px control/card corners, separators in the inspector/settings, compact status treatments, and plain task-oriented labels. The terminal and recorded work are the highest-contrast surfaces.

A card is justified only when it groups an actionable unit (tool call, process, Ask). The right inspector is a continuous panel with separators rather than stacked floating cards. Status color communicates state; it does not decorate unrelated chrome. Decorative page icons and empty-state illustrations are omitted. Motion remains reserved for actual arrivals/disclosures and reduced-motion behavior is unchanged.


### Timeline axis refinement — 0.7.2

The activity timeline uses one explicit geometry axis shared by every root action connector, semantic node, and Start/End/open-run marker. Connector segments are 2px neutral lines drawn center-to-center between real action nodes, so the rail begins and ends at actual events instead of extending arbitrarily. Action nodes are 10px circles: completed green, waiting/denied/interrupted amber, failed red, running violet, with a restrained 1px outer ring for the latest action. No glow or gradient is used. The card border remains a uniform 1px so absolute timeline geometry cannot shift between latest and older actions. Responsive layouts change the content indent and section-axis together rather than maintaining unrelated node/line offsets.


### Brand exception — 0.7.3

The quiet utility treatment intentionally keeps one expressive brand element: the original Local Dev app mark. The sidebar logo returns to the larger violet/deep-purple gradient tile with its subtle dimensional border/shadow. This exception is limited to the brand mark; timeline nodes, cards, inspector, settings, Ask, terminal, and controls remain in the restrained flat 0.7.x system.


### Newest-first boundary chronology — 0.7.4

The activity timeline is newest first, so the current run boundary belongs above actions: an open run shows **Still in progress** first; a completed/interrupted run shows **End / Outcome reported by ChatGPT** first. Root actions then descend from newest to oldest, explicit earlier-history continuation remains below the visible rail, and **Start** stays at the bottom. This is chronological structure, not decoration.


### To-do elapsed clocks — 0.7.4

Run to-dos show compact elapsed clocks beside their explicit status, using the same wall-clock duration vocabulary as timeline actions. Open items tick once per second; completed/cancelled items freeze at their terminal timestamp. Timing is secondary metadata—not a progress estimate—and never changes the reported task status.


### Run status strip and active-work timers — 0.7.5

Run-level state is not a timeline event. **Still in progress**, **Connection lost**, and terminal outcome state render in a dedicated non-sticky run-status strip above Activity, beside/under the same run-level context as Latest update. The action timeline itself contains only recorded actions/history plus the Start boundary at its oldest end. Completed state shows the ended time, reported outcome label, and summary in the separate strip.

Run to-do timers measure active implementation time rather than task age. `queued` shows no timer. Entering `in_progress` starts or resumes the active segment. `paused` accumulates the current segment and freezes the displayed value. Returning to `in_progress` resumes from the accumulated active duration. `completed` and `cancelled` freeze permanently. The backend persists `activeElapsedMs` and `activeStartedAt`; `createdAt`/`endedAt` remain lifecycle/audit timestamps rather than the timer source.


### Terminal outcome card — 0.7.6

Active run state keeps the 14px micro-status line, but terminal outcomes no longer inherit that compressed presentation. Completed/failed/interrupted outcomes render as a calm run-level note above Activity with a neutral surface and outline, one semantic left rail/icon tile, state heading, muted provenance (`Outcome reported by ChatGPT`), ended time, and the reported summary as readable body text. Avoid mixing the violet action-card accent with green/red/warn outcome semantics in the same border treatment.


### Unified run-state cards and connected timeline — 0.7.7

All run-level states use one deliberate card grammar above Activity. Open/connected runs use the same neutral card, 28px semantic tile, rounded shape, state heading/detail, and semantic left rail as terminal outcomes; connected uses violet, connection-lost uses amber, completed uses green, failed red, and interrupted/cancelled amber. Terminal states may add the reported summary body; active states stay shorter.

The run-state card is not a timeline action, but it is visually continuous with the action history. Its bottom edge must meet the existing `runRail::before` segment exactly, and that segment lands on the shared `--timeline-axis` before the first action node. Do not add a second decorative connector or leave a gap between the state card and rail. Open-run spacing is compacted around the hero/Activity toolbar so the larger card does not regress protected command/output viewport space.


### Run-state card spacing — 0.7.8

Keep the unified run-state card system and direct card-to-timeline-spine connection from 0.7.7, but do not visually merge independent cards above it. Open runs keep a deliberate 6px gap between the Activity toolbar and run-state card. The state-card bottom still meets the existing `runRail::before` connector with no gap. Recover the added vertical spacing from redundant open-run hero/toolbar internals rather than weakening command/output visibility budgets; medium-width and narrow layouts have targeted compact padding for this purpose.


### Run-state to timeline spacing — 0.7.9

Keep independent cards separated on both sides of the run-state card. There is an 8px gap from the run-state card to the first action card. The existing shared timeline spine must bridge that gap continuously by extending the `runRail::before` segment upward; do not make the state card touch the first action just to preserve vertical density. The compact steering composer may surrender chrome height to preserve visible command output on short windows.
