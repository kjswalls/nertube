import Link from "next/link";

import { calendarHref } from "@/components/calendar/grid/url";
import { formatMonth, parseMonthKey, shiftMonth, monthKey } from "@/lib/calendar-dates";

/**
 * Which month is on screen, and how to reach the ones either side.
 *
 * Links, not buttons: the requirement is that a month can be *shared or
 * bookmarked*, which means every month has to have an address, and once it does
 * the navigation is an `<a href>` with everything that comes free with one —
 * middle-click, back button, keyboard, and no JavaScript.
 *
 * The month's own name is the `<h1>`, so the page announces what it is showing
 * before the grid. "This month" only appears when the view has left it, because
 * a control that does nothing is a control that has to be read to be dismissed.
 */
export function MonthNav({
  month,
  currentMonth,
  summary,
}: {
  month: string;
  /** The month containing today, so "This month" knows whether to render. */
  currentMonth: string;
  /** One line under the heading: what this month is holding. */
  summary: string;
}) {
  const parsed = parseMonthKey(month);
  if (parsed === null) return null;

  const previous = monthKey(shiftMonth(parsed, -1));
  const next = monthKey(shiftMonth(parsed, 1));

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <div className="flex flex-col gap-1">
        <h1
          data-testid="calendar-heading"
          data-month={month}
          className="font-display text-[22px] leading-tight font-semibold tracking-tight"
        >
          {formatMonth(parsed)}
        </h1>
        <p data-testid="calendar-summary" className="text-[12px] text-muted">
          {summary}
        </p>
      </div>

      <nav aria-label="Month" className="flex items-center gap-1">
        <MonthStep
          href={calendarHref({ month: previous })}
          testId="calendar-previous"
          month={previous}
          label={`Previous month, ${formatMonth(shiftMonth(parsed, -1))}`}
        >
          ← {formatMonth(shiftMonth(parsed, -1)).split(" ")[0]}
        </MonthStep>

        {month === currentMonth ? null : (
          <Link
            href={calendarHref({ month: currentMonth })}
            data-testid="calendar-this-month"
            className="rounded-button border border-border px-2 py-1 text-[12px] outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            This month
          </Link>
        )}

        <MonthStep
          href={calendarHref({ month: next })}
          testId="calendar-next"
          month={next}
          label={`Next month, ${formatMonth(shiftMonth(parsed, 1))}`}
        >
          {formatMonth(shiftMonth(parsed, 1)).split(" ")[0]} →
        </MonthStep>
      </nav>
    </div>
  );
}

function MonthStep({
  href,
  testId,
  month,
  label,
  children,
}: {
  href: string;
  testId: string;
  month: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      data-month={month}
      aria-label={label}
      className="rounded-button border border-border px-2 py-1 text-[12px] outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
    >
      {children}
    </Link>
  );
}
