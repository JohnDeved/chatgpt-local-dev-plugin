import { createContext, useContext, useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import type { RunItem } from "../shared/contracts.ts";

import { timestamp, type TimePresentation } from "../shared/time-format.ts";
export const TimeFormatContext = createContext<TimePresentation>({ mode: "system" });
export function useTimestamp() {
  const preference = useContext(TimeFormatContext);
  return (value: string, style: "clock" | "history" | "full" = "clock") =>
    timestamp(value, preference, style);
}

export function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
export function elapsedLabel(start: string, end: string | number): string {
  const endMs = typeof end === "number" ? end : Date.parse(end);
  const startMs = Date.parse(start);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return "";
  return durationLabel(Math.max(0, endMs - startMs));
}
export function ElapsedClock({
  start,
  elapsedMs = 0,
  active = false,
  label = "Elapsed time",
  className,
  dataId,
}: {
  start?: string;
  elapsedMs?: number;
  active?: boolean;
  label?: string;
  className?: string;
  dataId?: string;
}) {
  const ticking = active && !!start;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [start, ticking]);
  const startMs = start ? Date.parse(start) : Number.NaN;
  const currentSegmentMs = ticking && Number.isFinite(startMs) ? Math.max(0, now - startMs) : 0;
  const totalMs = Math.max(0, elapsedMs + currentSegmentMs);
  if ((!start && elapsedMs <= 0) || !Number.isFinite(totalMs)) return null;
  const labelText = durationLabel(totalMs);
  if (!labelText) return null;
  return (
    <span className={className} data-elapsed-clock={dataId} aria-label={`${label}: ${labelText}`}>
      <Clock3 size={11} />
      <span data-clock-value>{labelText}</span>
    </span>
  );
}

export function RunClock({ run, compact = false }: { run: RunItem; compact?: boolean }) {
  const ticking = !run.endedAt && run.state === "running" && run.connected;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.id, ticking]);
  if (!ticking && !run.endedAt) return null;
  const label = elapsedLabel(run.startedAt, run.endedAt ?? now);
  if (!label) return null;
  return (
    <span
      data-run-clock={run.id}
      aria-label={`${run.endedAt ? "Duration" : "Elapsed time"} for ${run.title}`}
    >
      {!compact && <Clock3 size={13} />}
      <span data-clock-value>{label}</span>
      {!compact && <span data-clock-qualifier>{run.endedAt ? " duration" : " elapsed"}</span>}
    </span>
  );
}
export function HistoryTimestamp({ value, className }: { value: string; className?: string }) {
  const format = useTimestamp();
  const text = format(value, "history");
  return text ? (
    <time className={className} dateTime={value} title={format(value, "full")}>
      {text}
    </time>
  ) : null;
}

export function RelativeTimestamp({ value, latest = false }: { value: string; latest?: boolean }) {
  const format = useTimestamp();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60000));
  const label = latest
    ? "Latest"
    : minutes < 1
      ? "Just now"
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 1440
          ? `${Math.floor(minutes / 60)}h ago`
          : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <time dateTime={value} title={format(value, "full")}>
      {label}
    </time>
  );
}
