import { useId, useState } from "react";
import {
  AlertCircle,
  ArrowDownRight,
  Check,
  ChevronRight,
  Circle,
  ListChecks,
  Play,
  Target,
  X,
} from "lucide-react";
import type { CallItem, RunItem } from "../shared/contracts.ts";
import { HistoryTimestamp, RunClock } from "./RunTime.tsx";
import s from "./app.module.css";

export function RunOverview({
  run,
  roots,
  phase,
  waiting,
  onReveal,
  onReview,
}: {
  run: RunItem;
  roots: CallItem[];
  phase: string;
  waiting: number;
  onReveal: (id: string) => void;
  onReview?: () => void;
}) {
  const running = run.state === "running";
  const latest = roots.at(-1);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const goalId = useId();
  const goal = run.goal ?? "No goal has been reported. Available local actions are still recorded.";
  const longGoal = goal.length > 65 || goal.includes("\n");
  return (
    <header className={s.runHero} data-overview="lavender-reference">
      <div className={s.heroHeading}>
        <span className={s.goalMedallion} aria-hidden="true">
          <Target size={29} strokeWidth={1.8} />
        </span>
        <div className={s.heroText}>
          <h2>{run.title}</h2>
          <div className={s.goalSummary} data-expanded={goalExpanded || !longGoal}>
            <p id={goalId} className={s.goal}>
              {goal}
            </p>
            {longGoal && (
              <button
                className={s.textButton}
                aria-controls={goalId}
                aria-label={goalExpanded ? "Collapse goal" : "Show full goal"}
                aria-expanded={goalExpanded}
                onClick={() => setGoalExpanded(!goalExpanded)}
              >
                {goalExpanded ? "Less" : "More"}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className={s.runFacts}>
        {waiting > 0 && onReview ? (
          <button className={s.heroApproval} onClick={onReview}>
            <AlertCircle size={14} />
            <span>
              {waiting} {waiting === 1 ? "action needs" : "actions need"} approval
            </span>
            <ChevronRight size={12} />
          </button>
        ) : (
          <span className={s.phaseBadge}>
            {running ? (
              <span className={run.connected ? s.liveDot : s.offlineDot} />
            ) : run.state === "completed" ? (
              <Check size={12} />
            ) : run.state === "failed" ? (
              <X size={12} />
            ) : (
              <Circle size={12} />
            )}
            {phase}
          </span>
        )}
        <span>
          <Play size={12} />
          <span className={s.startedLabel}>Started</span> <HistoryTimestamp value={run.startedAt} />
        </span>
        <span>
          <ListChecks size={14} />
          {roots.length} {roots.length === 1 ? "action" : "actions"}
        </span>
        <RunClock run={run} />
        <span className={s.grow} />
        {latest && (
          <button
            className={s.jumpLatest}
            onClick={() => onReveal(latest.id)}
            title="Reveal the latest recorded action"
            aria-label="Show latest action"
          >
            Latest
            <ArrowDownRight size={14} />
          </button>
        )}
      </div>
      {run.backgroundProcesses > 0 && (
        <p className={s.overviewBackground}>
          {run.backgroundProcesses} background process(es){" "}
          {run.backgroundProcessPolicy === "keep"
            ? "were intentionally kept running"
            : "remained running"}{" "}
          when this run ended. See Processes.
        </p>
      )}
    </header>
  );
}
