/**
 * Calendar days, and the one place this application turns a `date` column into
 * a cell in a grid.
 *
 * ## The bug this file exists to prevent
 *
 * `videos.target_publish_date` and `filming_days.on_date` are Postgres `date`
 * columns. A `date` is a **calendar day**: "the 3rd of March", with no time, no
 * offset and no instant attached to it. PostgREST hands one over as the string
 * `"2026-03-03"`, and every timezone bug in a calendar starts with somebody
 * turning that string into a `Date`:
 *
 * ```ts
 * new Date("2026-03-03")            // midnight UTC — 2 March in New York
 * new Date("2026-03-03").getDate()  // 2, for half the planet
 * ```
 *
 * So nothing in this module ever constructs a `Date` from a bare date string,
 * and nothing calls a local-time getter (`getDate`, `getMonth`, `getDay`) or a
 * local-time constructor (`new Date(y, m, d)`). Every conversion goes through
 * `Date.UTC(...)` and the `getUTC*` family, which are the only parts of the
 * platform's date arithmetic that do not consult the machine's zone — and
 * `Date.UTC` normalises overflow (`Date.UTC(2026, 0, 32)` is 1 February), which
 * is where the month-end arithmetic below comes from.
 *
 * The consequence worth stating, because it is the whole point: **every
 * function here returns the same answer on the server and in the browser, in
 * any timezone, on any day of the year, including the two on which the clocks
 * change.** The unit suite runs it under `TZ=America/Los_Angeles` as well as
 * under UTC for exactly that reason (`lib/calendar-dates.test.ts`).
 *
 * ## "Today", and the one honest limitation
 *
 * `todayColumn(ms)` reads the clock in **UTC**, not in the viewer's zone. That
 * is a decision, not an oversight, and it is recorded in `docs/MILESTONES.md`
 * under M6's "Decisions taken without the user":
 *
 * - The alternative — the browser's local day — cannot be computed on the
 *   server, so the server render and the hydrated render would disagree about
 *   which cell is today, which React reports as a hydration error and which a
 *   user sees as the highlight jumping.
 * - The app has no timezone setting yet. Settings is M7, and a `profiles.tz`
 *   there is the one-line fix: this function takes the millisecond clock and
 *   nothing else, so the change is confined to its callers.
 *
 * What it costs: a viewer west of UTC sees "today" advance in the late evening.
 * Nothing *stored* depends on it — a filming day is scheduled by picking a date
 * — so the cost is confined to the "today" ring and the past/upcoming split.
 */

/* -------------------------------------------------------------------------- */
/* The type                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A `date` column as the database hands it over and as `<input type="date">`
 * speaks it: `YYYY-MM-DD`.
 *
 * A branded alias would be stronger, but every value of it arrives as a plain
 * string from PostgREST or from a DOM input, so the brand would be cast on at
 * the boundary and prove nothing. `parseDateColumn` is the real check.
 */
export type DateColumn = string;

/** Shape, not validity: `2026-02-31` matches this and is still not a day. */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day, taken apart. `month` is 1–12, like a human says it. */
export interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/* -------------------------------------------------------------------------- */
/* Parse and format                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `"2026-03-03"` → `{year: 2026, month: 3, day: 3}`, or `null`.
 *
 * Round-tripped through `Date.UTC` so that a date which does not exist is
 * rejected rather than silently rolled forward: `2026-02-30` normalises to 2
 * March, the round trip notices the change, and the answer is `null`. That
 * matters because the round trip is how the arithmetic below works, and a
 * function that accepts the 30th of February would hand a caller the 2nd of
 * March wearing the wrong label.
 */
