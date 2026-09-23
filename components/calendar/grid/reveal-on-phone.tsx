"use client";

import { useEffect, useRef } from "react";

/**
 * Brings the day panel into view on a phone when a day is opened (M10).
 *
 * On a desktop the panel sits under a grid that fits the screen, next to the
 * day that opened it. On a phone the month is a list of days (see
 * `MonthGrid`) and the panel comes after it, so a tapped date opened a panel
 * a screen or more below the finger, and nothing on screen changed. Below
 * `md` this scrolls the panel's top to just under the pinned bar
 * (`scroll-padding-top` in `app/globals.css`) when it mounts or its day
 * changes; from `md` up it does nothing, so the desktop is exactly as it was.
 *
 * Rendered inside the panel and drawing nothing, so the server-rendered panel
 * stays a server component.
 */
export function RevealOnPhone({ date }: { date: string }) {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(width < 48rem)").matches) return;
    const panel = marker.current?.parentElement;
    if (!panel) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [date]);

  return <span ref={marker} hidden />;
}
