import Link from "next/link";

import { calendarHref } from "@/components/calendar/grid/url";
import { formatMonth, parseMonthKey } from "@/lib/calendar-dates";

/** The nearest month either side that actually has something in it. */
export interface NearestMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  /** How many videos are targeted at it. */
  readonly count: number;
}

/**
 * A month with nothing in it, said out loud.
 *
 * An empty calendar is the most common state this page will ever be in — a new
 * account has no target dates at all, and a month three ahead of the plan never
 * does — and the failure mode is a grey grid that looks identical to a broken
 * one. So the empty month says three things a grid cannot:
 *
 * 1. **Which month is empty**, by name, so it is clear the page is answering
 *    the question that was asked and not failing to load.
 * 2. **Whether anything exists anywhere.** A month with nothing either side is
 *    a different situation from one sitting between two busy months, and the
 *    sentence is different: the first tells you how a date gets set, the second
 *    points at the work that is already scheduled.
 * 3. **The nearest month that has something**, as a link, because the honest
 *    next action when December is empty is usually to go and look at November.
 */
export function EmptyMonth({
  month,
  previous,
  next,
  boardHref,
}: {
  month: string;
  previous: NearestMonth | null;
  next: NearestMonth | null;
  /** Where target dates get set from. Null when there is no channel yet. */
  boardHref: string | null;
}) {
  const label = labelOf(month);
  const nearest = [previous, next].filter(
    (entry): entry is NearestMonth => entry !== null,
  );
  const nothingAnywhere = nearest.length === 0;

  return (
    <div
      data-testid="calendar-empty"
      data-scope={nothingAnywhere ? "nothing-anywhere" : "empty-month"}
      className="rounded-card border border-border bg-surface px-4 py-3"
    >
      <p className="font-display text-[15px]">
        Nothing is going out in {label}, and no filming day is booked.
      </p>

      {nothingAnywhere ? (
        <p className="mt-1 text-[13px] text-muted">
          No video anywhere has a target publish date yet. A date set on a
          video&rsquo;s page — or on a card from{" "}
          {boardHref ? (
            <Link
              href={boardHref}
              className="underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
            >
              the board
            </Link>
          ) : (
            "the board"
          )}{" "}
          — is what puts it here. Publishing is a rhythm; this is where it
          becomes visible.
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-muted">
          The nearest month with anything in it is{" "}
          {nearest.map((entry, index) => (
            <span key={entry.month}>
              <Link
                href={calendarHref({ month: entry.month })}
                data-testid="calendar-nearest"
                data-month={entry.month}
                className="underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
              >
                {labelOf(entry.month)}
              </Link>{" "}
              <span className="font-mono text-[11px]">({entry.count})</span>
              {index < nearest.length - 1 ? ", or " : "."}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** "September 2026", or the raw key if it is somehow not a month. */
function labelOf(month: string): string {
  const parsed = parseMonthKey(month);
  return parsed === null ? month : formatMonth(parsed);
}
