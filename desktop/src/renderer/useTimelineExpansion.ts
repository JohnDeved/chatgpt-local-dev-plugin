import { useState } from "react";
import type { CallItem } from "../shared/contracts.ts";
import {
  initialExpansion,
  reconcileExpansion,
  toggleExpansion,
  revealExpansion,
} from "../shared/timeline-expansion.ts";

export interface TimelineExpansion {
  newestId: string | null;
  open: ReadonlySet<string>;
  toggle(id: string): void;
  reveal(id: string, exclusive?: boolean): void;
}
export function useTimelineExpansion(
  calls: readonly CallItem[],
  enabled: boolean,
  suspended = false,
): TimelineExpansion {
  const [stored, setStored] = useState(() => initialExpansion(calls, enabled));
  const current = reconcileExpansion(stored, calls, enabled, suspended);
  // A guarded render adjustment prevents a stale open item from flashing for one frame.
  // The reconciliation signature excludes output, elapsed time, and status updates.
  if (current !== stored) setStored(current);
  return {
    newestId: current.newestId,
    open: current.open,
    toggle: (id) => setStored((value) => toggleExpansion(value, id)),
    reveal: (id, exclusive = false) =>
      setStored((value) => revealExpansion(value, calls, id, exclusive)),
  };
}
