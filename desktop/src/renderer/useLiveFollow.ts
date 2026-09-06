import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Follow new identities, not output chunks. Preserve both viewport and disclosures while reading. */
export function useLiveFollow(
  root: RefObject<HTMLElement | null>,
  newestId: string | null,
  enabled: boolean,
  onReadingChange?: (reading: boolean) => void,
) {
  const [paused, setPaused] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const previous = useRef(newestId);
  const currentId = useRef(newestId);
  currentId.current = newestId;
  const away = useRef(false);
  const manuallyPaused = useRef(false);
  const followedTop = useRef(0);
  const pendingFrame = useRef<number | undefined>(undefined);
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
    followedTop.current = top;
    scroller.scrollTo({ top, behavior: "instant" });
    followedTop.current = scroller.scrollTop; // Account for the native scroll range clamp.
  };
  useEffect(() => {
    const scroller = root.current?.closest("main");
    if (!scroller) return;
    const observe = () => {
      const nearTop = scroller.scrollTop <= 48;
      away.current =
        manuallyPaused.current ||
        (!nearTop && Math.abs(scroller.scrollTop - followedTop.current) > 72);
      if (nearTop && !manuallyPaused.current) followedTop.current = scroller.scrollTop;
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
    observe();
    scroller.addEventListener("scroll", observe, { passive: true });
    return () => scroller.removeEventListener("scroll", observe);
  }, [root, enabled, onReadingChange]);
  useEffect(
    () => () => {
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
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
    manuallyPaused.current = true;
    away.current = true;
    setPaused(true);
    onReadingChange?.(enabled);
  };
  const resume = () => {
    manuallyPaused.current = false;
    away.current = false;
    setPaused(false);
    onReadingChange?.(false);
    setUnseen(0);
    // React may first need to restore a filter or expand a nested ancestor.
    if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = requestAnimationFrame(followLeading);
  };
  return {
    paused: enabled && paused,
    suspended: paused,
    following: enabled && !paused,
    unseen,
    pause,
    resume,
  };
}
