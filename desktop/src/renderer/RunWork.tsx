import { useState } from "react";
import { Check, ChevronDown, Circle, ListTodo, MessageSquare, Pause, Play, X } from "lucide-react";
import type { RunItem, SteeringItem, TaskStatus } from "../shared/contracts.ts";
import { ElapsedClock, HistoryTimestamp } from "./RunTime.tsx";
import s from "./app.module.css";

export function TaskStatusLabel({ status }: { status?: TaskStatus }) {
  const label =
    status === "in_progress"
      ? "In progress"
      : status === "completed"
        ? "Completed"
        : status === "cancelled"
          ? "Cancelled"
          : status === "paused"
            ? "Paused"
            : status === "queued"
              ? "Queued"
              : "Work status not reported";
  const Icon =
    status === "completed"
      ? Check
      : status === "cancelled"
        ? X
        : status === "paused"
          ? Pause
          : status === "in_progress"
            ? Play
            : Circle;
  return (
    <span className={s.taskStatus} data-task-status={status ?? "unreported"}>
      <Icon size={12} />
      {label}
    </span>
  );
}
export function SteeringWorkState({ message }: { message: SteeringItem }) {
  return (
    <div className={s.steeringWork}>
      <TaskStatusLabel status={message.taskStatus} />
      {message.taskNote && <p>{message.taskNote}</p>}
    </div>
  );
}
export function LatestPublicUpdate({ run, compact = false }: { run: RunItem; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const latest = run.notes.at(-1);
  return (
    <section
      className={`${s.contextCard} ${s.stickyPublicUpdate} ${compact ? s.inlinePublicUpdate : ""}`}
      aria-label={compact ? "Pinned public update" : "Latest public update"}
      data-pinned-update={compact || undefined}
      data-expanded={expanded}
    >
      <div className={s.contextHeading}>
        <MessageSquare size={16} />
        <h3>{compact ? "Latest" : "Latest update"}</h3>
        {latest && <HistoryTimestamp value={latest.timestamp} />}
      </div>
      <p className={s.publicSummary} data-expanded={expanded}>
        {latest?.text ?? "No public update has been reported yet."}
      </p>
      {latest && (
        <button
          className={s.textButton}
          aria-expanded={expanded}
          aria-label={expanded ? "Keep compact" : "Read full update"}
          title={expanded ? "Keep compact" : "Read full update"}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={s.updateToggleLabel}>
            {expanded ? "Keep compact" : "Read full update"}
          </span>
          <ChevronDown size={14} className={s.updateChevron} />
        </button>
      )}
    </section>
  );
}
export function RunTasks({ run }: { run: RunItem }) {
  const todos = run.todos ?? [];
  const pending = todos.filter(
    (todo) => todo.status !== "completed" && todo.status !== "cancelled",
  ).length;
  return (
    <>
      <section className={s.contextCard} aria-label="Run to-dos">
        <div className={s.contextHeading}>
          <ListTodo size={17} />
          <h3>To-dos</h3>
          <span className={s.countBadge}>{pending} open</span>
        </div>
        {todos.length ? (
          <ol className={s.todoList}>
            {todos.map((todo) => (
              <li key={todo.id} data-todo-id={todo.id}>
                <strong>{todo.title}</strong>
                {todo.steeringId && (
                  <small
                    title={run.steering.find((message) => message.id === todo.steeringId)?.text}
                  >
                    Linked to your direction
                  </small>
                )}
                <div className={s.todoMeta}>
                  <TaskStatusLabel status={todo.status} />
                  <ElapsedClock
                    start={
                      todo.activeStartedAt ??
                      (todo.status === "in_progress" ? todo.updatedAt : undefined)
                    }
                    elapsedMs={todo.activeElapsedMs ?? 0}
                    active={todo.status === "in_progress"}
                    label={`${todo.title} active time`}
                    className={s.todoClock}
                    dataId={todo.id}
                  />
                </div>
                {todo.note && <p>{todo.note}</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p className={s.contextEmpty}>
            No to-do list has been reported yet. The updated runtime requires ChatGPT to publish one
            before substantive work.
          </p>
        )}
        <p className={s.contextFootnote}>
          Explicitly reported by ChatGPT. Paused work stays on the list.
        </p>
      </section>
      {run.steering.length > 0 && (
        <section className={s.contextCard} aria-label="Steering work status">
          <div className={s.contextHeading}>
            <MessageSquare size={16} />
            <h3>Your directions</h3>
          </div>
          <ol className={s.todoList}>
            {run.steering.map((message) => (
              <li key={message.id}>
                <strong>{message.text}</strong>
                <TaskStatusLabel status={message.taskStatus} />
                <small>
                  {message.state === "acknowledged"
                    ? "Acknowledged"
                    : message.state === "returned"
                      ? "Included in tool response"
                      : "Waiting for delivery"}
                </small>
                {message.taskNote && <p>{message.taskNote}</p>}
              </li>
            ))}
          </ol>
          <p className={s.contextFootnote}>
            Acknowledgement and implementation are tracked separately.
          </p>
        </section>
      )}
    </>
  );
}
