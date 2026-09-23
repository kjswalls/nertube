import Link from "next/link";

import { calendarHref } from "@/components/calendar/grid/url";
import {
  PRIMARY_ACTION,
  QUIET_ACTION,
  StatePanel,
} from "@/components/state-panel";
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

  /*
    M9: the application's one empty-state presentation (`StatePanel`), with the
    three things above as its title, its sentence and its way forward. The
    title keeps its exact words, which `e2e/calendar.spec.ts` asserts.
  */
  return (
    <StatePanel
      testId="calendar-empty"
      title={`Nothing is going out in ${label}, and no filming day is booked.`}
      actions={
        nothingAnywhere ? (
          boardHref ? (
            <Link href={boardHref} className={PRIMARY_ACTION}>
              Open the board
            </Link>
          ) : (
            <Link href="/c/new" className={PRIMARY_ACTION}>
              Create your first channel
            </Link>
          )
        ) : (
          nearest.map((entry) => (
            <Link
              key={entry.month}
              href={calendarHref({ month: entry.month })}
              data-testid="calendar-nearest"
              data-month={entry.month}
              className={entry === nearest[0] ? PRIMARY_ACTION : QUIET_ACTION}
            >
              {labelOf(entry.month)}{" "}
              <span className="font-mono text-[11px] opacity-80">
                ({entry.count})
              </span>
            </Link>
          ))
        )
      }
    >
      {nothingAnywhere ? (
        <p data-scope="nothing-anywhere">
          No video has a target publish date yet. A date is set on the
          video&rsquo;s own page; from then on it sits on that day here, beside
          every other channel&rsquo;s, so the rhythm of what is going out is
          one page. Filming days are booked with the button above.
        </p>
      ) : (
        <p data-scope="empty-month">
          The nearest {nearest.length === 1 ? "month" : "months"} with anything
          in {nearest.length === 1 ? "it" : "them"}:
        </p>
      )}
    </StatePanel>
  );
}

/** "September 2026", or the raw key if it is somehow not a month. */
function labelOf(month: string): string {
  const parsed = parseMonthKey(month);
  return parsed === null ? month : formatMonth(parsed);
}
