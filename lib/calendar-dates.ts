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
 * ## "Today" is the user's day (M10)
 *
 * A `date` column has no zone, but *today* does: it is whichever square of the
 * calendar the person looking at it is standing in. So `todayColumn(ms, zone)`
 * takes the zone as well as the clock, and answers with the calendar day that
 * instant falls on **in that zone** — turning over at the user's local
 * midnight, on both sides of a DST change, including in zones whose offset is
 * not a whole hour (Asia/Kolkata) and zones a day ahead of UTC
 * (Pacific/Auckland). `lib/calendar-dates.zone.test.ts` pins all of that.
 *
 * The zone is the user's, stored per user in `public.profiles` (migration
 * 0010) so the phone and the laptop agree, and read **once per request** on
 * the server by `readTimeZone()` in `lib/time-zone-data.ts` — the same
 * discipline as the clock. The server passes both down; a client component
 * reads the zone from `useTimeZone()` (`components/time-zone.tsx`), which is
 * the server's value handed over, and never asks its own browser during
 * render. That is what keeps the server's HTML and the hydrated render
 * byte-identical: both format with the same zone string, not with "whatever
 * zone this machine is in".
 *
 * Until a user's zone is known (a session that predates M10, or a browser
 * whose zone the server's tz database does not know), the zone is `UTC` — the
 * behaviour of M6–M9 — and the calendar, `/now` and Settings say so.
 *
 * Two things stay zoneless on purpose:
 *
 * - **Date columns.** Everything below the clock section — parsing, adding
 *   days, month grids, formatting a `date` — is arithmetic on calendar days and
 *   uses UTC only as an internal representation. A target date of 3 March is
 *   3 March in every zone.
 * - **Durations.** "Days in stage", "waiting 3 days" and "24 hours after
 *   publish" are elapsed time (`now - then`), not calendar days, so they do not
 *   depend on the zone and do not call anything here.
 *
 * Instants shown as dates (published at, the swap log, a capture date) are
 * formatted in the user's zone by `formatInstant`, and a date column turned
 * into an instant (the target date `confirmLive` stamps as `published_at`) is
 * the user's local midnight, by `startOfDay`.
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
 * A time zone: an IANA name such as `"Europe/London"`, or exactly `"UTC"`.
 *
 * Only `canonicalTimeZone` makes one from outside input. A plain string alias
 * for the reason `DateColumn` is one: every value arrives from the database or
 * a form as a string, so a brand would be cast on at the boundary.
 */
export type TimeZone = string;

/** The zone every "today" used before M10, and the one used until a user's is known. */
export const UTC: TimeZone = "UTC";

/**
 * What an IANA name looks like, strictly: an area and one or more parts, or
 * exactly `UTC`. The database's CHECK on `profiles.time_zone` is the same
 * expression (migration 0010). It refuses offsets (`+05:30` has no DST, so it
 * is not a zone), POSIX rules (`EST5EDT`) and tzdata's housekeeping entries.
 */
const ZONE_SHAPE = /^(UTC|[A-Z][A-Za-z_-]*(\/[A-Za-z0-9_+-]+)+)$/;

/** The same, before `Intl` has fixed the case: `asia/kolkata` is a zone too. */
const LOOSE_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * CLDR's canonical names that are not IANA's.
 *
 * `Intl` canonicalises a zone to the name CLDR prefers, and for these eighteen
 * that is the *old* IANA name — Node 22 answers `"Asia/Calcutta"` for
 * `"Asia/Kolkata"` — while Postgres's catalogue on a current tzdata (Ubuntu
 * 24.04's, which the harness runs on) only knows the new one, so
 * `set_time_zone` would refuse what `Intl` just produced. Every name here is
 * accepted by `Intl` in both spellings, so mapping to the current IANA name
 * loses nothing on the formatting side. The list is exactly the entries of
 * Node 22's `Intl.supportedValuesOf("timeZone")` that were missing from
 * `pg_timezone_names` on the harness (M10); a zone this misses is refused by
 * the database with a sentence, not stored wrongly.
 */
const IANA_NAME: Readonly<Record<string, TimeZone>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** `Intl`'s names for UTC itself, all stored as `UTC`. */
const UTC_ALIASES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/UCT", "Etc/Universal", "Etc/Zulu"]);

/**
 * A zone name from outside — a form, a browser's
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, a database row — as the
 * one spelling this application stores and formats with, or `null` when it is
 * not a zone at all.
 *
 * Valid means `Intl` can format with it (so both the server and the browser
 * can) *and* it has the IANA shape. The database checks the third thing, that
 * its own tz catalogue knows the name, in `set_time_zone`.
 */