export function parseDateColumn(
  value: string | null | undefined,
): CalendarDay | null {
  if (typeof value !== "string") return null;
  const match = SHAPE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // `Date.UTC` maps years 0–99 onto 1900–1999; nothing in this product is
  // dated in the first century, and refusing is better than rewriting.
  if (year < 100) return null;

  const stamp = Date.UTC(year, month - 1, day);
  const back = new Date(stamp);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/** True when `value` is a real calendar day in `YYYY-MM-DD`. */
export function isDateColumn(value: string | null | undefined): boolean {
  return parseDateColumn(value) !== null;
}

/**
 * `{year, month, day}` → `"YYYY-MM-DD"`, normalising overflow the way
 * `Date.UTC` does: month 13 is January of the next year, day 0 is the last day
 * of the previous month. That normalisation is deliberate — it is what makes
 * `addDays` and `shiftMonth` below one line each instead of a calendar's worth
 * of special cases.
 */
export function toDateColumn(day: CalendarDay): DateColumn {
  return columnOfStamp(Date.UTC(day.year, day.month - 1, day.day));
}

/** The UTC midnight instant of a calendar day — the internal currency here. */
function stampOf(value: DateColumn): number | null {
  const day = parseDateColumn(value);
  if (day === null) return null;
  return Date.UTC(day.year, day.month - 1, day.day);
}

/** A UTC instant back to `YYYY-MM-DD`, zero-padded by hand rather than sliced. */
function columnOfStamp(stamp: number): DateColumn {
  const date = new Date(stamp);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/* -------------------------------------------------------------------------- */
/* The clock                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which calendar day `ms` falls on, in UTC. See the note at the top about why
 * it is UTC and what that costs.
 *
 * The clock is a parameter, never read here: a module that called `Date.now()`
 * itself could not be unit-tested around midnight, and a component that called
 * it during render would produce a different answer on each side of hydration.
 * The server reads the clock once per request and passes the answer down —
 * which is the same discipline `app/c/[slug]/board/page.tsx` already applies to
 * "days in stage".
 */
export function todayColumn(ms: number): DateColumn {
  return columnOfStamp(startOfUtcDay(ms));
}

/** `ms` floored to UTC midnight. */
function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

/* -------------------------------------------------------------------------- */
/* Comparison and arithmetic                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Chronological order. `YYYY-MM-DD` is designed so that lexicographic order
 * *is* chronological order, so this is a string comparison on purpose: it costs
 * nothing, it cannot overflow, and it sorts the exact strings the database
 * returned. Invalid input sorts last rather than throwing, so one malformed row
 * cannot take a whole month's render down.
 */
export function compareDateColumns(a: DateColumn, b: DateColumn): number {
  const aOk = isDateColumn(a);
  const bOk = isDateColumn(b);
  if (!aOk || !bOk) return aOk === bOk ? 0 : aOk ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `days` later (or earlier, for a negative number) than `value`.
 *
 * Adding days by adding `86_400_000` milliseconds to a local-time `Date` is the
 * other classic calendar bug: on the day the clocks go forward that arithmetic
 * lands at 01:00 of the *same* day, and on the day they go back it lands at
 * 23:00 of the previous one. `Date.UTC(y, m, d + days)` has no such day —
 * every UTC day is exactly 24 hours long — and normalises across month and year
 * ends by itself.
 */
export function addDays(value: DateColumn, days: number): DateColumn | null {
  const day = parseDateColumn(value);
  if (day === null) return null;
  return columnOfStamp(Date.UTC(day.year, day.month - 1, day.day + days));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: DateColumn, to: DateColumn): number | null {
  const a = stampOf(from);
  const b = stampOf(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Day of the week, **Monday = 0**, because the grid starts its weeks on a
 * Monday (en-GB, and the creator's week in BRIEF.md starts with a Monday
 * planning session and ends with a Saturday film day).
 *
 * `getUTCDay()` counts from Sunday, hence the shift.
 */
export function weekdayIndex(value: DateColumn): number | null {
  const stamp = stampOf(value);
  if (stamp === null) return null;
  return (new Date(stamp).getUTCDay() + 6) % 7;
}

/* -------------------------------------------------------------------------- */
/* Months                                                                      */
/* -------------------------------------------------------------------------- */

/** A month, as the calendar page addresses one. `month` is 1–12. */
export interface CalendarMonth {
  readonly year: number;
  readonly month: number;
}

/** `"YYYY-MM"` — the `?month=` parameter, and a map key. */
export function monthKey(month: CalendarMonth): string {
  return `${pad(month.year, 4)}-${pad(month.month, 2)}`;
}

/** `"YYYY-MM"` back to a month, or `null`. Accepts a full date column too. */
export function parseMonthKey(value: string | null | undefined): CalendarMonth | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 100 || month < 1 || month > 12) return null;
  return { year, month };
}

/** The month a date column falls in. */
export function monthOf(value: DateColumn): CalendarMonth | null {
  const day = parseDateColumn(value);
  if (day === null) return null;
  return { year: day.year, month: day.month };
}

/** `delta` months later, normalised across year ends by `Date.UTC`. */
export function shiftMonth(month: CalendarMonth, delta: number): CalendarMonth {
  const stamp = Date.UTC(month.year, month.month - 1 + delta, 1);
  const date = new Date(stamp);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

/** The first day of a month, as a date column. */
export function firstOfMonth(month: CalendarMonth): DateColumn {
  return columnOfStamp(Date.UTC(month.year, month.month - 1, 1));
}

/**
 * The last day of a month. `day 0` of the *next* month is the last day of this
 * one — the identity that means this file contains no table of month lengths
 * and no leap-year rule of its own.
 */
export function lastOfMonth(month: CalendarMonth): DateColumn {
  return columnOfStamp(Date.UTC(month.year, month.month, 0));
}

/** One cell of the month grid. */
export interface GridCell {
  readonly date: DateColumn;
  /** False for the leading and trailing days that belong to a neighbour. */
  readonly inMonth: boolean;
}

/**
 * The month laid out as whole weeks, Monday first — the grid `/calendar` draws.
 *
 * Always whole weeks, so every row has seven cells and the leading and trailing
 * days of the neighbouring months are real dates rather than blanks: a target
 * date on the 31st of the previous month still renders in the first row, which
 * is what a person looking at the start of a month is actually asking about.
 *
 * The number of rows follows the month (four in a non-leap February beginning
 * on a Monday, six for a 31-day month beginning on a Sunday) rather than being
 * padded to a constant six: a fixed grid draws a whole blank week below some
 * months, and there is nothing in it to see.
 */
export function monthGrid(month: CalendarMonth): GridCell[][] {
  const first = firstOfMonth(month);
  const last = lastOfMonth(month);
  const lead = weekdayIndex(first) ?? 0;
  const trail = 6 - (weekdayIndex(last) ?? 6);

  const start = Date.UTC(month.year, month.month - 1, 1 - lead);
  const total =
    (Date.UTC(month.year, month.month, 0) -
      Date.UTC(month.year, month.month - 1, 1)) /
      86_400_000 +
    1 +
    lead +
    trail;

  const weeks: GridCell[][] = [];
  for (let index = 0; index < total; index += 1) {
    const date = columnOfStamp(start + index * 86_400_000);
    if (index % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({
      date,
      inMonth: date >= first && date <= last,
    });
  }
  return weeks;
}

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The formatter cache.
 *
 * `Intl.DateTimeFormat` is expensive to construct and a month grid formats
 * forty-two of them; one instance per style is the documented way to avoid
 * paying for it per cell.
 *
 * `en-GB` and `timeZone: "UTC"`, fixed, for the same reason every other
 * formatted date in this codebase is (`app/c/[slug]/board/page.tsx`,
 * `components/video-detail/flow-fields.tsx`): the server and the browser must
 * produce byte-identical text or hydration reports it, and the machine's locale
 * is not something either end agrees about.
 */
const FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
  /** `3 Mar` — a cell, a chip, a card. */
  short: { day: "numeric", month: "short", timeZone: "UTC" },
  /** `3 Mar 2026` — anywhere the year could be in doubt. */
  medium: { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" },
  /** `Tuesday 3 March 2026` — a heading, and a filming day's own line. */
  full: {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  },
  /** `Tue 3 Mar` — the compact form with the day of the week still in it. */
  weekday: { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" },
  /** `March 2026` — the month heading. */
  month: { month: "long", year: "numeric", timeZone: "UTC" },
};

export type DateStyle = keyof typeof FORMATS;

const formatters = new Map<DateStyle, Intl.DateTimeFormat>();

function formatterFor(style: DateStyle): Intl.DateTimeFormat {
  const existing = formatters.get(style);
  if (existing) return existing;
  const made = new Intl.DateTimeFormat("en-GB", FORMATS[style]);
  formatters.set(style, made);
  return made;
}

/**
 * A date column in words. `null` for anything that is not a calendar day, so a
 * caller renders nothing rather than "Invalid Date".
 */
export function formatDateColumn(
  value: string | null | undefined,
  style: DateStyle = "medium",
): string | null {
  const stamp = typeof value === "string" ? stampOf(value) : null;
  if (stamp === null) return null;
  return formatterFor(style).format(stamp);
}

/** `March 2026`, from a month rather than from a day. */
export function formatMonth(month: CalendarMonth): string {
  return formatterFor("month").format(Date.UTC(month.year, month.month - 1, 1));
}

/**
 * How a date sits relative to today, in the words the calendar uses: "Today",
 * "Tomorrow", "Yesterday", "in 3 days", "6 days ago".
 *
 * Whole calendar days apart, never hours: "tomorrow" is the next square on the
 * grid, and an hours-based answer would call 23:00 tonight and 08:00 tomorrow
 * "in 9 hours" and refuse to say the word.
 */
export function relativeDayLabel(
  value: DateColumn,
  today: DateColumn,
): string | null {
  const delta = daysBetween(today, value);
  if (delta === null) return null;
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  if (delta > 0) return `in ${delta} days`;
  return `${-delta} days ago`;
}
