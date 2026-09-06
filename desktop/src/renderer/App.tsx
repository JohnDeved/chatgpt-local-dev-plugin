import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  HardDrive,
  Inbox,
  Layers,
  Bell,
  SquarePlay,
  Monitor,
  Moon,
  Pause,
  Play,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import type {
  ActionResult,
  DesktopBridge,
  DetailRequest,
  DetailResponse,
  RunItem,
  UiSnapshot,
} from "../shared/contracts.ts";
import { commandText } from "../shared/presentation.ts";
import { ActionButton, CallRow, RunCard } from "./RunTimeline.tsx";
import { RunClock, HistoryTimestamp, TimeFormatContext } from "./RunTime.tsx";
import { validTimeFormat, type TimeFormat } from "../shared/time-format.ts";
import s from "./app.module.css";
import { RunContext } from "./RunContext.tsx";
import { AskCard } from "./AskCard.tsx";
import { directoryLabel, runContextFacts } from "../shared/run-context.ts";

type Tab = "Runs" | "Attention" | "Processes" | "Settings";
const readSetting = (key: string, fallback = "") => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Keep the in-memory value when storage is unavailable. */
  }
};
const newest = (a: RunItem, b: RunItem) =>
  b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id);
const navItems = [
  { name: "Runs" as const, icon: SquarePlay },
  { name: "Attention" as const, icon: Bell },
  { name: "Processes" as const, icon: Monitor },
  { name: "Settings" as const, icon: Settings },
];

function BrandMark() {
  return <Terminal size={26} strokeWidth={1.8} aria-hidden="true" />;
}

