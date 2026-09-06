import { LatestPublicUpdate, RunTasks } from "./RunWork.tsx";
import { useState } from "react";
import { Activity, ChevronDown, FileText, Folder, Settings, Sparkles, Target } from "lucide-react";
import type { CallItem, RunItem } from "../shared/contracts.ts";
import { runContextFacts } from "../shared/run-context.ts";
import { HistoryTimestamp, RunClock } from "./RunTime.tsx";
import s from "./app.module.css";

export function RunContext({
  run,
  calls,
  autoExpand,
  animations,
  paused,
  onAutoExpandChange,
  onAnimationsChange,
  onSettings,
}: {
  run: RunItem;
  calls: CallItem[];
  autoExpand: boolean;
  animations: boolean;
  paused: boolean;
  onAutoExpandChange: (value: boolean) => void;
  onAnimationsChange: (value: boolean) => void;
  onSettings: () => void;
}) {
  const [allNotes, setAllNotes] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const facts = runContextFacts(run, calls);
  const plans = run.notes.filter((note) => note.kind === "plan");
  const visible = allNotes ? run.notes : plans.slice(-1);
  return (
    <aside className={s.contextRail} aria-label="Run context" data-open={compactOpen}>
      <button
        className={s.contextToggle}
        aria-expanded={compactOpen}
        onClick={() => setCompactOpen(!compactOpen)}
      >
        <Target size={16} />
        Run context & view preferences
        <ChevronDown size={14} />
      </button>
      <div className={s.contextContents}>
        <LatestPublicUpdate run={run} />
        <RunTasks run={run} />
        <section
          className={`${s.contextCard} ${s.contextSecondary}`}
          aria-label="Selected run facts"
        >
          <details className={s.contextDisclosure}>
            <summary>
              <Target size={15} />
              Run details<span>{facts.roots.length} actions</span>
            </summary>
            <div className={s.contextDisclosureBody}>
              <div className={s.contextHeading}>
                <h3>{run.state === "running" ? "Current run" : "Selected run"}</h3>
                <span className={s.contextRunId} title={run.runId}>
                  {run.runId.slice(0, 6)}
                </span>
              </div>
              <div className={s.contextGoal}>
                <Target size={19} />
                <strong>{run.title}</strong>
              </div>
              <dl className={s.contextFacts}>
                <div>
                  <dt>
                    <FileText size={17} />
                    <span className={s.srOnly}>Recorded actions</span>
                  </dt>
                  <dd>
                    {facts.roots.length} {facts.roots.length === 1 ? "action" : "actions"}
                    <RunClock run={run} compact />
                  </dd>
                </div>
                <div>
                  <dt>
                    <Folder size={17} />
                    <span className={s.srOnly}>Last command directory</span>
                  </dt>
                  <dd>
                    {facts.directory ? (
                      <>
                        <span className={s.contextPath} title={facts.directory}>
                          {facts.directory}
                        </span>
                        <small>Last recorded command directory</small>
                      </>
                    ) : (
                      <span className={s.muted}>Directory not reported</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    <Activity size={17} />
                    <span className={s.srOnly}>Worker status</span>
                  </dt>
                  <dd>
                    <span
                      className={s.contextState}
                      data-state={paused && run.state === "running" ? "paused" : facts.state}
                    >
                      <i />
                      {paused && run.state === "running" ? "New actions paused" : facts.label}
                    </span>
                    <small>
                      {run.state === "running"
                        ? facts.state === "open"
                          ? "Run open; no tool currently executing"
                          : facts.state === "working"
                            ? `${facts.executing} tool ${facts.executing === 1 ? "call" : "calls"} executing`
                            : run.connected
                              ? "See the timeline for pending work"
                              : "An end has not been reported"
                        : "Outcome reported in the run log"}
                    </small>
                  </dd>
                </div>
              </dl>
              {run.contextScope === "runtime" && (
                <p className={s.contextCaution}>This client did not supply a conversation ID.</p>
              )}
            </div>
          </details>
        </section>
        <section className={`${s.contextCard} ${s.contextSecondary}`} aria-label="Reported plan">
          <details className={s.contextDisclosure}>
            <summary>
              <FileText size={15} />
              Reported plan<span>{plans.length ? "View" : "Not reported"}</span>
            </summary>
            <div className={s.contextDisclosureBody}>
              <div className={s.contextHeading}>
                <span className={s.contextCardIcon}>
                  <FileText size={17} />
                </span>
                <h3>{allNotes ? "Public updates" : "Plan"}</h3>
                {run.notes.length > 0 && (
                  <button
                    className={s.textButton}
                    aria-expanded={allNotes}
                    onClick={() => setAllNotes(!allNotes)}
                  >
                    {allNotes ? "Show plan" : "View all"}
                  </button>
                )}
              </div>
              {visible.length ? (
                <div className={s.planNotes}>
                  {visible.map((note) => (
                    <div key={note.id} className={s.planNote}>
                      <span className={s.planNoteIcon}>
                        {note.kind === "decision" ? <Sparkles size={13} /> : <span />}
                      </span>
                      <div>
                        {allNotes && (
                          <small>
                            {note.kind === "plan"
                              ? "Plan"
                              : note.kind === "decision"
                                ? "Decision"
                                : "Progress"}{" "}
                            <HistoryTimestamp value={note.timestamp} />
                          </small>
                        )}
                        <p>{note.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={s.contextEmpty}>
                  No plan has been reported yet. Public updates appear here when ChatGPT supplies
                  them.
                </p>
              )}
              {plans.length > 0 && !allNotes && (
                <p className={s.contextFootnote}>Reported plan, not a verified task checklist.</p>
              )}
            </div>
          </details>
        </section>
        <section
          className={`${s.contextCard} ${s.contextSecondary}`}
          aria-label="Quick view preferences"
        >
          <details className={s.contextDisclosure}>
            <summary>
              <Settings size={15} />
              View settings
            </summary>
            <div className={s.contextDisclosureBody}>
              <div className={s.contextHeading}>
                <span className={s.contextCardIcon}>
                  <Settings size={17} />
                </span>
                <h3>View settings</h3>
                <button className={s.textButton} onClick={onSettings}>
                  All settings
                </button>
              </div>
              <label className={s.contextSwitch}>
                <span>
                  <strong>Auto-expand newest activity</strong>
                  <small>Keep the latest item open</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Auto-expand newest activity"
                  checked={autoExpand}
                  onChange={(event) => onAutoExpandChange(event.target.checked)}
                />
              </label>
              <label className={s.contextSwitch}>
                <span>
                  <strong>Interface animations</strong>
                  <small>Subtle motion, reduced when requested</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Interface animations"
                  checked={animations}
                  onChange={(event) => onAnimationsChange(event.target.checked)}
                />
              </label>
            </div>
          </details>
        </section>
      </div>
    </aside>
  );
}
