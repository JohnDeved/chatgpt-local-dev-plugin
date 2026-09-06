import { LatestPublicUpdate, SteeringWorkState } from "./RunWork.tsx";
import { RunOverview } from "./RunOverview.tsx";
import { useMotionAllowed, useTimelineMotion } from "./useTimelineMotion.ts";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronRight,
  Circle,
  FileText,
  GitBranch,
  Globe,
  Lightbulb,
  MessageSquare,
  Pencil,
  Play,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { CallItem, ControlAction, RunItem } from "../shared/contracts.ts";
import { duration } from "../shared/presentation.ts";
import { CommandPanel, type UiActions } from "./CommandPanel.tsx";
import s from "./app.module.css";
import { HistoryTimestamp, RelativeTimestamp, useTimestamp } from "./RunTime.tsx";
import { useLiveFollow } from "./useLiveFollow.ts";
import { EditDiff } from "./EditDiff.tsx";
import { useTimelineExpansion, type TimelineExpansion } from "./useTimelineExpansion.ts";

export function ActionButton({
  action,
  children,
  className,
  disabled,
  bridge,
  notify,
}: Pick<UiActions, "bridge" | "notify"> & {
  action: ControlAction;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      disabled={disabled || pending}
      className={className}
      onClick={() => {
        setPending(true);
        void bridge
          .act(action)
          .then(notify)
          .catch((error: unknown) => notify({ ok: false, message: String(error) }))
          .finally(() => setPending(false));
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

const stateNames: Record<string, string> = {
  waiting: "Needs approval",
  requested: "Received",
  running: "Running",
  stopping: "Stopping…",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  denied: "Denied",
  interrupted: "Connection lost",
};
export function Status({ state }: { state: string }) {
  return (
    <span data-state-indicator className={`${s.status} ${s["state_" + state] ?? ""}`}>
      <i aria-hidden="true" />
      {stateNames[state] ?? state}
    </span>
  );
}
export function Time({ value }: { value: string }) {
  const format = useTimestamp();
  const text = format(value);
  return text ? (
    <time dateTime={value} title={format(value, "full")}>
      {text}
    </time>
  ) : null;
}
export function callCategory(call: CallItem): "command" | "file" | "other" {
  if (call.commands.length || ["dev.run", "dev.batch", "project.hook"].includes(call.tool))
    return "command";
  return /read_file|write_file|create_text|replace_|insert_|list_dir|find_file|find_symbol|search_for_pattern|get_symbols|find_referencing/.test(
    call.tool,
  )
    ? "file"
    : "other";
}
function CallGlyph({ call }: { call: CallItem }) {
  if (callCategory(call) === "command") return <Terminal size={15} />;
  if (/replace|write|create_text|insert/.test(call.tool)) return <Pencil size={15} />;
  if (/search|find_/.test(call.tool)) return <Search size={15} />;
  if (call.tool.startsWith("chrome.")) return <Globe size={15} />;
  return <FileText size={15} />;
}

export function CallRow({
  call,
  allCalls,
  compact = false,
  expansion,
  ...ui
}: UiActions & {
  call: CallItem;
  allCalls: CallItem[];
  compact?: boolean;
  expansion?: TimelineExpansion;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const expanded = expansion ? expansion.open.has(call.id) : manualOpen;
  const [retained, setRetained] = useState(expanded);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelID = useId();
  const triggerID = useId();
  const latest = expansion?.newestId === call.id;
  useEffect(() => {
    if (expanded) {
      setRetained(true);
      return;
    }
    // Keep the previous contents only for the close transition, then release output effects.
    const timer = setTimeout(() => setRetained(false), 250);
    return () => clearTimeout(timer);
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded && panel.current?.contains(document.activeElement))
      trigger.current?.focus({ preventScroll: true });
  }, [expanded]);
  const childCalls = allCalls.filter(
    (item) => item.parentId === call.operationId && item.runtimeId === call.runtimeId,
  );
  const request = { runtimeId: call.runtimeId, operationId: call.operationId };
  return (
    <div
      className={`${s.call} ${compact ? s.compact : ""}`}
      data-state={call.state}
      data-operation-id={call.operationId}
      data-call-id={call.id}
      data-expanded={expanded}
      data-latest={latest}
      data-kind={
        callCategory(call) === "command"
          ? "command"
          : /replace|write|create_text|insert/.test(call.tool)
            ? "edit"
            : "read"
      }
    >
      {!compact && (
        <>
          <span className={s.timelineStamp}>
            <RelativeTimestamp value={call.startedAt} latest={latest} />
          </span>
          <span className={s.timelineNode} aria-hidden="true">
            {call.state === "completed" ? (
              <Check size={10} />
            ) : call.state === "failed" ? (
              <X size={10} />
            ) : call.state === "waiting" ? (
              <span className={s.nodePause}>Ⅱ</span>
            ) : (
              <i />
            )}
          </span>
        </>
      )}
      <button
        ref={trigger}
        id={triggerID}
        className={s.callSummary}
        aria-expanded={expanded}
        aria-controls={panelID}
        onClick={() => (expansion ? expansion.toggle(call.id) : setManualOpen(!expanded))}
      >
        <span className={s.callIcon}>
          <CallGlyph call={call} />
        </span>
        <span className={s.callIdentity}>
          <span className={s.callTitle}>
            {call.title}
            {latest && <span className={s.latestLabel}>Latest</span>}
          </span>
          {call.target && (
            <span className={s.callTarget} title={call.target}>
              {call.target}
            </span>
          )}
        </span>
        <span className={s.callTiming}>
          <Status state={call.state} />
          <span className={s.callTime}>{duration(call.startedAt, call.endedAt)}</span>
          <HistoryTimestamp value={call.startedAt} className={s.itemTimestamp} />
        </span>
        <ChevronRight size={14} className={s.disclosureChevron} />
      </button>
      {call.state === "waiting" && (
        <div className={s.approvalActions}>
          <ShieldCheck size={15} />
          <span>
            {ui.paused
              ? "Resume new actions before approving."
              : "Your permission is needed. Nothing has executed."}
          </span>
          <span className={s.grow} />
          <ActionButton {...ui} action={{ type: "deny", ...request }} className={s.secondary}>
            Deny
          </ActionButton>
          <ActionButton
            {...ui}
            action={{ type: "approve", ...request }}
            disabled={ui.paused}
            className={s.primary}
          >
            Approve
          </ActionButton>
        </div>
      )}
      {call.state === "failed" && call.summary && (
        <p className={s.inlineError}>
          <X size={13} />
          {call.summary}
        </p>
      )}
      <div
        ref={panel}
        id={panelID}
        role="region"
        aria-labelledby={triggerID}
        aria-hidden={!expanded}
        inert={!expanded}
        className={s.detailReveal}
        data-open={expanded}
      >
        <div className={s.detailClip}>
          {(expanded || retained) && (
            <div className={s.callDetails}>
              {call.commands.map((command) => (
                <CommandPanel key={command.id} call={call} command={command} {...ui} />
              ))}
              <div className={s.callMeta}>
                <code>{call.tool}</code>
                {call.approval && (
                  <span>
                    <ShieldCheck size={11} />
                    {call.approval}
                  </span>
                )}
                <span>{call.eventCount} recorded events</span>
              </div>
              {/replace_|write_file|create_text_file|insert_/.test(call.tool) && (
                <EditDiff call={call} bridge={ui.bridge} inspect={ui.inspect} />
              )}
              <details className={s.inputDetails} open={call.state === "waiting" || undefined}>
                <summary>
                  {/replace|write|create_text/.test(call.tool)
                    ? "Requested change and inputs"
                    : "Inputs"}
                </summary>
                <pre>{call.inputPreview}</pre>
                {call.inputLimited && (
                  <button
                    className={s.textButton}
                    onClick={() => ui.inspect({ ...request, mode: "input" })}
                  >
                    Load complete inputs
                  </button>
                )}
              </details>
              {childCalls.map((child) => (
                <CallRow
                  key={child.id}
                  call={child}
                  allCalls={allCalls}
                  compact
                  expansion={expansion}
                  {...ui}
                />
              ))}
              <div className={s.detailActions}>
                <button
                  className={s.textButton}
                  onClick={() => ui.inspect({ ...request, mode: "result" })}
                >
                  Full result
                </button>
                <button
                  className={s.textButton}
                  onClick={() => ui.inspect({ ...request, mode: "raw" })}
                >
                  Original records
                </button>
                <span className={s.grow} />
                {["running", "stopping"].includes(call.state) && (
                  <ActionButton
                    {...ui}
                    action={{ type: "stop", ...request }}
                    disabled={call.state === "stopping"}
                    className={s.secondary}
                  >
                    Stop operation
                  </ActionButton>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type Filter = "all" | "command" | "file";
export function RunCard({
  run,
  calls,
  onSteer,
  onReview,
  followNewest = true,
  followLive = true,
  onFollowLiveChange,
  animations = true,
  onFollowNewestChange,
  ...ui
}: UiActions & {
  run: RunItem;
  calls: CallItem[];
  onSteer: (id: string) => void;
  onReview?: () => void;
  followNewest?: boolean;
  followLive?: boolean;
  onFollowLiveChange?: (enabled: boolean) => void;
  animations?: boolean;
  onFollowNewestChange?: (enabled: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const ids = new Set(calls.map((call) => call.operationId));
  const roots = calls.filter((call) => !call.parentId || !ids.has(call.parentId));
  const [readingEarlier, setReadingEarlier] = useState(false);
  const expansion = useTimelineExpansion(calls, followNewest, readingEarlier);
  const root = useRef<HTMLElement>(null);
  const liveFollow = useLiveFollow(
    root,
    expansion.newestId,
    followLive && run.connected && run.state === "running",
    setReadingEarlier,
  );
  useLayoutEffect(() => {
    const element = root.current,
      toolbar = element?.querySelector<HTMLElement>("[data-follow-control]");
    if (!element || !toolbar) return;
    const measure = () =>
      element.style.setProperty(
        "--timeline-toolbar-height",
        toolbar.getBoundingClientRect().height + "px",
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [run.id]);
  const motionAllowed = useMotionAllowed(animations);
  useTimelineMotion(root, calls, motionAllowed);
  const [jump, setJump] = useState<{ id: string }>();
  const reveal = (id: string) => {
    liveFollow.pause();
    setFilter("all");
    setShowAll(true);
    expansion.reveal(id);
    setJump({ id });
  };
  useLayoutEffect(() => {
    if (!jump || !root.current) return;
    const item = Array.from(root.current.querySelectorAll<HTMLElement>("[data-call-id]")).find(
      (element) => element.dataset.callId === jump.id,
    );
    const scroller = root.current.closest("main");
    if (!item || !scroller) return;
    item.querySelector<HTMLButtonElement>(":scope > button")?.focus({ preventScroll: true });
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        item.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        18,
      behavior: motionAllowed ? "smooth" : "instant",
    });
  }, [jump]);
  const waiting = calls.filter((call) => call.state === "waiting");
  const awaitingParents = new Set(waiting.map((call) => call.parentId));
  const filtered = roots.filter(
    (call) =>
      filter === "all" ||
      callCategory(call) === filter ||
      call.state === "waiting" ||
      awaitingParents.has(call.operationId),
  );
  const recent = new Set(filtered.slice(-8).map((call) => call.id));
  const displayed =
    showAll || readingEarlier
      ? filtered
      : filtered.filter(
          (call) =>
            recent.has(call.id) ||
            expansion.open.has(call.id) ||
            call.state === "waiting" ||
            awaitingParents.has(call.operationId),
        );
  const running = run.state === "running";
  const executing = calls.filter((call) => ["running", "stopping"].includes(call.state)).length;
  const phase = waiting.length
    ? "Waiting for your approval"
    : running
      ? run.connected
        ? executing
          ? "Work in progress"
          : "Run open"
        : "Connection lost"
      : (stateNames[run.state] ?? run.state);
  return (
    <article
      ref={root}
      className={s.run}
      aria-label={run.title}
      data-live-follow={
        liveFollow.following ? "following" : liveFollow.suspended ? "suspended" : "off"
      }
      onClickCapture={(event) => {
        const clicked =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-call-id]")
            : null;
        if (clicked && clicked.dataset.callId !== expansion.newestId) liveFollow.pause();
      }}
    >
      <RunOverview
        run={run}
        roots={roots}
        phase={phase}
        waiting={waiting.length}
        onReveal={reveal}
        onReview={onReview}
      />
      <div className={s.timelineToolbar} data-follow-control aria-label="Timeline controls">
        <div className={s.activityTitle}>
          <h3>Activity</h3>
          <span>Newest first</span>
        </div>
        <div className={s.filterChips} role="group" aria-label="Filter run steps">
          {(
            [
              ["all", "All steps"],
              ["file", "Files"],
              ["command", "Commands"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setShowAll(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {onFollowNewestChange && (
          <button
            className={s.followNewest}
            aria-label="Auto-expand newest activity"
            aria-pressed={followNewest}
            title="Open new actions automatically. Reading older work suspends expansion."
            onClick={() => onFollowNewestChange(!followNewest)}
          >
            <ArrowDown size={12} />
            {followNewest ? "Auto-expand" : "Manual"}
          </button>
        )}
        {run.connected && running && (
          <button
            className={s.followButton}
            aria-label={liveFollow.following ? "Pause live following" : "Resume live following"}
            title={
              liveFollow.following
                ? "Following new actions. Click to pause scrolling."
                : "Resume following new actions"
            }
            onClick={() => {
              if (liveFollow.following) liveFollow.pause();
              else {
                onFollowLiveChange?.(true);
                setFilter("all");
                if (expansion.newestId) expansion.reveal(expansion.newestId, followNewest);
                liveFollow.resume();
              }
            }}
          >
            <span className={liveFollow.following ? s.liveDot : s.offlineDot} />
            {liveFollow.following ? "Live" : "Resume live"}
            {liveFollow.unseen > 0 && <b>{liveFollow.unseen}</b>}
          </button>
        )}
      </div>
      <LatestPublicUpdate run={run} compact />
      <section className={s.activitySection} aria-label="Run activity">
        {filtered.length > displayed.length && (
          <button className={s.moreButton} onClick={() => setShowAll(true)}>
            <ArrowDown size={13} />
            <span>Show {filtered.length - displayed.length} earlier steps</span>
          </button>
        )}
        <div className={s.runRail}>
          {displayed.length ? (
            [...displayed]
              .reverse()
              .map((call) => (
                <CallRow key={call.id} call={call} allCalls={calls} expansion={expansion} {...ui} />
              ))
          ) : (
            <p className={s.noSteps}>
              {roots.length
                ? "No steps match this filter."
                : running
                  ? "The run has started. Its first action will appear here."
                  : "No tool steps were captured for this run."}
            </p>
          )}
        </div>
        {showAll && filtered.length > 8 && (
          <button className={s.moreButton} onClick={() => setShowAll(false)}>
            Show recent steps only
          </button>
        )}
        {running ? (
          <div className={s.openRun}>
            <span className={s.openRunGlyph}>
              <Circle size={12} />
            </span>
            <div>
              <strong>{run.connected ? "Still in progress" : "Connection lost"}</strong>
              <span>
                {run.connected
                  ? "An end has not been reported yet."
                  : "Completion is unknown. The archive is retained."}
              </span>
            </div>
            <span className={s.grow} />
            {run.connected && run.origin === "assistant" && (
              <button className={s.textButton} onClick={() => onSteer(run.id)}>
                <GitBranch size={13} />
                Steer this run
              </button>
            )}
          </div>
        ) : (
          <div className={`${s.endRun} ${run.state === "completed" ? s.endSuccess : ""}`}>
            <div className={s.boundary}>
              <span className={s.boundaryIcon}>
                {run.state === "completed" ? <Check size={11} /> : <Circle size={11} />}
              </span>
              <strong>{run.state === "interrupted" ? "Interrupted" : "End"}</strong>
              <span>
                {run.state === "interrupted" ? "Completion unknown" : "Outcome reported by ChatGPT"}
              </span>
              <i />
              {run.endedAt && <Time value={run.endedAt} />}
            </div>
            {run.summary && <p>{run.summary}</p>}
          </div>
        )}
        <div className={s.boundary}>
          <span className={s.boundaryIcon}>
            <Play size={10} />
          </span>
          <strong>Start</strong>
          <span>{run.origin === "assistant" ? "Run declared" : "First local action observed"}</span>
          <i />
          <Time value={run.startedAt} />
        </div>
      </section>
      {run.steering.length > 0 && (
        <details
          className={s.steeringHistory}
          open={run.steering.some((message) => message.state !== "acknowledged") || undefined}
        >
          <summary>
            <GitBranch size={15} />
            Your directions<span>{run.steering.length}</span>
          </summary>
          {run.steering.map((message) => (
            <div className={s.steeringMessage} key={message.id}>
              <p>{message.text}</p>
              <SteeringWorkState message={message} />
              <small className={message.state === "acknowledged" ? s.success : s.warning}>
                {message.state === "queued"
                  ? "Queued for the next tool response"
                  : message.state === "returned"
                    ? "Included in a tool response; awaiting acknowledgement"
                    : "Acknowledged by ChatGPT"}
              </small>
              {message.response && <p className={s.steeringReply}>ChatGPT: {message.response}</p>}
            </div>
          ))}
        </details>
      )}
      {run.contextScope === "runtime" && (
        <p className={s.quiet}>
          No conversation identifier was supplied. Attribution is limited to this runtime.
        </p>
      )}
    </article>
  );
}