export function App({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<UiSnapshot>();
  const [fatal, setFatal] = useState("");
  const [tab, setTab] = useState<Tab>("Runs");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<ActionResult>();
  const [selected, setSelected] = useState<DetailRequest>();
  const [connectionDetails, setConnectionDetails] = useState(false);
  const [selectedRun, setSelectedRun] = useState(readSetting("local-dev-selected-run"));
  const [target, setTarget] = useState(readSetting("local-dev-steering-target"));
  const [draft, setDraft] = useState(readSetting("local-dev-steering-draft"));
  const [sending, setSending] = useState(false);
  const [theme, setTheme] = useState(readSetting("local-dev-theme", "system"));
  const [animations, setAnimations] = useState(
    () => readSetting("local-dev-animations", "true") !== "false",
  );
  useEffect(() => {
    document.documentElement.dataset.motion = animations ? "on" : "off";
    writeSetting("local-dev-animations", String(animations));
  }, [animations]);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(() =>
    validTimeFormat(readSetting("local-dev-time-format", "system")),
  );
  const [followLive, setFollowLive] = useState(
    () => readSetting("local-dev-follow-live", "true") !== "false",
  );
  useEffect(() => {
    writeSetting("local-dev-time-format", timeFormat);
  }, [timeFormat]);
  useEffect(() => {
    writeSetting("local-dev-follow-live", String(followLive));
  }, [followLive]);
  const [showHistory, setShowHistory] = useState(false);
  const [autoExpandLatest, setAutoExpandLatest] = useState(
    readSetting("local-dev-auto-expand", "true") !== "false",
  );
  useEffect(() => {
    writeSetting("local-dev-auto-expand", String(autoExpandLatest));
  }, [autoExpandLatest]);
  const [runLimit, setRunLimit] = useState(20);
  const [hideReviewed, setHideReviewed] = useState(new Set<string>());
  const attempt = useRef<{ target: string; text: string; id: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const main = useRef<HTMLElement>(null);
  const notifiedReady = useRef(false);
  const notify = (result: ActionResult) => {
    if (!result.cancelled) setNotice(result);
  };
  useEffect(() => {
    const accept = (value: UiSnapshot) =>
      setState((current) => (!current || value.revision >= current.revision ? value : current));
    const dispose = bridge.subscribe(accept);
    void bridge
      .snapshot()
      .then(accept)
      .catch((error: unknown) => setFatal(String(error)));
    return dispose;
  }, [bridge]);
  useEffect(() => {
    if (state && !notifiedReady.current) {
      notifiedReady.current = true;
      void bridge.ready();
    }
  }, [bridge, !!state]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeSetting("local-dev-theme", theme);
  }, [theme]);
  useEffect(() => {
    writeSetting("local-dev-steering-draft", draft);
  }, [draft]);
  useEffect(() => {
    writeSetting("local-dev-steering-target", target);
  }, [target]);
  useEffect(() => {
    writeSetting("local-dev-selected-run", selectedRun);
  }, [selectedRun]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setTab("Runs");
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const live = state?.runtimes.filter((runtime) => runtime.connected) ?? [];
  const activeRuns =
    state?.runs.filter(
      (run) =>
        run.connected &&
        run.state === "running" &&
        run.origin === "assistant" &&
        live.some((runtime) => runtime.id === run.runtimeId && runtime.supportsRuns),
    ) ?? [];
  useEffect(() => {
    if (!target && activeRuns.length === 1) setTarget(activeRuns[0].id);
  }, [activeRuns.map((run) => run.id).join(","), target]);
  const chosenRun = activeRuns.find((run) => run.id === target);
  const steer = (id: string) => {
    setTarget(id);
    composer.current?.focus();
  };
  const pickRun = (id: string) => {
    setSelectedRun(id);
    setTab("Runs");
    main.current?.scrollTo({ top: 0 });
  };
  const send = async () => {
    if (!chosenRun || sending || !draft.trim() || draft.length > 4000) return;
    const text = draft.trim();
    const id =
      attempt.current?.target === target && attempt.current.text === text
        ? attempt.current.id
        : crypto.randomUUID();
    attempt.current = { target, text, id };
    setSending(true);
    try {
      const result = await bridge.act({
        type: "steer",
        runtimeId: chosenRun.runtimeId,
        runId: chosenRun.runId,
        messageId: id,
        text,
      });
      notify(result);
      if (result.ok) {
        setDraft((current) => (current.trim() === text ? "" : current));
        attempt.current = null;
      }
    } catch (error) {
      notify({ ok: false, message: String(error) });
    } finally {
      setSending(false);
    }
  };
  if (fatal)
    return (
      <main className={s.fatal}>
        <Unplug size={30} />
        <h1>Local connection unavailable</h1>
        <p>{fatal}</p>
        <p>Reopen the desktop companion. No local control was executed.</p>
      </main>
    );
  if (!state)
    return (
      <main className={s.fatal}>
        <BrandMark />
        <h1>Local Dev</h1>
        <p>Bringing your workspace into view…</p>
      </main>
    );

  const ui = { bridge, notify, inspect: setSelected, paused: state.preference.paused };
  const pending = state.calls.filter((call) => call.state === "waiting");
  const asks = live.flatMap((runtime) =>
    (runtime.asks ?? []).map((ask) => ({ ask, runtimeId: runtime.id })),
  );
  const failed = state.calls.filter(
    (call) => call.state === "failed" && !hideReviewed.has(call.id),
  );
  const processes = live.flatMap((runtime) =>
    runtime.processes.map((process) => ({ ...process, runtimeId: runtime.id })),
  );
  const matches = [...state.runs]
    .filter(
      (run) =>
        !query ||
        `${run.title} ${run.goal ?? ""} ${run.summary ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()) ||
        state.calls.some(
          (call) =>
            call.runtimeId === run.runtimeId &&
            call.runId === run.runId &&
            `${call.title} ${call.target} ${call.commands.map((command) => command.argv.join(" ")).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        ),
    )
    .sort(newest);
  const currentRuns = matches.filter((run) => run.state === "running");
  const previousRuns = matches.filter((run) => run.state !== "running");
  const focus = matches.find((run) => run.id === selectedRun) ?? currentRuns[0] ?? matches[0];
  const focusedCalls = focus
    ? state.calls.filter((call) => call.runtimeId === focus.runtimeId && call.runId === focus.runId)
    : [];
  const orphans = state.calls.filter((call) => !call.runId && !call.parentId);
  const focusedFacts = focus ? runContextFacts(focus, focusedCalls) : undefined;
  const showContext = tab === "Runs" && !!focus;
  const platformName =
    state.platform === "darwin"
      ? "This Mac"
      : state.platform === "win32"
        ? "This PC"
        : "This machine";
  const connected = state.connection.status === "connected";
  const breadcrumbs: Record<Tab, string> = {
    Runs: "Run workspace",
    Attention: "Review queue",
    Processes: "Background services",
    Settings: "Preferences",
  };
  const runLink = (run: RunItem) => (
    <button
      className={`${s.runLink} ${focus?.id === run.id && tab === "Runs" ? s.runLinkSelected : ""}`}
      key={run.id}
      aria-label={`Open run: ${run.title}`}
      aria-pressed={focus?.id === run.id && tab === "Runs"}
      onClick={() => pickRun(run.id)}
      title={run.title}
    >
      <span className={s.runLinkGlyph}>
        {run.state === "completed" ? (
          <CheckCircle2 size={14} />
        ) : run.state === "failed" ? (
          <AlertCircle size={14} />
        ) : (
          <span className={run.connected ? s.liveDot : s.offlineDot} />
        )}
      </span>
      <span>
        <strong>{run.title}</strong>
        <small className={s.runLinkMeta}>
          <span>
            {run.state === "running"
              ? run.connected
                ? "Run open"
                : "Disconnected"
              : run.state === "completed"
                ? "Completed"
                : run.state === "interrupted"
                  ? "Completion unknown"
                  : run.state}
          </span>
          <RunClock run={run} compact />
        </small>
        <HistoryTimestamp value={run.startedAt} className={s.historyTimestamp} />
      </span>
    </button>
  );
  return (
    <TimeFormatContext.Provider value={{ mode: timeFormat, system: state.systemClock }}>
      <div className={s.app} data-design="lavender-reference-0.6">
        <aside className={s.sidebar} aria-label="Workspace navigation">
          <div className={s.brand}>
            <span className={s.brandIcon}>
              <BrandMark />
            </span>
            <div>
              <h1>Local Dev</h1>
              <p>Local activity</p>
            </div>
          </div>
          <nav className={s.tabs} aria-label="Main navigation">
            {navItems.map(({ name, icon: Icon }) => (
              <button
                key={name}
                aria-label={name}
                title={name}
                aria-current={tab === name ? "page" : undefined}
                onClick={() => {
                  setTab(name);
                  main.current?.scrollTo({ top: 0 });
                }}
              >
                <Icon size={17} />
                <span>{name}</span>
                {name === "Attention" && pending.length + failed.length + asks.length > 0 && (
                  <b aria-hidden="true">{pending.length + failed.length + asks.length}</b>
                )}
                {name === "Processes" && processes.length > 0 && (
                  <small aria-hidden="true">{processes.length}</small>
                )}
              </button>
            ))}
          </nav>
          <div className={s.runBrowser}>
            {currentRuns.length > 0 && (
              <section>
                <h2>
                  In progress <span>{currentRuns.length}</span>
                </h2>
                {currentRuns.map(runLink)}
              </section>
            )}
            <section>
              <h2>
                {query ? "Search results" : "Recent runs"}
                <span>{previousRuns.length}</span>
              </h2>
              {previousRuns.slice(0, runLimit).map(runLink)}
              {!previousRuns.length && (
                <p className={s.navEmpty}>
                  {query ? "No earlier runs match." : "Completed runs appear here."}
                </p>
              )}
            </section>
            {previousRuns.length > runLimit && (
              <button className={s.navMore} onClick={() => setRunLimit(runLimit + 20)}>
                Show more runs
              </button>
            )}
            {(state.archive.runs > state.runs.length ||
              state.archive.calls > state.calls.length) && (
              <button
                className={s.navMore}
                onClick={() =>
                  void bridge
                    .snapshot(state.archive.shown + 100)
                    .then(setState)
                    .catch((error: unknown) => notify({ ok: false, message: String(error) }))
                }
              >
                Load earlier history
              </button>
            )}
          </div>
          <div className={s.machinePanel}>
            <span className={s.machineIcon}>
              <Monitor size={18} />
            </span>
            <div>
              <strong>{platformName}</strong>
              <span>
                <i className={connected ? s.liveDot : s.offlineDot} />
                {connected
                  ? `${live.length} local ${live.length === 1 ? "runtime" : "runtimes"}`
                  : "Runtime offline"}
              </span>
            </div>
            <ShieldCheck size={15} />
          </div>
          <div className={s.sidebarFooter}>
            <span>Local only</span>
            <span>v{state.version}</span>
          </div>
        </aside>
        <div className={s.workspace}>
          <header className={s.header}>
            <div className={s.breadcrumb}>
              <FolderOpen size={17} />
              <span title={focusedFacts?.directory}>{directoryLabel(focusedFacts?.directory)}</span>
              <ChevronRight size={13} />
              <strong title={tab === "Runs" ? focus?.title : breadcrumbs[tab]}>
                {tab === "Runs" ? (focus?.title ?? breadcrumbs[tab]) : breadcrumbs[tab]}
              </strong>
            </div>
            <div className={s.searchRow}>
              <Search size={14} />
              <input
                ref={search}
                type="search"
                aria-label="Search runs and commands"
                placeholder="Search runs, files, or commands…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setTab("Runs");
                }}
              />
              <kbd>⌘ K</kbd>
            </div>
            <div className={s.headerControls}>
              <button
                className={`${s.permissionChip} ${state.preference.autoApprove ? s.permissionAutomatic : ""}`}
                onClick={() => setTab("Settings")}
                title={
                  state.preference.autoApprove
                    ? "Auto-approve all is on. Open settings to change it."
                    : "Actions that require permission will ask first."
                }
              >
                <ShieldCheck size={13} />
                <span>
                  {state.preference.autoApprove
                    ? state.preference.pending
                      ? "Auto-approve pending"
                      : "Auto-approve on"
                    : "Ask before acting"}
                </span>
              </button>
              <button
                className={s.iconButton}
                aria-label="Switch appearance"
                title="Toggle color theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <ActionButton
                {...ui}
                action={{ type: "pause", paused: !state.preference.paused }}
                className={s.secondary}
              >
                {state.preference.paused ? (
                  <>
                    <Play size={13} />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause size={13} />
                    Pause
                  </>
                )}
              </ActionButton>
              <ActionButton
                {...ui}
                action={{ type: "stopAll" }}
                className={s.iconButton}
                disabled={!live.length}
              >
                <span className={s.srOnly}>Stop all work</span>
                <Square size={15} />
              </ActionButton>
            </div>
          </header>
          {state.preference.paused && (
            <div className={s.pausedNote}>
              <Pause size={13} />
              <span>New actions are paused. Existing work is not automatically stopped.</span>
            </div>
          )}
          {notice?.message && (
            <div
              role={notice.ok ? "status" : "alert"}
              className={`${s.notice} ${notice.ok ? "" : s.noticeError}`}
            >
              {notice.ok ? <Check size={15} /> : <AlertCircle size={15} />}
              <span>{notice.message}</span>
              <button
                className={s.iconButton}
                aria-label="Dismiss notification"
                onClick={() => setNotice(undefined)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className={s.workspaceBody} data-with-context={showContext}>
            <div className={s.primaryColumn}>
              <main ref={main} className={s.main}>
                {live.some(
                  (runtime) => runtime.workTracking === false || runtime.supportsAsk === false,
                ) && (
                  <section className={s.connectionCard} aria-label="Work tracking activation">
                    <ShieldCheck size={21} />
                    <div>
                      <h2>Ask and work tracking need the updated runtime</h2>
                      <p>
                        The UI is updated, but this backend cannot surface Ask questions or report
                        steering/to-do states yet. Reconnect, then refresh ChatGPT tools to load the
                        new Ask and run.update fields.
                      </p>
                      <ActionButton {...ui} action={{ type: "reconnect" }} className={s.secondary}>
                        Reconnect updated runtime…
                      </ActionButton>
                      <p className={s.quiet}>
                        You will be asked first; managed commands may stop. Existing activity and
                        approvals remain available.
                      </p>
                    </div>
                  </section>
                )}
                {!live.length && (
                  <section className={s.connectionCard}>
                    <Unplug size={24} />
                    <div>
                      <h2>
                        {state.connection.status === "update"
                          ? "A fresh connection is needed"
                          : "Your workspace is offline"}
                      </h2>
                      <p>{state.connection.message}</p>
                      <div className={s.buttonRow}>
                        {state.connection.configured && (
                          <ActionButton
                            {...ui}
                            action={{ type: "reconnect" }}
                            className={s.primary}
                          >
                            Reconnect runtime…
                          </ActionButton>
                        )}
                        <ActionButton
                          {...ui}
                          action={{ type: "checkConnection" }}
                          className={s.textButton}
                        >
                          Check again
                        </ActionButton>
                        <button className={s.textButton} onClick={() => setConnectionDetails(true)}>
                          Connection details
                        </button>
                      </div>
                      <small>
                        Reconnecting may stop commands managed by the old runtime. You will be asked
                        first.
                      </small>
                    </div>
                  </section>
                )}
                {tab !== "Attention" && asks.length > 0 && (
                  <div className={s.askStack} aria-label="Pending questions">
                    {[...asks]
                      .sort(
                        (a, b) =>
                          Number(b.ask.runId === focus?.runId) -
                          Number(a.ask.runId === focus?.runId),
                      )
                      .map(({ ask, runtimeId }) => (
                        <AskCard
                          key={`${runtimeId}:${ask.id}`}
                          ask={ask}
                          runtimeId={runtimeId}
                          bridge={bridge}
                          autoApprove={state.preference.autoApprove}
                          paused={state.preference.paused}
                          notify={notify}
                        />
                      ))}
                  </div>
                )}
                {state.errors.length > 0 && (
                  <details className={s.errorPanel}>
                    <summary>
                      <AlertCircle size={15} />
                      Activity needs attention ({state.errors.length})
                    </summary>
                    {state.errors.map((error, index) => (
                      <pre key={index}>{error}</pre>
                    ))}
                  </details>
                )}
                {tab === "Runs" && (
                  <>
                    <div className={s.mobileRunPicker}>
                      <label htmlFor="selected-run">Viewing</label>
                      <select
                        id="selected-run"
                        aria-label="Selected run"
                        value={focus?.id ?? ""}
                        onChange={(event) => pickRun(event.target.value)}
                      >
                        {!matches.length && <option value="">No runs available</option>}
                        {matches.map((run) => (
                          <option value={run.id} key={run.id}>
                            {run.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    {pending.length > 0 && !focus && (
                      <button className={s.attentionLink} onClick={() => setTab("Attention")}>
                        <span className={s.attentionSymbol}>
                          <ShieldCheck size={17} />
                        </span>
                        <div>
                          <strong>
                            {pending.length === 1
                              ? "One action needs your permission"
                              : `${pending.length} actions need your permission`}
                          </strong>
                          <span>Review it before work continues.</span>
                        </div>
                        <span className={s.grow} />
                        <span>Review</span>
                        <ChevronRight size={15} />
                      </button>
                    )}
                    {state.archive.loading && (
                      <p className={s.quiet}>Indexing more local history…</p>
                    )}
                    {focus ? (
                      <RunCard
                        key={focus.id}
                        run={focus}
                        calls={focusedCalls}
                        onSteer={steer}
                        onReview={() => setTab("Attention")}
                        animations={animations}
                        followLive={followLive}
                        onFollowLiveChange={setFollowLive}
                        followNewest={autoExpandLatest}
                        onFollowNewestChange={setAutoExpandLatest}
                        {...ui}
                      />
                    ) : (
                      <section className={s.empty}>
                        <div className={s.emptyIllustration} aria-hidden="true">
                          <span>
                            <Play size={15} />
                          </span>
                          <i />
                          <span>
                            <Terminal size={15} />
                          </span>
                          <i />
                          <span>
                            <Check size={15} />
                          </span>
                        </div>
                        <h2>{query ? "No matching runs" : "No runs yet"}</h2>
                        <p>
                          {query
                            ? "Try a goal, filename, or command. Your local archive is still available."
                            : "Start a task in ChatGPT to see its local actions here."}
                        </p>
                        {query && (
                          <button className={s.secondary} onClick={() => setQuery("")}>
                            Clear search
                          </button>
                        )}
                      </section>
                    )}
                    {orphans.length > 0 && (
                      <section className={s.legacy}>
                        <button
                          className={s.moreButton}
                          aria-expanded={showHistory}
                          onClick={() => setShowHistory(!showHistory)}
                        >
                          {showHistory ? "Hide" : "Show"} earlier ungrouped activity{" "}
                          <span>{orphans.length} calls</span>
                        </button>
                        {showHistory && (
                          <>
                            <p className={s.quiet}>
                              These events have no reported run boundary or goal. They are not
                              labeled as completed runs.
                            </p>
                            {orphans.map((call) => (
                              <CallRow key={call.id} call={call} allCalls={state.calls} {...ui} />
                            ))}
                          </>
                        )}
                      </section>
                    )}
                  </>
                )}
                {tab === "Attention" && (
                  <>
                    <div className={s.pageTitle}>
                      <span className={s.pageIcon}>
                        <Inbox size={21} />
                      </span>
                      <h2>Attention</h2>
                      <p>Questions, approvals, and failed actions.</p>
                    </div>
                    {asks.length > 0 && (
                      <>
                        <div className={s.sectionHeading}>
                          <h3>Questions waiting for you</h3>
                          <span className={s.countBadge}>{asks.length}</span>
                        </div>
                        <div className={s.askStack}>
                          {asks.map(({ ask, runtimeId }) => (
                            <AskCard
                              key={`${runtimeId}:${ask.id}`}
                              ask={ask}
                              runtimeId={runtimeId}
                              bridge={bridge}
                              autoApprove={state.preference.autoApprove}
                              paused={state.preference.paused}
                              notify={notify}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    <div className={s.sectionHeading}>
                      <h3>Awaiting your approval</h3>
                      <span className={s.countBadge}>{pending.length}</span>
                    </div>
                    {pending.length ? (
                      pending.map((call) => (
                        <CallRow key={call.id} call={call} allCalls={state.calls} {...ui} />
                      ))
                    ) : (
                      <p className={s.positiveEmpty}>
                        <CheckCircle2 size={22} />
                        <span>
                          <strong>All clear.</strong>No approvals are waiting.
                        </span>
                      </p>
                    )}
                    {failed.length > 0 && (
                      <>
                        <div className={s.sectionHeading}>
                          <h3>
                            Failed actions <span className={s.countBadge}>{failed.length}</span>
                          </h3>
                          <button
                            className={s.textButton}
                            onClick={() =>
                              setHideReviewed(
                                new Set([...hideReviewed, ...failed.map((call) => call.id)]),
                              )
                            }
                          >
                            Mark these reviewed
                          </button>
                        </div>
                        {failed.map((call) => (
                          <CallRow key={call.id} call={call} allCalls={state.calls} {...ui} />
                        ))}
                      </>
                    )}
                  </>
                )}
                {tab === "Processes" && (
                  <>
                    <div className={s.pageTitle}>
                      <span className={s.pageIcon}>
                        <Terminal size={21} />
                      </span>
                      <h2>Processes</h2>
                      <p>Background commands owned by Local Dev.</p>
                    </div>
                    {!processes.length && (
                      <section className={s.empty}>
                        <div className={s.emptyIllustration} aria-hidden="true">
                          <span>
                            <Terminal size={22} />
                          </span>
                        </div>
                        <h3>No background processes</h3>
                        <p>
                          Processes owned and reported by connected Local Dev runtimes will appear
                          here.
                        </p>
                      </section>
                    )}
                    {processes.map((process) => (
                      <section className={s.process} key={process.id}>
                        <div>
                          <span className={s.processGlyph}>
                            <Terminal size={18} />
                          </span>
                          <strong>{process.argv[0]?.split(/[\\/]/).at(-1)}</strong>
                          <span className={s.processRunning}>
                            <i />
                            Running
                          </span>
                          <span className={s.grow} />
                          <ActionButton
                            {...ui}
                            action={{
                              type: "stopProcess",
                              runtimeId: process.runtimeId,
                              processId: process.id,
                            }}
                            className={s.secondary}
                          >
                            Stop process
                          </ActionButton>
                        </div>
                        <pre>{commandText(process.argv)}</pre>
                        <p>
                          <FolderOpen size={13} />
                          {process.cwd}
                        </p>
                        <div className={s.processFooter}>
                          <span>PID {process.pid}</span>
                          <span className={s.grow} />
                          <button
                            className={s.textButton}
                            onClick={() =>
                              setSelected({
                                runtimeId: process.runtimeId,
                                operationId: process.operationId,
                                processId: process.id,
                                mode: "output",
                                channel: "all",
                              })
                            }
                          >
                            View full output
                            <ChevronRight size={13} />
                          </button>
                        </div>
                      </section>
                    ))}
                  </>
                )}
                {tab === "Settings" && (
                  <>
                    <div className={s.pageTitle}>
                      <span className={s.pageIcon}>
                        <Settings size={21} />
                      </span>
                      <h2>Settings</h2>
                      <p>Local permissions and interface preferences.</p>
                    </div>
                    <section className={s.settingSection}>
                      <div className={s.settingHeading}>
                        <ShieldCheck size={19} />
                        <div>
                          <h3>Permissions</h3>
                          <p>Controls enforced by the local runtime.</p>
                        </div>
                      </div>
                      <div className={s.settingRow}>
                        <div>
                          <h4>Auto-approve all</h4>
                          <p>
                            Run supported commands, edits, deletions, and approvals without repeated
                            prompts.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label="Auto-approve all"
                          checked={state.preference.autoApprove}
                          onChange={(event) =>
                            void bridge
                              .act({
                                type: "policy",
                                autoApprove: event.target.checked,
                                remember: state.preference.remember,
                              })
                              .then(notify)
                              .catch((error: unknown) =>
                                notify({ ok: false, message: String(error) }),
                              )
                          }
                        />
                      </div>
                      <label className={s.checkboxRow}>
                        <input
                          type="checkbox"
                          checked={state.preference.remember}
                          onChange={(event) =>
                            void bridge
                              .act({
                                type: "policy",
                                autoApprove: state.preference.autoApprove,
                                remember: event.target.checked,
                              })
                              .then(notify)
                              .catch((error: unknown) =>
                                notify({ ok: false, message: String(error) }),
                              )
                          }
                        />
                        Remember across restarts
                      </label>
                      <p className={s.quiet}>
                        {state.preference.pending
                          ? "Your preference is queued for the next runtime connection."
                          : "Without Remember, auto-approval lasts for this desktop session. Pause always blocks new actions."}
                      </p>
                    </section>
                    <section className={s.settingSection}>
                      <div className={s.settingHeading}>
                        <Sun size={19} />
                        <div>
                          <h3>Appearance</h3>
                          <p>Display and timeline preferences.</p>
                        </div>
                      </div>
                      <div className={s.settingRow}>
                        <div>
                          <h4>Auto-expand newest activity</h4>
                          <p>
                            Open each new tool call and close the preceding one. Output and status
                            updates never reopen an item you collapsed. Your selected run and scroll
                            position stay put.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label="Auto-expand newest activity"
                          checked={autoExpandLatest}
                          onChange={(event) => setAutoExpandLatest(event.target.checked)}
                        />
                      </div>
                      <div className={s.settingDivider} />
                      <div className={s.settingRow}>
                        <div>
                          <h4>Follow live activity</h4>
                          <p>
                            Keep new actions at the top while following. Scrolling back pauses
                            following until you return to the top or choose Resume live.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label="Follow live activity"
                          checked={followLive}
                          onChange={(event) => setFollowLive(event.target.checked)}
                        />
                      </div>
                      <div className={s.settingDivider} />
                      <label className={s.settingRow}>
                        Time format
                        <select
                          aria-label="Time format"
                          value={timeFormat}
                          onChange={(event) => setTimeFormat(validTimeFormat(event.target.value))}
                        >
                          <option value="system">
                            {state.systemClock
                              ? `System (${state.systemClock.hour12 ? "12-hour" : "24-hour"})`
                              : "System"}
                          </option>
                          <option value="12h">12-hour</option>
                          <option value="24h">24-hour</option>
                        </select>
                      </label>
                      <p className={s.quiet}>
                        {state.systemClock
                          ? `Currently following ${state.systemClock.hour12 ? "12-hour" : "24-hour"} time from ${state.systemClock.source === "macos" ? "macOS regional settings" : "the system locale"}.`
                          : "Following the system clock style."}{" "}
                        The override applies to all absolute timestamps and tooltips; elapsed
                        durations are unchanged.
                      </p>
                      <div className={s.settingDivider} />
                      <label className={s.settingRow}>
                        Color theme
                        <select
                          aria-label="Color theme"
                          value={theme}
                          onChange={(event) => setTheme(event.target.value)}
                        >
                          <option value="system">Follow system</option>
                          <option value="light">Light</option>
                          <option value="dark">Dark</option>
                        </select>
                      </label>
                      <div className={s.settingDivider} />
                      <div className={s.settingRow}>
                        <div>
                          <h4>Interface animations</h4>
                          <p>
                            Smooth disclosures and short state transitions. Your system’s Reduce
                            Motion preference always takes priority.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label="Interface animations"
                          checked={animations}
                          onChange={(event) => setAnimations(event.target.checked)}
                        />
                      </div>
                      <div className={s.themePreviews} aria-hidden="true">
                        <div className={s.previewLight}>
                          <i />
                          <span>
                            <b />
                            <b />
                            <b />
                          </span>
                        </div>
                        <div className={s.previewDark}>
                          <i />
                          <span>
                            <b />
                            <b />
                            <b />
                          </span>
                        </div>
                      </div>
                      <p className={s.quiet}>
                        System fonts, visible keyboard focus, and reduced motion. Preferences are
                        stored locally.
                      </p>
                    </section>
                    <section className={s.settingSection}>
                      <div className={s.settingHeading}>
                        <Monitor size={19} />
                        <div>
                          <h3>Connection & startup</h3>
                          <p>{state.connection.message}</p>
                        </div>
                      </div>
                      <div className={s.buttonRow}>
                        <ActionButton
                          {...ui}
                          action={{ type: "reconnect" }}
                          className={s.secondary}
                          disabled={!state.connection.configured && !live.length}
                        >
                          Reconnect…
                        </ActionButton>
                        <button className={s.textButton} onClick={() => setConnectionDetails(true)}>
                          Connection details
                        </button>
                        <ActionButton
                          {...ui}
                          action={{ type: "openLoginSettings" }}
                          className={s.textButton}
                        >
                          Open startup settings
                        </ActionButton>
                      </div>
                      <p className={s.quiet}>
                        Closing the window keeps the tray companion running. Quitting first pauses
                        new local actions.
                      </p>
                    </section>
                    <section className={s.settingSection}>
                      <div className={s.settingHeading}>
                        <HardDrive size={19} />
                        <div>
                          <h3>Your local archive</h3>
                          <p>Full records, without masking or automatic deletion.</p>
                        </div>
                      </div>
                      <p>
                        Captured inputs, output, environment values, and diagnostics can contain
                        secrets. They stay local unless you explicitly export them.
                      </p>
                      <code className={s.archivePath}>{state.archive.directory}</code>
                      <div className={s.buttonRow}>
                        <ActionButton
                          {...ui}
                          action={{ type: "openArchive" }}
                          className={s.secondary}
                        >
                          <FolderOpen size={13} />
                          Open archive
                        </ActionButton>
                        <span className={s.muted}>
                          {(state.archive.bytes / 1024 / 1024).toFixed(1)} MB /{" "}
                          {state.archive.events.toLocaleString()} events
                        </span>
                      </div>
                      <p className={s.quiet}>
                        Public plans and decision summaries are shown when reported; private
                        thinking is not captured. Other programs running as your OS user can access
                        local controls. This is not a sandbox against same-user code.
                      </p>
                    </section>
                  </>
                )}
              </main>
              {tab !== "Settings" && (
                <section className={s.composer} aria-label="Steering composer">
                  <div className={s.composerFrame} data-has-draft={!!draft}>
                    <div className={s.composerInput}>
                      <textarea
                        ref={composer}
                        aria-label="Steering instruction"
                        placeholder="Tell Local Dev what to do next…"
                        rows={Math.max(1, Math.min(5, draft.split("\n").length))}
                        style={{
                          height: Math.max(36, Math.min(5, draft.split("\n").length) * 20 + 14),
                        }}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key === "Enter" &&
                            !event.nativeEvent.isComposing
                          ) {
                            event.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <button
                        className={s.primary}
                        disabled={!chosenRun || !draft.trim() || draft.length > 4000 || sending}
                        onClick={() => void send()}
                      >
                        <ArrowUp size={15} />
                        {sending ? "Queuing…" : "Send"}
                      </button>
                      {!chosenRun && draft && (
                        <button
                          className={s.iconButton}
                          aria-label="Copy steering draft"
                          onClick={() => void bridge.copy(draft).then(notify)}
                        >
                          <Copy size={15} />
                        </button>
                      )}
                    </div>

                    <div className={s.composerHeading}>
                      <GitBranch size={13} />
                      <label htmlFor="steering-recipient">To</label>
                      <select
                        id="steering-recipient"
                        aria-label="Target run"
                        value={chosenRun ? target : ""}
                        onChange={(event) => setTarget(event.target.value)}
                      >
                        <option value="">Choose a connected run</option>
                        {activeRuns.map((run) => (
                          <option key={run.id} value={run.id}>
                            {run.title}
                          </option>
                        ))}
                      </select>
                      <span className={s.grow} />
                      <span
                        className={s.deliveryHint}
                        title="Your instruction is delivered on the next tool response, then acknowledged. Running work is not undone."
                      >
                        Next tool response
                      </span>
                      <kbd title="Send with Command or Control plus Enter">⌘ / Ctrl ↵</kbd>
                    </div>
                    {(!chosenRun || draft.length > 4000) && (
                      <div className={s.composerFoot}>
                        {" "}
                        <p>
                          {draft.length > 4000
                            ? "Keep the instruction within 4,000 characters. Nothing has been sent."
                            : chosenRun
                              ? "Next tool response, then acknowledgement. Running work is not undone."
                              : state.runs.some(
                                    (run) =>
                                      run.connected &&
                                      run.state === "running" &&
                                      run.origin !== "assistant",
                                  )
                                ? "Ask ChatGPT to call run.start. Your draft stays here until run reporting is ready."
                                : "A connected, open run is needed. This cannot wake a finished conversation."}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
            {showContext && focus && (
              <RunContext
                key={focus.id}
                run={focus}
                calls={focusedCalls}
                autoExpand={autoExpandLatest}
                animations={animations}
                paused={state.preference.paused}
                onAutoExpandChange={setAutoExpandLatest}
                onAnimationsChange={setAnimations}
                onSettings={() => setTab("Settings")}
              />
            )}
          </div>
          <footer className={s.footer}>
            <ShieldCheck size={12} />
            <span>Local activity archive</span>
            <span className={s.grow} />
            <span className={s.connectionLabel}>
              <i className={connected ? s.liveDot : s.offlineDot} />
              {connected ? "Connected locally" : "Offline"}
            </span>
            <ActionButton {...ui} action={{ type: "quit" }} className={s.textButton}>
              Quit…
            </ActionButton>
          </footer>
        </div>
        {selected && (
          <DetailDialog
            bridge={bridge}
            request={selected}
            onClose={() => setSelected(undefined)}
            notify={notify}
          />
        )}
        {connectionDetails && (
          <TextDialog
            title="Connection details"
            text={state.connection.diagnostics || state.connection.message}
            onClose={() => setConnectionDetails(false)}
          />
        )}
      </div>
    </TimeFormatContext.Provider>
  );
}

function TextDialog({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className={s.dialog} aria-label={title} onCancel={onClose}>
      <div className={s.dialogHeader}>
        <span className={s.dialogIcon}>
          <Activity size={20} />
        </span>
        <h2>{title}</h2>
        <span className={s.grow} />
        <button className={s.secondary} onClick={onClose}>
          Done
        </button>
      </div>
      <pre>{text}</pre>
    </dialog>
  );
}
function DetailDialog({
  bridge,
  request,
  onClose,
  notify,
}: {
  bridge: DesktopBridge;
  request: DetailRequest;
  onClose: () => void;
  notify: (result: ActionResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState(request.mode);
  const [content, setContent] = useState<DetailResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError("");
    void bridge
      .details({ ...request, mode })
      .then((result) => {
        if (!stopped) {
          setContent(result);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!stopped) {
          setError(String(error));
          setLoading(false);
        }
      });
    return () => {
      stopped = true;
    };
  }, [bridge, request, mode]);
  return (
    <dialog ref={dialog} className={s.dialog} aria-label="Complete local record" onCancel={onClose}>
      <div className={s.dialogHeader}>
        <span className={s.dialogIcon}>
          <FileRecordIcon />
        </span>
        <div>
          <h2>Complete local record</h2>
          <p>The original detail, without the noise.</p>
        </div>
        <span className={s.grow} />
        <button
          className={s.iconButton}
          aria-label="Copy complete record"
          disabled={loading || !content || !!error}
          onClick={() => void bridge.copy(content!.text).then(notify)}
        >
          <Copy size={15} />
        </button>
        <button
          className={s.textButton}
          disabled={loading || !!error}
          onClick={() =>
            void bridge
              .exportDetails({ ...request, mode })
              .then(notify)
              .catch((issue: unknown) => notify({ ok: false, message: String(issue) }))
          }
        >
          Export…
        </button>
        <button className={s.secondary} onClick={onClose}>
          Done
        </button>
      </div>
      <div className={s.segmented}>
        {(["input", "result", "output", "raw"] as const).map((value) => (
          <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
            {value === "raw" ? "Original JSON" : value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      {loading ? (
        <p className={s.dialogLoading}>Reading the original archive…</p>
      ) : error ? (
        <p role="alert" className={s.inlineError}>
          {error}
        </p>
      ) : (
        <>
          <div className={s.images}>
            {content?.images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`Captured result ${index + 1}`}
              />
            ))}
          </div>
          <pre>{content?.text}</pre>
        </>
      )}
      <small>
        <ShieldCheck size={12} />
        Full captured records. Local only. No masking.
      </small>
    </dialog>
  );
}
function FileRecordIcon() {
  return <HardDrive size={20} />;
}
