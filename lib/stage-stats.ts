/**
 * The weekly-review strip's arithmetic.
 *
 * BRIEF.md principle 5 — *where are videos piling up?* — and PLAN.md's board
 * section: *per column count, oldest card's days in stage, median days in
 * stage — all from `stage_entered_at`*.
 *
 * Three numbers and no fourth. PLAN.md's review log records that `stage_events`
 * and historical averages were dropped (item 27): time in the *current* stage
 * is the whole of the signal, and a table of transitions would be a second
 * source of truth for it. So this file reads the one column the board already
 * has on every card.
 *
 * Pure, and `now` is an argument, for the reason every derived number in this
 * codebase takes one: the board is rendered on the server and hydrated in the
 * browser a moment later, and a component that reads the clock while rendering
 * disagrees with itself across that gap.
 */

const DAY_MS = 86_400_000;

export interface StageStats {
  /** Every card in the column, including any the column does not render. */
  readonly count: number;
  /** Days in stage of the oldest card, floored. Null for an empty column. */
  readonly oldestDays: number | null;
  /** Median days in stage, floored *after* the median is taken. Null when empty. */
  readonly medianDays: number | null;
}

export const EMPTY_STAGE_STATS: StageStats = {
  count: 0,
  oldestDays: null,
  medianDays: null,
};

/**
 * The three numbers for one column.
 *
 * `enteredAt` is a list of ISO stamps — `stage_entered_at`, one per card.
 * Unparseable stamps count towards the total (the card is really there) and
 * contribute an age of zero, which is the same lenient reading the board's own
 * `daysInStage` uses.
 *
 * The median of an even-sized column is the mean of the two middle values,
 * floored at the end rather than at the start: two cards at 3 and 4 days are a
 * column with a median of 3, not 3.5, and flooring each age first would give
 * the same answer by accident and a different one elsewhere.
 */
export function stageStats(
  enteredAt: readonly string[],
  now: number,
): StageStats {
  if (enteredAt.length === 0) return EMPTY_STAGE_STATS;

  const ages = enteredAt
    .map((iso) => {
      const then = Date.parse(iso);
      return Number.isNaN(then) ? 0 : Math.max(0, now - then);
    })
    .sort((a, b) => a - b);

  const middle = ages.length >> 1;
  const medianMs =
    ages.length % 2 === 1 ? ages[middle] : (ages[middle - 1] + ages[middle]) / 2;

  return {
    count: ages.length,
    oldestDays: Math.floor(ages[ages.length - 1] / DAY_MS),
    medianDays: Math.floor(medianMs / DAY_MS),
  };
}
