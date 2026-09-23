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
  weekdayIndex,
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
 *
 * ## Below 768px it is a list of days, from the same markup (M10)
 *
 * Seven columns of a 358px column are 51px a day. That held a date and a
 * chip 41px wide showing two or three letters of a title — the month could
 * not be *read* on a phone, only tapped at chip by chip (M9 said so and left
 * it). A grid cannot be made to work at that width: the titles are the
 * content, and a title needs the width of the screen.
 *
 * So below `md` the same table is restyled, not re-rendered: the table, its
 * body and its rows become boxes (`display: block` / `contents`), the header
 * row goes (each day carries its own weekday instead), and every in-month day
 * that holds something — plus today, and the day that is open — becomes a
 * row: a 44px date on the left that opens the day, the chips down the right
 * at full width with their titles wrapped rather than cut. Empty days and the
 * neighbouring months' days are `display: none` there. One DOM, so there is
 * one chip per video at every width (a second, phone-only rendering would
 * put every test id and every link on the page twice), and the desktop grid
 * is untouched: every phone rule is a `max-md:` variant and the date link is
 * `md:hidden`.
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
      className="w-full table-fixed border-collapse max-md:block"
    >
      <caption className="sr-only">
        Target publish dates and filming days in {formatMonthCaption(month)}
      </caption>
      <thead className="max-md:hidden">
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
      <tbody className="max-md:flex max-md:flex-col max-md:gap-2">
        {weeks.map((week) => (
          <tr key={week[0].date} className="max-md:contents">
            {week.map((cell) => {
              const packed = packDay(
                cell.inMonth ? (grouped.get(cell.date) ?? []) : [],
              );
              const isToday = cell.date === today;
              const isOpen = openDay === cell.date;
              // The phone's list: days with something on them, today and the
              // open day. See "Below 768px" above.
              const listed =
                cell.inMonth && (packed.all.length > 0 || isToday || isOpen);

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
                    "max-md:h-auto max-md:w-full max-md:rounded-card max-md:p-2",
                    listed ? "max-md:block" : "max-md:hidden",
                    cell.inMonth ? "bg-surface" : "bg-background",
                    isOpen ? "outline-2 outline-accent" : "",
                  ].join(" ")}
                >
                  <div className="flex h-full flex-col gap-1 max-md:flex-row max-md:items-start max-md:gap-3">
                    <DayNumber
                      cell={cell}
                      isToday={isToday}
                      count={packed.all.length}
                      month={month}
                    />

                    <div className="flex min-h-0 flex-col gap-0.5 max-md:min-w-0 max-md:flex-1 max-md:gap-1.5">
                      {packed.all.length === 0 ? (
                        <p className="py-3 text-[13px] text-muted md:hidden">
                          Nothing planned.
                        </p>
                      ) : null}
                      {packed.shown.map((event) => (
                        <EventChip
                          key={eventKey(event)}
                          event={event}
                          channel={
                            event.kind === "publish"
                              ? channelById.get(event.channelId)
                              : undefined
                          }
                          showTag={channels.length > 1}
                          month={month}
                        />
                      ))}

                      {packed.hidden > 0 ? (
                        <Link
                          href={calendarHref({ month, day: cell.date })}
                          data-testid="calendar-overflow"
                          data-date={cell.date}
                          data-hidden={packed.hidden}
                          className="rounded-button px-1 text-left text-[11px] leading-4 font-medium text-muted underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent max-md:flex max-md:min-h-11 max-md:items-center max-md:text-[13px]"
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
  isToday,
  count,
  month,
}: {
  cell: { date: DateColumn; inMonth: boolean };
  isToday: boolean;
  count: number;
  month: string;
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
        <>
        {/*
          The phone's way into a day (M10): the date itself, 44px, weekday
          above the number because the column headers are gone at that width.
          `md:hidden`, so the desktop grid keeps exactly the tab stops it had.
        */}
        <Link
          href={calendarHref({ month, day: cell.date })}
          data-testid="calendar-day-open"
          data-date={cell.date}
          className="flex min-h-11 w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-button border border-border bg-background py-1 outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent md:hidden"
        >
          <span aria-hidden="true" className="text-[10px] font-medium tracking-[0.06em] text-muted uppercase">
            {weekdayOf(cell.date)}
          </span>
          <span
            aria-hidden="true"
            className={[
              "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 font-mono text-[13px]",
              isToday ? "bg-accent font-semibold text-surface" : "text-foreground",
            ].join(" ")}
          >
            {parseDateColumn(cell.date)?.day}
          </span>
          <span className="sr-only">
            Open {isToday ? "today, " : ""}
            {formatDateColumn(cell.date, "full")}
          </span>
        </Link>
        <span className="flex items-center gap-1 max-md:hidden">
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
        </>
      ) : (
        /* A borrowed day is a link to the month it actually belongs to, which
           is both a second way of saying "this is not part of this month" and
           the fastest way to follow a date you can see at the edge. */
        <Link
          href={calendarHref({ month: monthOfCell(cell.date) })}
          // 44px square under a thumb: the grid is what a phone held sideways
          // gets, and a 20px number is not a target (M10 review).
          className="rounded-button outline-none focus-visible:ring-2 focus-visible:ring-accent thumb:inline-flex thumb:size-11 thumb:items-center thumb:justify-center"
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

/** "Thu", for the phone's date block — `weekdayIndex` is Monday = 0. */
function weekdayOf(date: DateColumn): string {
  const index = weekdayIndex(date);
  return index === null ? "" : WEEKDAYS[index].short;
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
