import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { NO_EXPECTATION, type Expectation } from "@/lib/metrics";
import {
  channelExpectation,
  EXPECTATION_SAMPLE,
  MIN_MEDIAN_SAMPLE,
} from "@/lib/next-action";

/**
 * What this channel expects a first-24-hours click-through to be.
 *
 * PLAN.md, ranking rule 3: *`expectation = coalesce(channel.expected_ctr,
 * median first24_ctr of the channel's last 10 published)`; none → rule
 * skipped*.
 *
 * ## Why this is a module of its own
 *
 * Two surfaces ask the question. `/now` resolves it inside `lib/now-data.ts`,
 * from rows it has already read for the ranking; the video page's Publish
 * section asks about one channel and has read nothing. If each computed its own
 * answer, the `/now` row and the page's prompt could call the same video
 * underperforming and fine — which is exactly the sort of disagreement that
 * makes someone stop trusting both.
 *
 * So the *arithmetic* is `channelExpectation()` in `lib/next-action.ts`, pure
 * and unit-tested, and both callers go through it. This file is the query the
 * page needs, shaped so the two see the same sample:
 *
 * - **Non-archived only**, because `/now` never reads an archived video and so
 *   its median never includes one.
 * - **Published, with a logged CTR**, newest first, capped at
 *   `EXPECTATION_SAMPLE`.
 * - **Including the video being judged**, when it is one of the ten. That is
 *   what `lib/now-data.ts` does — it computes the fallback from the same rows
 *   the rules are about — and matching it is worth more than excluding a single
 *   sample would be. PLAN.md's wording is "the channel's last 10 published",
 *   with no carve-out.
 *
 * ## What it adds that the pure function does not
 *
 * Where the number came from. "Below the 4.2% you set for this channel" and
 * "below the 4.2% median of your last six" are different sentences, and the
 * second one is worth being honest about — a median over two videos is not an
 * expectation, it is a coincidence, and the prompt says so rather than dressing
 * it up.
 */

export async function readExpectation(
  supabase: SupabaseClient<Database>,
  channelId: string,
): Promise<Expectation> {
  const [{ data: channel }, { data: recent }] = await Promise.all([
    supabase
      .from("channels")
      .select("expected_ctr")
      .eq("id", channelId)
      .maybeSingle(),
    supabase
      .from("videos")
      .select("first24_ctr, published_at")
      .eq("channel_id", channelId)
      .is("archived_at", null)
      .not("first24_ctr", "is", null)
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(EXPECTATION_SAMPLE),
  ]);

  const configured =
    channel?.expected_ctr === null || channel?.expected_ctr === undefined
      ? null
      : Number(channel.expected_ctr);

  const sample = (recent ?? [])
    .map((row) => Number(row.first24_ctr))
    .filter((value) => Number.isFinite(value));

  if (configured !== null) {
    const value = channelExpectation(configured, sample);
    if (value === null) return NO_EXPECTATION;
    return { value, source: "channel", sampleSize: 0 };
  }

  /*
    Below `MIN_MEDIAN_SAMPLE` the median is not an expectation.

    The sample includes the video being judged (see above), and at n = 1 that is
    the video compared with itself. At n = 2 it is worse: the median of two
    numbers is their mean, so the worse of any two videos is *always* strictly
    below "expectation" and the better one is always at or above it, whatever
    the numbers are — a red prompt and an Overdue row manufactured out of one
    comparison. The floor lives in `lib/next-action.ts` and is imported here so
    the page and `/now` draw the line in one place: below it, this returns
    NO_EXPECTATION and `channelExpectation` returns null, so the prompt renders
    its honest "no verdict" state and rule 3 does not fire. Two ways of saying
    the same thing, which is the point.
  */
  if (sample.length < MIN_MEDIAN_SAMPLE) return NO_EXPECTATION;

  const value = channelExpectation(null, sample);
  if (value === null) return NO_EXPECTATION;

  return { value, source: "median", sampleSize: sample.length };
}
