import {
  isDateColumn,
  monthKey,
  parseMonthKey,
  type DateColumn,
} from "@/lib/calendar-dates";

/**
 * The calendar's whole state, in the URL.
 *
 * Two parameters and nothing else: `?month=YYYY-MM` is which month is on
 * screen, `?day=YYYY-MM-DD` is the day whose full list is open underneath it.
 * Both are here rather than in component state because the requirement is that
 * a month can be *shared or bookmarked* — and because a server-rendered grid
 * with links for navigation needs no client JavaScript at all.
 */
export const CALENDAR_PATH = "/calendar";

export function calendarHref({
  month,
  day,
}: {
  month: string;
  day?: string | null;
}): string {
  const params = new URLSearchParams({ month });
  if (day) params.set("day", day);
  return `${CALENDAR_PATH}?${params.toString()}`;
}

/**
 * `?month=` → the month to draw, falling back to the month containing `today`.
 *
 * A typo in a pasted link lands on this month rather than on a 404: there is
 * nothing at `/calendar` that can be "not found", and a calendar is the most
 * link-pasted page in a product like this.
 */
export function monthFromQuery(value: string | undefined, today: DateColumn): string {
  const parsed = parseMonthKey(value);
  if (parsed !== null) return monthKey(parsed);
  // The fallback is the month of the page's one `today` — the clock turned into
  // a calendar day once, in the user's zone, by `todayColumn` (M10: it used to
  // take the clock and compute its own UTC day here). Slicing an ISO string
  // would be a second interpretation of "which month is it".
  const current = parseMonthKey(today);
  return current === null ? "1970-01" : monthKey(current);
}

/** `?day=` → the open day, or null. Not required to be inside the month. */
export function dayFromQuery(value: string | undefined): string | null {
  return isDateColumn(value) ? (value as string) : null;
}
