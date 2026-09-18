import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { NO_EXPECTATION, type Expectation } from "@/lib/metrics";
import { channelExpectation, EXPECTATION_SAMPLE } from "@/lib/next-action";

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
/** Fewer logged videos than this and the median is not an expectation. */
const MIN_MEDIAN_SAMPLE = 2;

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
    A median of one is that video compared with itself.

    The sample includes the video being judged (see above), so a channel whose
    first published video has just been logged would otherwise get an
    "expectation" equal to its own click-through — and a prompt reading "at or
    above the 4.2% median of its last 1 logged video", which is a sentence that
    means nothing. Below one real comparison there is no expectation, and the
    prompt says so rather than inventing one.

    This agrees with `/now` rather than diverging from it: with a one-video
    sample its rule 3 compares a number to itself, `ctr < expectation` is false,
    and the rule never fires. Silence there and "no verdict" here are the same
    claim.
  */
  if (sample.length < MIN_MEDIAN_SAMPLE) return NO_EXPECTATION;

  const value = channelExpectation(null, sample);
  if (value === null) return NO_EXPECTATION;

  return { value, source: "median", sampleSize: sample.length };
}
