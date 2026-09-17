/**
 * How long ago something was, in words.
 *
 * Used for `waiting_on` — PLAN.md's `/now` rule 4 is *"`waiting_on` set →
 * **Waiting**, with age"*. Pure, and it takes `now` as an argument rather than
 * reading the clock, for two reasons:
 *
 * - **Hydration.** The detail page renders on the server. A component that
 *   calls `Date.now()` while rendering produces one string there and a
 *   different one in the browser milliseconds later, which React reports as a
 *   mismatch. The page computes the label once, on the server, and passes the
 *   string down; the client only recomputes after an interaction it caused.
 * - **Testability.** "3 days" is a claim about arithmetic, and arithmetic
 *   against the wall clock cannot be asserted.
 *
 * The scale is deliberately coarse. This is a number that answers "has this
 * been stuck long enough that I should chase it", where the difference between
 * 61 and 89 minutes is noise and the difference between two hours and two weeks
 * is the whole signal.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `null` when `iso` is not a timestamp. A future stamp — a clock a few seconds
 * out between the browser and the database — reads as "less than an hour"
 * rather than as a negative age.
 */
export function formatAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const elapsed = Math.max(0, now - then);

  if (elapsed < HOUR) return "less than an hour";
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }

  const days = Math.floor(elapsed / DAY);
  return days === 1 ? "1 day" : `${days} days`;
}
