import Link from "next/link";

import { EventChip } from "@/components/calendar/grid/event-chip";
import { byDate, packDay } from "@/components/calendar/grid/density";
import { calendarHref } from "@/components/calendar/grid/url";
import type {
  CalendarChannel,
  CalendarEvent,
} from "@/components/calendar/grid/types";
import { eventKey } from "@/components/calendar/grid/types";
import {
  formatDateColumn,
  formatMonth,
  monthGrid,
  monthKey,
  monthOf,
  parseDateColumn,
  parseMonthKey,
  type DateColumn,
} from "@/lib/calendar-dates";

/**
 * The month, drawn.
 *
 * ## It is a table, because it is one
 *
 * Seven columns with headers and a row per week is tabular data, and a real
 * `<table>` gives a screen reader the column header ("Wednesday") with every
 * cell for free. A grid of `<div>`s would need `role="grid"`, `role="row"`,
 * `role="gridcell"` and `aria-label` on every cell to say the same thing less
 * reliably.
 *
 * ## Nothing here is a client component
 *
 * Month navigation is links, the overflow is a link, a chip is a link. There is
 * no state on this page that is not in the URL, so there is no JavaScript on
 * it: the calendar works on a cold cache, in a browser with scripting off, and
 * — the part that matters for a bookmark — every view of it has an address.
 *
 * ## Days from the neighbouring months
 *
 * They are drawn, on the page's ground rather than on a card, with their
 * numbers muted and `data-in-month="false"`. They carry **no events**: the
 * page's every number counts the same set, which is *this month*, and a chip on
 * a trailing cell would be a video counted by the grid and not by the heading.
 * The link on those cells goes to the month they do belong to.
 */
export function MonthGrid({
  month,
  events,
  channels,
  today,
  openDay,
}: {
  /** `YYYY-MM`. */
  month: string;
  /** Everything inside the month. Anything outside it is ignored. */
  events: readonly CalendarEvent[];
  channels: readonly CalendarChannel[];
  /** The `YYYY-MM-DD` that is today, decided once by the page. */
  today: DateColumn;
  /** The day whose panel is open, so its cell can be marked. */
  openDay: DateColumn | null;
}) {
  const parsed = parseMonthKey(month);
  if (parsed === null) return null;

  const weeks = monthGrid(parsed);
  const grouped = byDate(events);
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));

  return (
    <table
      data-testid="calendar-grid"
      data-month={month}
      className="w-full table-fixed border-collapse"
    >
      <caption className="sr-only">
        Target publish dates and filming days in {formatMonthCaption(month)}
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map((weekday) => (
            <th
              key={weekday.short}
              scope="col"
              className="px-1 pb-1 text-left text-[11px] font-medium tracking-[0.06em] text-muted uppercase"
            >
              <abbr title={weekday.long} className="no-underline">
                {weekday.short}
              </abbr>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0].date}>
            {week.map((cell) => {
              const packed = packDay(
                cell.inMonth ? (grouped.get(cell.date) ?? []) : [],
              );
              const isToday = cell.date === today;

              return (
                <td
                  key={cell.date}
                  data-testid="calendar-day"
                  data-date={cell.date}
                  data-in-month={cell.inMonth ? "true" : "false"}
                  data-today={isToday ? "true" : undefined}
                  data-events={packed.all.length}
                  className={[
                    "h-28 w-[calc(100%/7)] border border-border p-1 align-top",
                    cell.inMonth ? "bg-surface" : "bg-background",
                    openDay === cell.date ? "outline-2 outline-accent" : "",
                  ].join(" ")}
                >
                  <div className="flex h-full flex-col gap-1">
                    <DayNumber
                      cell={cell}
                      month={month}
                      isToday={isToday}
                      count={packed.all.length}
                    />

                    <div className="flex min-h-0 flex-col gap-0.5">
                      {packed.shown.map((event) => (
                        <EventChip
                          key={eventKey(event)}
                          event={event}
                          channel={
                            event.kind === "publish"
                              ? channelById.get(event.channelId)
                              : undefined
                          }
                          month={month}
                        />
                      ))}

                      {packed.hidden > 0 ? (
                        <Link
                          href={calendarHref({ month, day: cell.date })}
                          data-testid="calendar-overflow"
                          data-date={cell.date}
                          data-hidden={packed.hidden}
                          className="rounded-button px-1 text-left text-[11px] leading-4 font-medium text-muted underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          +{packed.hidden} more
                          <span className="sr-only">
                            {" "}
                            on {formatDateColumn(cell.date, "full")}
                          </span>
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The number in the corner, and the two things it can also be: today, or a day
 * belonging to the month either side.
 *
 * Today is marked three ways, only one of which is colour: the accent disc
 * behind the number, the bolder weight, and the words "Today" for a screen
 * reader. A day outside the month is muted *and* sits on a different ground
 * *and* says which month it belongs to when it is opened.
 */
function DayNumber({
  cell,
  month,
  isToday,
  count,
}: {
  cell: { date: DateColumn; inMonth: boolean };
  month: string;
  isToday: boolean;
  count: number;
}) {
  const number = (
    <span
      className={[
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[11px]",
        isToday
          ? "bg-accent font-semibold text-surface"
          : cell.inMonth
            ? "text-foreground"
            : "text-muted",
      ].join(" ")}
    >
      {parseDateColumn(cell.date)?.day}
    </span>
  );

  return (
    <div className="flex items-baseline justify-between gap-1">
      {cell.inMonth ? (
        <span className="flex items-center gap-1">
          {number}
          {isToday ? (
            <span data-testid="calendar-today" className="sr-only">
              Today,
            </span>
          ) : null}
          <span className="sr-only">
            {formatDateColumn(cell.date, "full")}
            {count === 0
              ? ", nothing planned"
              : count === 1
                ? ", 1 entry"
                : `, ${count} entries`}
          </span>
        </span>
      ) : (
        /* A borrowed day is a link to the month it actually belongs to, which
           is both a second way of saying "this is not part of this month" and
           the fastest way to follow a date you can see at the edge. */
        <Link
          href={calendarHref({ month: monthOfCell(cell.date) })}
          className="rounded-button outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title={`${formatDateColumn(cell.date, "full")} — in ${formatMonthCaption(monthOfCell(cell.date))}`}
        >
          {number}
          <span className="sr-only">
            {formatDateColumn(cell.date, "full")}, not in this month
          </span>
        </Link>
      )}
    </div>
  );
}

function formatMonthCaption(month: string): string {
  const parsed = parseMonthKey(month);
  return parsed === null ? month : formatMonth(parsed);
}

/** The month a borrowed cell belongs to, through the helper and not a slice. */
function monthOfCell(date: DateColumn): string {
  const parsed = monthOf(date);
  return parsed === null ? date : monthKey(parsed);
}

/**
 * Monday first, matching `weekdayIndex` in the date helper and the en-GB week
 * every other date in this product is formatted in.
 */
const WEEKDAYS = [
  { short: "Mon", long: "Monday" },
  { short: "Tue", long: "Tuesday" },
  { short: "Wed", long: "Wednesday" },
  { short: "Thu", long: "Thursday" },
  { short: "Fri", long: "Friday" },
  { short: "Sat", long: "Saturday" },
  { short: "Sun", long: "Sunday" },
] as const;
