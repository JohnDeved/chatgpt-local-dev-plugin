import type { CallItem, RunItem } from "./contracts.ts";

/** Context is derived from captured calls, never inferred from a file or guessed git branch. */
export function runContextFacts(run: RunItem, calls: readonly CallItem[]) {
  const related = calls.filter(
    (call) => call.runtimeId === run.runtimeId && call.runId === run.runId,
  );
  const ids = new Set(related.map((call) => call.operationId));
  const roots = related.filter((call) => !call.parentId || !ids.has(call.parentId));
  const waiting = related.filter((call) => call.state === "waiting").length;
  const executing = related.filter((call) => ["running", "stopping"].includes(call.state)).length;
  const commands = related.flatMap((call) =>
    call.commands.map((command) => ({ command, timestamp: command.startedAt ?? call.startedAt })),
  );
  const latestDirectory = commands
    .filter(({ command }) => !!command.cwd)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.command.cwd;
  const state =
    run.state !== "running"
      ? run.state
      : !run.connected
        ? "disconnected"
        : waiting
          ? "waiting"
          : executing
            ? "working"
            : "open";
  const labels: Record<string, string> = {
    completed: "Run completed",
    failed: "Run failed",
    cancelled: "Run cancelled",
    interrupted: "Completion unknown",
    disconnected: "Runtime disconnected",
    waiting: "Waiting for approval",
    working: "Worker active",
    open: "Between tool calls",
  };
  return {
    roots,
    waiting,
    executing,
    directory: latestDirectory,
    state,
    label: labels[state] ?? "State not reported",
  };
}

export function directoryLabel(path?: string): string {
  if (!path) return "Local workspace";
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).at(-1) || path;
}
