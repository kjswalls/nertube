import { cookies } from "next/headers";
import { cache } from "react";

/**
 * The request's clock: `Date.now()`, read once per request.
 *
 * Every server component that asks "what time is it" — the shell's counts, the
 * page's today, the matrix's month — gets the same instant from one `cache()`d
 * read, so no two parts of one page can land on opposite sides of midnight.
 * It is the clock's twin of `readTimeZone()` (`lib/time-zone-data.ts`), and
 * the two together are what `todayColumn(now, zone)` is given.
 *
 * ## The test clock
 *
 * "Today" is decided on the server, so a browser test cannot move it with
 * Playwright's clock alone: the browser's `Date` is not the server's. When the
 * server is started with `NERTUBE_TEST_CLOCK=1` — which only
 * `playwright.config.ts` does — a request carrying the `nertube-test-clock`
 * cookie (epoch milliseconds) is served at that instant instead, which is how
 * `e2e/timezone.spec.ts` stands at 20:00 UTC on a Saturday, when Auckland and
 * Los Angeles disagree about the date, without waiting for one.
 *
 * Without the variable the cookie is never read. With it, the most a request
 * can do is show its own sender their own data as of another moment: nothing
 * is written with this clock (writes stamp time in the database, `now()`), and
 * sessions are checked against the real one.
 */
export const TEST_CLOCK_COOKIE = "nertube-test-clock";

export const readClock = cache(async (): Promise<number> => {
  if (process.env.NERTUBE_TEST_CLOCK === "1") {
    const value = (await cookies()).get(TEST_CLOCK_COOKIE)?.value;
    const ms = Number(value);
    if (value !== undefined && Number.isFinite(ms) && ms > 0) return ms;
  }
  return Date.now();
});