export function canonicalTimeZone(value: unknown): TimeZone | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 64 || !LOOSE_ZONE_SHAPE.test(trimmed)) {
    return null;
  }
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
  if (UTC_ALIASES.has(resolved)) return UTC;
  const name = IANA_NAME[resolved] ?? resolved;
  return ZONE_SHAPE.test(name) ? name : null;
}

/** True when `value` is already the stored spelling of a zone. */
export function isTimeZone(value: unknown): value is TimeZone {
  return typeof value === "string" && canonicalTimeZone(value) === value;
}

/** A wall clock reading: what a clock on the wall in `zone` shows at an instant. */
interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const wallFormatters = new Map<TimeZone, Intl.DateTimeFormat>();

/**
 * One formatter per zone, cached for the life of the process: constructing an
 * `Intl.DateTimeFormat` is the expensive part, and a server serves one user's
 * zone over and over.
 *
 * `en-US` with the Gregorian calendar and Latin digits, because the parts are
 * read as numbers, not shown; `hourCycle: "h23"` because some ICU versions
 * print midnight as hour 24 under `hour12: false`.
 */
function wallFormatter(zone: TimeZone): Intl.DateTimeFormat {
  const existing = wallFormatters.get(zone);
  if (existing) return existing;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  wallFormatters.set(zone, made);
  return made;
}

