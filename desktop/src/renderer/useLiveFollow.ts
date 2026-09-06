import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Follow new identities, not output chunks. Preserve both viewport and disclosures while reading. */
export function useLiveFollow(
  root: RefObject<HTMLElement | null>,
  newestId: string | null,
  enabled: boolean,
  onReadingChange?: (reading: boolean) => void,
) {
  const [paused, setPaused] = useState(false);
  const [forcedFollow, setForcedFollow] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const previous = useRef(newestId);
  const currentId = useRef(newestId);
  currentId.current = newestId;
  const away = useRef(false);
  const readingLatched = useRef(false);
  const manuallyPaused = useRef(false);
  const explicitlyResumed = useRef(false);
  const followedTop = useRef(0);
  const programmaticRange = useRef<{ from: number; to: number; expires: number } | undefined>(
    undefined,
  );
  const resuming = useRef(false);
  const resumeGraceUntil = useRef(0);
  const pendingFrame = useRef<number | undefined>(undefined);
  const settleTimer = useRef<number | undefined>(undefined);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const rows = () => [...(root.current?.querySelectorAll<HTMLElement>("[data-call-id]") ?? [])];
  const pinnedHeight = () =>
    Math.max(
      0,
      ...[
        ...(root.current?.querySelectorAll<HTMLElement>(
          "[data-follow-control], [data-pinned-update]",
        ) ?? []),
      ].map((node) => {
        const rect = node.getBoundingClientRect();
        if (!rect.height) return 0;
        const style = getComputedStyle(node);
        return (Number.parseFloat(style.top) || 0) + rect.height;
      }),
    ) + 12;
  const followLeading = () => {
    const scroller = root.current?.closest("main");
    if (!scroller) return;
    const row = rows().find((row) => row.dataset.callId === currentId.current);
    const top = row
      ? Math.max(
          0,
          scroller.scrollTop +
            row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            pinnedHeight(),
        )
      : 0;
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const target = Math.min(top, maximum);
    programmaticRange.current = {
      from: scroller.scrollTop,
      to: target,
      expires: performance.now() + 600,
    };
    followedTop.current = target;
    scroller.scrollTo({ top: target, behavior: "instant" });
  };
  useEffect(() => {
    const scroller = root.current?.closest("main");
    if (!scroller) return;
    const observe = () => {
      const nearTop = scroller.scrollTop <= 48;
      const range = programmaticRange.current;
      const now = performance.now();
      const inResumeGrace = now < resumeGraceUntil.current;
      const inProgrammaticRange =
        !!range &&
        now < range.expires &&
        scroller.scrollTop >= Math.min(range.from, range.to) - 4 &&
        scroller.scrollTop <= Math.max(range.from, range.to) + 4;
      const reachedProgrammaticTarget = !!range && Math.abs(scroller.scrollTop - range.to) <= 4;
      const positionalAway = !nearTop && Math.abs(scroller.scrollTop - followedTop.current) > 72;
      if (manuallyPaused.current) readingLatched.current = true;
      else if (
        explicitlyResumed.current ||
        resuming.current ||
        inResumeGrace ||
        inProgrammaticRange
      )
        readingLatched.current = false;
      else if (nearTop) readingLatched.current = false;
      else if (positionalAway) readingLatched.current = true;
      away.current = readingLatched.current;
      if (nearTop && !manuallyPaused.current) followedTop.current = scroller.scrollTop;
      if (reachedProgrammaticTarget) programmaticRange.current = undefined;
      setPaused(away.current);
      onReadingChange?.(enabled && away.current);
      if (!away.current) setUnseen(0);
      const top = scroller.getBoundingClientRect().top;
      const visible = rows().find(
        (row) => row.getBoundingClientRect().bottom > top + pinnedHeight(),
      );
      anchor.current = visible?.dataset.callId
        ? { id: visible.dataset.callId, offset: visible.getBoundingClientRect().top - top }
        : undefined;
    };
    const releaseExplicitResume = () => {
      explicitlyResumed.current = false;
      setForcedFollow(false);
      resumeGraceUntil.current = 0;
      programmaticRange.current = undefined;
      if (settleTimer.current !== undefined) {
        clearTimeout(settleTimer.current);
        settleTimer.current = undefined;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === scroller) releaseExplicitResume();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key))
        releaseExplicitResume();
    };
    observe();
    scroller.addEventListener("scroll", observe, { passive: true });
    scroller.addEventListener("wheel", releaseExplicitResume, { passive: true });
    scroller.addEventListener("touchstart", releaseExplicitResume, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    return () => {
      scroller.removeEventListener("scroll", observe);
      scroller.removeEventListener("wheel", releaseExplicitResume);
      scroller.removeEventListener("touchstart", releaseExplicitResume);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("keydown", onKeyDown);
    };
  }, [root, enabled, onReadingChange]);
  useEffect(() => {
    if (enabled) return;
    explicitlyResumed.current = false;
    readingLatched.current = false;
    setForcedFollow(false);
  }, [enabled]);
  useEffect(
    () => () => {
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
      if (settleTimer.current !== undefined) clearTimeout(settleTimer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    const changed = newestId !== previous.current && previous.current !== null;
    previous.current = newestId;
    if (!changed || !enabled) return;
    const scroller = root.current?.closest("main");
    if (!scroller) return;
    if (!away.current) {
      followLeading();
      setUnseen(0);
    } else {
      setUnseen((value) => value + 1);
      const saved = anchor.current;
      const sameRow = saved && rows().find((row) => row.dataset.callId === saved.id);
      if (sameRow && saved)
        scroller.scrollTop +=
          sameRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
    }
  }, [root, newestId, enabled]);
  const pause = () => {
    explicitlyResumed.current = false;
    setForcedFollow(false);
    if (settleTimer.current !== undefined) {
      clearTimeout(settleTimer.current);
      settleTimer.current = undefined;
    }
    manuallyPaused.current = true;
    readingLatched.current = true;
    away.current = true;
    setPaused(true);
    onReadingChange?.(enabled);
  };
  const resume = () => {
    explicitlyResumed.current = true;
    setForcedFollow(true);
    manuallyPaused.current = false;
    readingLatched.current = false;
    resuming.current = true;
    resumeGraceUntil.current = performance.now() + 600;
    programmaticRange.current = undefined;
    away.current = false;
    setPaused(false);
    onReadingChange?.(false);
    setUnseen(0);
    // React may first need to restore a filter or expand a nested ancestor.
    if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = requestAnimationFrame(() => {
      followLeading();
      resuming.current = false;
      if (settleTimer.current !== undefined) clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = undefined;
        if (!explicitlyResumed.current || manuallyPaused.current) return;
        followLeading();
        away.current = false;
        setPaused(false);
        onReadingChange?.(false);
        setUnseen(0);
      }, 280);
    });
  };
  return {
    paused: enabled && paused && !forcedFollow,
    suspended: enabled && paused && !forcedFollow,
    following: enabled && (forcedFollow || !paused),
    unseen,
    pause,
    resume,
  };
}
