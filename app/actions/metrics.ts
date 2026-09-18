"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * The post-publish numbers, and the decision that follows them.
 *
 * ## Why this exists in M3 at all
 *
 * The full post-publish block — three thumbnail slots, the shipped radio, the
 * swap dialog and its log — is M4. What is here is the narrow slice `/now`'s
 * ranking needs to be *completable in place*: PLAN.md's rules 2 and 3 put "Log
 * 24h impressions + CTR" and "Swap thumbnail? (X impr / Y% CTR)" at the top of
 * the Overdue section, and a row whose only affordance is a link to a page that
 * does not exist yet is not a row, it is a reminder. So: `logMetrics` writes
 * the pair, and `dismissSwap` is the "keep it" half of rule 3. The swap itself
 * — which needs a role that has an asset, and a reason, and an append-only log
 * row — is untouched and stays in M4, where the assets it refers to are built.
 *
 * ## The one rule this file really has
 *
 * **Impressions and CTR are one value.** BRIEF.md: *always display impressions
 * and CTR together, never CTR alone*; PLAN.md: *`logMetrics` rejects one
 * without the other*; `0001_init.sql`: `check ((first24_impressions is null) =
 * (first24_ctr is null))`. Three statements of the same rule, and this action is
 * where the first two meet: the schema below refuses a half-filled pair before
 * the round trip, and the CHECK is there to catch anything that finds another
 * way in. A CTR with no impressions is not a measurement — 12% of nine people
 * is not a signal — and the whole point of the post-publish loop is acting fast
 * on a number that means something.
 *
 * Views are genuinely optional and travel with the pair; the "new viewers" note
 * is M4's, on the detail page, where there is room to write a sentence.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/** Bigger than any channel this tool is for, and small enough to catch a paste. */
const MAX_IMPRESSIONS = 1_000_000_000;

const Impressions = z
  .number()
  .int("Impressions is a whole number.")
  .min(0, "Impressions cannot be negative.")
  .max(MAX_IMPRESSIONS, "That is not an impressions count.");

/**
 * `numeric(5,2)` between 0 and 100 — the column's own CHECK, in the browser.
 *
 * A CTR is typed as a percentage because that is how YouTube Studio shows it:
 * `4.8`, not `0.048`. Nothing here multiplies or divides, so the two can never
 * drift apart.
 */
const Ctr = z
  .number()
  .min(0, "CTR is a percentage between 0 and 100.")
  .max(100, "CTR is a percentage between 0 and 100 — Studio shows 4.8, not 0.048.")
  // Two decimals is what the column stores; rounding here rather than letting
  // Postgres do it means what comes back is what was sent.
  .transform((value) => Math.round(value * 100) / 100);

const LogMetricsInput = z.object({
  videoId: z.uuid(),
  impressions: Impressions,
  ctr: Ctr,
  /** Optional, and the only part of the triplet that is. */
  views: Impressions.nullable().optional(),
});

export type LogMetricsInput = z.input<typeof LogMetricsInput>;

export type MetricsResult =
  | {
      ok: true;
      videoId: string;
      impressions: number;
      ctr: number;
      views: number | null;
      /** ISO. Rule 2 stops firing the moment this is set. */
      metricsLoggedAt: string;
    }
  | { ok: false; error: string };

export type DismissSwapResult =
  | { ok: true; videoId: string; swapDismissedAt: string }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Both pages that render these numbers, plus the board.
 *
 * `/now` keeps its own copy of the rows so a completed row costs no reload, but
 * the server's copy has to be honest for the next navigation and for the other
 * tab. The slug is looked up rather than passed in, so a caller cannot aim a
 * revalidation at a path it does not own.
 */
async function revalidateForVideo(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  videoId: string,
  channelId: string,
): Promise<void> {
  revalidatePath("/now");
  revalidatePath(`/videos/${videoId}`);

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", channelId)
    .maybeSingle();

  if (channel) revalidatePath(`/c/${channel.slug}/board`);
}

/* -------------------------------------------------------------------------- */
/* The actions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Write the first-24-hours pair.
 *
 * `metrics_logged_at` is stamped in the same write, because it is the thing
 * rule 2 reads to stop asking and rule 3 reads to start. Writing the numbers
 * and the stamp separately would leave a window in which the video has metrics
 * and is still Overdue for them.
 */
export async function logMetrics(
  input: LogMetricsInput,
): Promise<MetricsResult> {
  const parsed = LogMetricsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, impressions, ctr, views } = parsed.data;

  const { supabase } = await requireUser();

  const loggedAt = new Date().toISOString();

  // RLS is the ownership check: another user's id updates zero rows and the
  // select on the way back returns nothing, which is what "no such video" looks
  // like from here.
  const { data, error } = await supabase
    .from("videos")
    .update({
      first24_impressions: impressions,
      first24_ctr: ctr,
      ...(views === undefined ? {} : { first24_views: views }),
      metrics_logged_at: loggedAt,
      updated_at: loggedAt,
    })
    .eq("id", videoId)
    .select("id, channel_id, first24_impressions, first24_ctr, first24_views, metrics_logged_at")
    .maybeSingle();

  if (error) {
    // The paired CHECK is the one that can realistically fire, and it is worth
    // seeing verbatim: it means something got past the schema above.
    return { ok: false, error: `Those numbers did not save: ${error.message}` };
  }
  if (!data) return { ok: false, error: "That video does not exist any more." };

  await revalidateForVideo(supabase, videoId, data.channel_id);

  return {
    ok: true,
    videoId: data.id,
    impressions: data.first24_impressions ?? impressions,
    ctr: data.first24_ctr ?? ctr,
    views: data.first24_views,
    metricsLoggedAt: data.metrics_logged_at ?? loggedAt,
  };
}

/**
 * "Keep it" — the other half of the swap prompt.
 *
 * PLAN.md rule 3: *`swap_dismissed_at` null … ("keep it" sets
 * `swap_dismissed_at`)*. It is a judgement, not a dismissal of a notification:
 * the creator looked at the number, decided the thumbnail is not the problem,
 * and the prompt stops for this video. The always-on "Swap thumbnail?" block on
 * the detail page (M4) still renders afterwards — being dismissed from `/now`
 * is not the same as being hidden.
 */
export async function dismissSwap(input: {
  videoId: string;
}): Promise<DismissSwapResult> {
  const parsed = z.object({ videoId: z.uuid() }).safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a video this page could ask about." };
  }

  const { supabase } = await requireUser();

  const dismissedAt = new Date().toISOString();

  const { data, error } = await supabase
    .from("videos")
    .update({ swap_dismissed_at: dismissedAt, updated_at: dismissedAt })
    .eq("id", parsed.data.videoId)
    .select("id, channel_id, swap_dismissed_at")
    .maybeSingle();

  if (error) {
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) return { ok: false, error: "That video does not exist any more." };

  await revalidateForVideo(supabase, data.id, data.channel_id);

  return {
    ok: true,
    videoId: data.id,
    swapDismissedAt: data.swap_dismissed_at ?? dismissedAt,
  };
}
