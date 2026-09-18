import { quotaPercent, type BucketTally } from "./tally";

/**
 * A bucket's monthly quota, and how much of this month is already committed to
 * it.
 *
 * ## The count is PLAN.md's, exactly
 *
 * *"videos with `target_publish_date` in the current month per bucket"*. Not
 * videos published this month, not videos captured this month, not the size of
 * the bucket. A quota is a plan — "2 book reviews in September" — and the only
 * thing in this database that records a plan for a particular month is the
 * target date. `buildTally` is where that sentence is implemented; this file
 * only draws the answer.
 *
 * ## A bucket with no quota gets no bar
 *
 * This is the rule the component exists to keep. A progress bar needs a
 * denominator, and the honest denominator for a bucket with `monthly_quota
 * null` does not exist — so there is no track, no fill and no percentage.
 * `<BucketCount>` is what such a bucket gets instead: how many videos carry it,
 * as a number. Drawing "3" against an invented target of 5 would be the tool
 * telling the user they are behind on a plan they never made.
 */
export function QuotaMeter({
  tally,
  monthLabel,
}: {
  tally: BucketTally;
  /** "September 2026" — the units the two numbers are in. */
  monthLabel: string;
}) {
  const quota = tally.bucket.monthlyQuota;
  if (quota === null) return null;

  const met = tally.thisMonth >= quota;
  const percent = quotaPercent(tally.thisMonth, quota);

  return (
    <div
      data-testid="quota-meter"
      data-bucket={tally.bucket.name}
      data-count={tally.thisMonth}
      data-quota={quota}
      data-met={met ? "true" : "false"}
      className="flex flex-col gap-1"
    >
      <p className="flex items-baseline gap-1 text-[11px] text-muted">
        <span className="font-mono">
          {tally.thisMonth} of {quota}
        </span>
        {/* "Met" is a word before it is a colour, which is the rule: the hue is
            a second copy of a signal that is already readable. */}
        {met ? <span className="text-ready">met</span> : null}
      </p>

      {/* `aria-hidden`: the numbers above already say this, and a second
          announcement of the same fact is noise on a screen reader. The
          sentence that gives them their units is below. */}
      <div
        aria-hidden="true"
        className="h-[3px] w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className={met ? "h-full rounded-full bg-ready" : "h-full rounded-full bg-muted"}
          style={{ width: `${percent}%` }}
        />
      </div>

      <span className="sr-only">
        {tally.thisMonth} of a monthly quota of {quota} targeted at {monthLabel}
        {met ? "; met" : ""}.
      </span>
    </div>
  );
}

/**
 * How many videos carry this bucket at all — the over-investment number.
 *
 * Deliberately **not** the sum of the row's cells: a video with a pillar and no
 * format is still an investment in that pillar. The grid says underneath it how
 * many videos are off the grid for exactly that reason, so the two numbers
 * never have to be reconciled by guesswork.
 */
export function BucketCount({ total }: { total: number }) {
  return (
    <p className="text-[11px] text-muted">
      <span className="font-mono" data-testid="bucket-total">
        {total}
      </span>{" "}
      {total === 1 ? "video" : "videos"}
    </p>
  );
}
