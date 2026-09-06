import type { CallItem } from "./contracts.ts";

type MotionCall = Pick<CallItem, "id" | "startedAt" | "state">;
export interface ActivityFrame {
  watermark: string;
  states: ReadonlyMap<string, string>;
}
export interface ActivityTransition {
  id: string;
  kind: "arrive" | "complete" | "fail";
}

/** Compare identities and state, never stdout/progress revisions. Historical loading is not live motion. */
export function nextActivityFrame(
  previous: ActivityFrame | undefined,
  calls: readonly MotionCall[],
) {
  let watermark = previous?.watermark ?? "";
  const states = new Map(previous?.states);
  const transitions: ActivityTransition[] = [];
  for (const call of calls) {
    const known = previous?.states.has(call.id) === true;
    const oldState = previous?.states.get(call.id);
    if (previous && !known && call.startedAt >= previous.watermark)
      transitions.push({ id: call.id, kind: "arrive" });
    else if (known && oldState !== call.state) {
      if (call.state === "completed") transitions.push({ id: call.id, kind: "complete" });
      else if (call.state === "failed") transitions.push({ id: call.id, kind: "fail" });
    }
    if (call.startedAt > watermark) watermark = call.startedAt;
    states.set(call.id, call.state);
  }
  return {
    frame: { watermark, states } satisfies ActivityFrame,
    transitions: transitions.slice(-8),
  };
}