function wallClock(ms: number, zone: TimeZone): WallClock {
  const parts: Record<string, number> = {};
  for (const part of wallFormatter(zone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/**
 * How far `zone`'s clocks are ahead of UTC at the instant `ms`, in ms.
 * Negative west of Greenwich. Seconds are floored away on both sides, so a
 * zone with a seconds offset (none since 1972) cannot produce a fraction.
 */
function offsetAt(ms: number, zone: TimeZone): number {
  const wall = wallClock(ms, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Which calendar day `ms` falls on in `zone`.
 *
 * The clock is a parameter, never read here: a module that called `Date.now()`
 * itself could not be unit-tested around midnight, and a component that called
 * it during render would produce a different answer on each side of hydration.
 * The zone is a parameter for the same reason — the server reads the clock and
 * the user's zone once per request and passes both down, which is the same
 * discipline `app/c/[slug]/board/page.tsx` applies to "days in stage".
 *
 * `zone` must be a zone `canonicalTimeZone` accepted; anything else throws
 * `RangeError` from `Intl`, loudly, rather than quietly answering in UTC.
 */
export function todayColumn(ms: number, zone: TimeZone): DateColumn {
  const wall = wallClock(ms, zone);
  return toDateColumn({ year: wall.year, month: wall.month, day: wall.day });
}

/**
 * The first instant of a calendar day in `zone`, as epoch milliseconds —
 * normally local midnight.
 *
 * This is how a zoneless `date` becomes an instant when one is needed:
 * `confirmLive` stamps `published_at` with the start of the target date, and
 * "24 hours after publish" is then measured from the user's midnight rather
 * than from UTC's.
 *
 * DST-safe. The offset is looked up twice, because the offset *at* UTC
 * midnight can differ from the offset at local midnight; and where the clocks
 * jump forward *at* midnight (so 00:00 does not exist that day) the day starts
 * at the jump, which is the earliest instant whose local date is `value`.
 */
export function startOfDay(value: DateColumn, zone: TimeZone): number | null {
  const utcMidnight = stampOf(value);
  if (utcMidnight === null) return null;
  const first = utcMidnight - offsetAt(utcMidnight, zone);
  const second = utcMidnight - offsetAt(first, zone);
  const candidates = [...new Set([first, second])].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (todayColumn(candidate, zone) === value) return candidate;
  }
  // Neither guess lands on the day: only possible across a transition larger
  // than a day (Samoa skipped 30 December 2011). The later guess is the
  // closest instant that exists.
  return candidates[candidates.length - 1];
}

/**
 * `GMT+13`, `GMT-7`, `GMT+5:30`, `GMT` — how far ahead of UTC `zone` is at
 * `ms`, in the short form a select option can carry. Taken from `offsetAt`
 * rather than from `Intl`'s `shortOffset`, whose output differs between ICU
 * versions (and therefore between Node and a browser).
 */
export function offsetLabel(zone: TimeZone, ms: number): string {
  const minutes = Math.round(offsetAt(ms, zone) / 60_000);
  if (minutes === 0) return "GMT";
  const sign = minutes > 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `GMT${sign}${hours}${rest === 0 ? "" : `:${pad(rest, 2)}`}`;
}

/** One `<optgroup>` of the zone picker. */
export interface TimeZoneGroup {
  readonly label: string;
  readonly zones: readonly { readonly value: TimeZone; readonly label: string }[];
}

/**
 * Every zone this runtime can format with, as the Settings picker groups
 * them: UTC first, then by area (Africa, America, …), each named by its city
 * with its current offset — `Los Angeles (GMT-7)`.
 *
 * Built on the **server** and handed to the picker as data, because
 * `Intl.supportedValuesOf` is a property of the runtime: Node and a browser
 * list different names, and a list built during a client render would not
 * hydrate. `ms` is the request's clock, because an offset depends on the date.
 */
export function timeZoneGroups(ms: number): TimeZoneGroup[] {
  const names = new Set<TimeZone>();
  for (const raw of Intl.supportedValuesOf("timeZone")) {
    const zone = canonicalTimeZone(raw);
    if (zone !== null && zone !== UTC) names.add(zone);
  }

  const groups = new Map<string, { value: TimeZone; label: string }[]>();
  for (const zone of [...names].sort()) {
    const [area, ...rest] = zone.split("/");
    const city = rest[rest.length - 1].replace(/_/g, " ");
    const region = rest.length > 1 ? ` (${rest.slice(0, -1).join(", ").replace(/_/g, " ")})` : "";
    const list = groups.get(area) ?? [];
    list.push({ value: zone, label: `${city}${region} (${offsetLabel(zone, ms)})` });
    groups.set(area, list);
  }

  return [
    { label: "Universal", zones: [{ value: UTC, label: "UTC (GMT)" }] },
    ...[...groups.entries()].map(([label, zones]) => ({ label, zones })),
  ];
}

/** `America/Los_Angeles` → `Los Angeles`, for a sentence that names a zone. */
export function timeZoneCity(zone: TimeZone): string {
  if (zone === UTC) return "UTC";
  const parts = zone.split("/");
  return parts[parts.length - 1].replace(/_/g, " ");
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

/**
 * The calendar month `ms` falls in, in `zone`, as the two instants that bound
 * it: `[from, to)`, epoch milliseconds — from the first instant of its first
 * day to the first instant of the next month's.
 *
 * This is "this month" for anything measured in instants rather than dates
 * (M11: the brainstorm's month-to-date spend, whose rows are stamped with
 * `now()`). It is `todayColumn` for the month, `startOfDay` for each end, so a
 * month turns over at the user's midnight on the 1st exactly when their
 * calendar does — in Kiritimati that is 10:00 UTC on the last day of the
 * previous month, in Pago Pago 11:00 UTC on the 1st.
 */
export function monthInstants(
  ms: number,
  zone: TimeZone,
): { readonly month: CalendarMonth; readonly from: number; readonly to: number } {
  // `todayColumn` always produces a day `monthOf` accepts; the fallback is
  // the type system's, not a case that happens.
  const month = monthOf(todayColumn(ms, zone)) ?? { year: 1970, month: 1 };
  const from = startOfDay(firstOfMonth(month), zone) ?? ms;
  const to = startOfDay(firstOfMonth(shiftMonth(month, 1)), zone) ?? ms;
  return { month, from, to };
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
 * `en-GB` and `timeZone: "UTC"`, fixed: these format *date columns*, which
 * have no zone, so UTC here is the neutral representation the arithmetic above
 * uses and not a claim about where anybody is. The server and the browser must
 * produce byte-identical text or hydration reports it, and the machine's locale
 * is not something either end agrees about. Instants — which do depend on the
 * user's zone — go through `formatInstant` below.
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
 * The ways an *instant* is shown to the user: `3 Mar 2026`,
 * `3 Mar 2026, 14:05` (24-hour, the swap log's form) and `14:05`.
 */
export type InstantStyle = "date" | "dateTime" | "time";

const INSTANT_FORMATS: Record<InstantStyle, Intl.DateTimeFormatOptions> = {
  date: { day: "numeric", month: "short", year: "numeric" },
  dateTime: {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};

const instantFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A timestamp (`published_at`, a swap, a capture, a skip) as the user reads
 * it: in **their** zone, in `en-GB`.
 *
 * Unlike `formatDateColumn`, which formats a zoneless day and so uses UTC as
 * a neutral representation, this formats an instant, and which day an instant
 * falls on depends on where you are — a video published at 01:00 UTC on the
 * 4th went out on the 3rd in Los Angeles. The zone is the server's value
 * handed down (`useTimeZone()` on the client), never the machine's, so the
 * server's render and the browser's hydration produce the same string.
 *
 * `null` for anything that is not a timestamp, so a caller renders nothing
 * (or its own fallback) rather than "Invalid Date".
 */
export function formatInstant(
  value: string | number | null | undefined,
  zone: TimeZone,
  style: InstantStyle = "date",
): string | null {
  if (value === null || value === undefined) return null;
  const stamp = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(stamp)) return null;
  const key = `${style}|${zone}`;
  let formatter = instantFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { ...INSTANT_FORMATS[style], timeZone: zone });
    instantFormatters.set(key, formatter);
  }
  return formatter.format(stamp);
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
