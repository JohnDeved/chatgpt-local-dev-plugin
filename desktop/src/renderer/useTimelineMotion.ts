import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { CallItem } from "../shared/contracts.ts";
import { nextActivityFrame, type ActivityFrame } from "../shared/activity-motion.ts";

export function useMotionAllowed(enabled: boolean): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return enabled && !reduced;
}

/** Bounded, viewport-aware acknowledgements. No global stagger, forced scrolling, or output re-animation. */
export function useTimelineMotion(
  root: RefObject<HTMLElement | null>,
  calls: readonly CallItem[],
  allowed: boolean,
): void {
  const previous = useRef<ActivityFrame | undefined>(undefined);
  const active = useRef(new Set<Animation>());
  const cancel = () => {
    for (const animation of active.current) animation.cancel();
    active.current.clear();
  };
  useEffect(() => cancel, []);
  useLayoutEffect(() => {
    if (!allowed) cancel();
  }, [allowed]);
  useLayoutEffect(() => {
    const { frame, transitions } = nextActivityFrame(previous.current, calls);
    previous.current = frame;
    if (!allowed || document.hidden || !root.current || transitions.length === 0) return;
    const viewport = root.current.closest("main")?.getBoundingClientRect();
    const rows = new Map(
      Array.from(root.current.querySelectorAll<HTMLElement>("[data-call-id]")).map((row) => [
        row.dataset.callId,
        row,
      ]),
    );
    for (const transition of transitions) {
      const row = rows.get(transition.id);
      if (!row || row.closest("[inert]")) continue;
      const rect = row.getBoundingClientRect();
      if (
        !rect.height ||
        (viewport && (rect.top >= viewport.bottom || rect.bottom <= viewport.top))
      )
        continue;
      const target =
        transition.kind === "arrive"
          ? row
          : row.querySelector<HTMLElement>("[data-state-indicator]");
      if (!target || typeof target.animate !== "function") continue;
      row.dataset.motionEvent = transition.kind;
      const frames: Keyframe[] =
        transition.kind === "arrive"
          ? [
              { opacity: 0, transform: "translateX(-8px)" },
              { opacity: 1, transform: "translateX(0)" },
            ]
          : [
              { opacity: 0.35, transform: "scale(.9)" },
              { opacity: 1, transform: "scale(1.08)", offset: 0.55 },
              { opacity: 1, transform: "scale(1)" },
            ];
      const animation = target.animate(frames, {
        duration: transition.kind === "arrive" ? 360 : 420,
        easing: "cubic-bezier(.16,1,.3,1)",
      });
      active.current.add(animation);
      const finish = () => {
        active.current.delete(animation);
        if (row.dataset.motionEvent === transition.kind) delete row.dataset.motionEvent;
      };
      animation.finished.then(finish, finish);
    }
  }, [root, calls, allowed]);
}
