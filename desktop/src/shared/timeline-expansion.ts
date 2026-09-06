import type { CallItem } from "./contracts.ts";

type Step = Pick<CallItem, "id" | "operationId" | "parentId" | "startedAt">;
export interface ExpansionState {
  enabled: boolean;
  fingerprint: string;
  seen: ReadonlySet<string>;
  newestId: string | null;
  watermark: string;
  open: ReadonlySet<string>;
}

function fingerprint(calls: readonly Step[]): string {
  return calls.map((call) => `${call.id}/${call.startedAt}/${call.parentId ?? ""}`).join("|");
}
function latest(calls: readonly Step[]): Step | undefined {
  // Stable input ordering decides ties only for genuinely unseen IDs.
  return calls.reduce<Step | undefined>(
    (found, call) => (!found || call.startedAt >= found.startedAt ? call : found),
    undefined,
  );
}
function ancestors(calls: readonly Step[], id: string | null): Set<string> {
  const byOperation = new Map(calls.map((call) => [call.operationId, call]));
  const open = new Set<string>();
  let call = calls.find((candidate) => candidate.id === id);
  while (call && !open.has(call.id)) {
    open.add(call.id);
    call = call.parentId ? byOperation.get(call.parentId) : undefined;
  }
  return open;
}
export function initialExpansion(calls: readonly Step[], enabled: boolean): ExpansionState {
  const newest = latest(calls);
  return {
    enabled,
    fingerprint: fingerprint(calls),
    seen: new Set(calls.map((call) => call.id)),
    newestId: newest?.id ?? null,
    watermark: newest?.startedAt ?? "",
    open: enabled ? ancestors(calls, newest?.id ?? null) : new Set(),
  };
}

/** Output/status refreshes and replayed older history never change a manual disclosure. */
export function reconcileExpansion(
  previous: ExpansionState,
  calls: readonly Step[],
  enabled: boolean,
  suspended = false,
): ExpansionState {
  const signature = fingerprint(calls);
  if (signature === previous.fingerprint && enabled === previous.enabled) return previous;
  const unseen = calls.filter(
    (call) => !previous.seen.has(call.id) && call.startedAt >= previous.watermark,
  );
  const arrived = latest(unseen);
  const turningOn = enabled && !previous.enabled;
  const newest = turningOn ? latest(calls) : arrived;
  const newestId = newest?.id ?? previous.newestId;
  const seen = new Set([...previous.seen, ...calls.map((call) => call.id)]);
  return {
    enabled,
    fingerprint: signature,
    seen,
    newestId,
    watermark: newest
      ? newest.startedAt > previous.watermark
        ? newest.startedAt
        : previous.watermark
      : previous.watermark,
    open:
      enabled && !suspended && (turningOn || arrived) ? ancestors(calls, newestId) : previous.open,
  };
}
export function revealExpansion(
  previous: ExpansionState,
  calls: readonly Step[],
  id: string,
  exclusive = false,
): ExpansionState {
  return {
    ...previous,
    open: exclusive ? ancestors(calls, id) : new Set([...previous.open, ...ancestors(calls, id)]),
  };
}

export function toggleExpansion(previous: ExpansionState, id: string): ExpansionState {
  const open = new Set(previous.open);
  if (open.has(id)) open.delete(id);
  else open.add(id);
  return { ...previous, open };
}
