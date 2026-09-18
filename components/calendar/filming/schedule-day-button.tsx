"use client";

import { useRef, useState } from "react";

import { addDays, weekdayIndex } from "@/lib/calendar-dates";

import { ScheduleDayDialog } from "./schedule-day-dialog";
import type { FilmingCandidate } from "./types";

/**
 * The control that opens the schedule flow, and the one place that decides
 * which date it opens on.
 *
 * It has **one caller today**: the board's Filming badge, which is the whole
 * point of BRIEF.md principle 4. The `plain` tone is the second one — the
 * calendar's own "Schedule a filming day" affordance, which belongs to the
 * other M6 slice's page and is named in `docs/MILESTONES.md` as the seam
 * between them. It is three lines of `className`, kept because the join is a
 * this-milestone job rather than a future one; if the integration decides
 * otherwise, delete the prop.
 *
 * ## Why the date defaults to the next Saturday
 *
 * Because a batch day is the thing you do when you have a block of time, and
 * BRIEF.md's own example of one is a Saturday. Opening on today would put the
 * shoot on a Tuesday evening by default, which is the exact opposite of what
 * the badge is suggesting. It is a *default*, not a rule — the date box is a
 * date box — and it is computed from the server's `today` rather than from the
 * browser's clock so that it is the same suggestion on both sides of hydration.
 */
export function ScheduleFilmingDayButton({
  candidates,
  today,
  label,
  title,
  tone = "plain",
  testId = "schedule-filming-day",
}: {
  candidates: readonly FilmingCandidate[];
  /** `YYYY-MM-DD`, from the page's one clock read. */
  today: string;
  label: string;
  title?: string;
  /**
   * `badge` is the board's Filming column: it is already an attention-toned
   * line under the column count, and it keeps that tone when it becomes a
   * button, because the signal has not changed — only what you can do about it.
   */
  tone?: "plain" | "badge";
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  /**
   * Where focus was when the dialog was asked for. Recorded in the handler
   * rather than in the modal's mount effect, for the reason
   * `components/capture/capture-host.tsx` documents: by the time an effect
   * runs, focus is already inside the dialog.
   */
  const returnFocus = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        title={title}
        onClick={() => {
          returnFocus.current = buttonRef.current;
          setOpen(true);
        }}
        className={
          tone === "badge"
            ? // The badge's own treatment, kept: an attention-toned line under
              // the column count. It gains a border and a pointer because it is
              // now a control, and nothing else about it changes — the signal
              // was already right, it simply had nothing behind it.
              "w-full rounded-button border border-attention/40 bg-attention/15 px-1.5 py-1 text-left text-[11px] leading-4 font-medium text-attention outline-none transition-colors hover:bg-attention/25 focus-visible:ring-2 focus-visible:ring-accent"
            : "rounded-button border border-border bg-surface px-3 py-1.5 text-[13px] outline-none transition-colors hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent"
        }
      >
        {label}
      </button>

      {open ? (
        <ScheduleDayDialog
          candidates={candidates}
          defaultDate={nextSaturday(today)}
          today={today}
          returnFocusRef={returnFocus}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The next Saturday on or after `today`.
 *
 * Whole days through `lib/calendar-dates.ts`, so it is a calendar walk and not
 * millisecond arithmetic: adding `6 * 86_400_000` to a local-time `Date` across
 * a clock change lands on a Friday twice a year.
 */
export function nextSaturday(today: string): string {
  const weekday = weekdayIndex(today);
  // Monday is 0 here, so Saturday is 5.
  if (weekday === null) return today;
  return addDays(today, (5 - weekday + 7) % 7) ?? today;
}
