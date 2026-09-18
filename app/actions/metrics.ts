"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { Database } from "@/lib/database.types";
import {
  LogMetricsSchema,
  metricsRefusal,
  type LogMetricsInput,
} from "@/lib/metrics";
import { CHANGED_ELSEWHERE, YoutubeUrlSchema } from "@/lib/video-fields";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * The post-publish writes: the first-24-hours numbers, the decision that
 * follows them, and the moment a scheduled video becomes a live one.
 *
 * ## One write path, and why that is the whole point of this file
 *
 * M3 built a narrow version of this so `/now`'s rules 2 and 3 could be
 * *completable in place*: a row whose only affordance is a link to a page that
 * does not exist yet is not a row, it is a reminder. M4 builds the page. The
 * failure mode at that seam is two actions — one for the list, one for the page
 * — that agree today and drift by the end of the month: different rounding,
 * different idea of what "empty" means, one of them forgetting to stamp
 * `metrics_logged_at`, and a video that reads differently depending on which
 * screen you look at it from.
 *
 * So there is exactly one `logMetrics`, parsing exactly one schema
 * (`lib/metrics.ts`), called by `components/now/now-view.tsx` and by
 * `components/post-publish/**`. The same is true of `dismissSwap` ("keep it")
 * and of `confirmLive`, which both surfaces also offer.
 *
 * ## What this file deliberately does not do
 *
 * It does not swap a thumbnail. `swap_thumbnail(p_video, p_to_role, p_reason)`
 * writes the append-only log row and the new `shipped_role` in one transaction,
 * `UPDATE (shipped_role)` is revoked from clients, and the swap needs a role
 * that has an asset — so that action lives with the assets, in
 * `app/actions/thumbnails.ts`. The prompt here is the decision; the swap is the
 * act.
 *
 * It also does not re-implement the CHECKs. `videos_ctr_needs_impressions` is
 * the guard on the pair; the schema exists so the refusal is a sentence in the
 * browser rather than a constraint name after a round trip, and
 * `metricsRefusal()` is what turns the constraint into a sentence when one
 * fires anyway.
 */

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything a caller needs to redraw the block without a reload. */
export interface MetricsState {
  readonly videoId: string;
  readonly impressions: number | null;
  readonly ctr: number | null;
  readonly views: number | null;
  readonly newViewersNote: string | null;
  /** ISO. `/now` rule 2 stops firing, and rule 3 starts, the moment this is set. */
  readonly metricsLoggedAt: string | null;
  readonly swapDismissedAt: string | null;
  /**
   * The row's new version stamp.
   *
   * The video page holds one token for the whole row and hands it back as the
   * precondition on its next write (`components/video-version.tsx`). A write
   * from this file that did not report its stamp would leave the page's token
   * one version stale, and the *next* packaging save would be refused as a
   * conflict that never happened.
   */
  readonly updatedAt: string | null;
}

export type MetricsResult =
  | { ok: true; state: MetricsState }
  | {
      ok: false;
      error: string;
      /** The row moved under us; re-sending would overwrite newer values. */
      conflict?: boolean;
    };

export type ConfirmLiveResult =
  | {
      ok: true;
      videoId: string;
      youtubeUrl: string | null;
      /** The Published stage the video ended up in. */
      stageId: string;
      stageName: string;
      stageEnteredAt: string;
      /** What `move_video` stamped — the target date, or now. */
      publishedAt: string | null;
      updatedAt: string | null;
    }
  | { ok: false; error: string; conflict?: boolean };

/** The columns every post-publish write reads back. */
const METRICS_COLUMNS =
  "id, channel_id, updated_at, first24_impressions, first24_ctr, first24_views, new_viewers_note, metrics_logged_at, swap_dismissed_at";

interface MetricsRow {
  id: string;
  channel_id: string;
  updated_at: string | null;
  first24_impressions: number | null;
  first24_ctr: number | null;
  first24_views: number | null;
  new_viewers_note: string | null;
  metrics_logged_at: string | null;
  swap_dismissed_at: string | null;
}

/**
 * The row as both surfaces read it.
 *
 * `first24_ctr` is `numeric(5,2)`, which PostgREST hands back as a string on
 * some paths and a number on others; `Number()` here is the one place that
 * decides, so a component never compares a string to an expectation.
 */
function stateOf(row: MetricsRow): MetricsState {
  return {
    videoId: row.id,
    impressions: row.first24_impressions,
    ctr: row.first24_ctr === null ? null : Number(row.first24_ctr),
    views: row.first24_views,
    newViewersNote: row.new_viewers_note,
    metricsLoggedAt: row.metrics_logged_at,
    swapDismissedAt: row.swap_dismissed_at,
    updatedAt: row.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

type Client = Awaited<ReturnType<typeof requireUser>>["supabase"];

/**
 * Both pages that render these numbers, plus the board.
 *
 * `/now` keeps its own copy of the rows so a completed row costs no reload, but
 * the server's copy has to be honest for the next navigation and for the other
 * tab. The slug is looked up rather than passed in, so a caller cannot aim a
 * revalidation at a path it does not own.
 */
async function revalidateForVideo(
  supabase: Client,
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

/**
 * Apply one patch to `videos` and read the post-publish columns back.
 *
 * The precondition and the two-nothings answer are `updateVideo`'s, for the
 * same reasons and with the same wording: "zero rows" with a precondition
 * usually means the row is still there and has moved on, and telling someone
 * their video no longer exists while it is on the screen in front of them is
 * the worst available answer.
 */
async function writeVideo(
  supabase: Client,
  videoId: string,
  patch: Database["public"]["Tables"]["videos"]["Update"],
  expectedUpdatedAt: string | null | undefined,
  /**
   * How a refusal from the database reads. The default is
   * `metricsRefusal`, which names the paired CHECK — right for the numbers,
   * wrong for the URL write inside `confirmLive`, which passes its own.
   */
  refusal: (message: string) => string = metricsRefusal,
): Promise<MetricsResult> {
  let write = supabase.from("videos").update(patch).eq("id", videoId);
  if (expectedUpdatedAt !== undefined) {
    write =
      expectedUpdatedAt === null
        ? write.is("updated_at", null)
        : write.eq("updated_at", expectedUpdatedAt);
  }

  const { data, error } = await write
    .select(METRICS_COLUMNS)
    .maybeSingle<MetricsRow>();

  if (error) return { ok: false, error: refusal(error.message) };

  if (!data) {
    if (expectedUpdatedAt !== undefined) {
      const { data: still } = await supabase
        .from("videos")
        .select("id")
        .eq("id", videoId)
        .maybeSingle();
      if (still) return { ok: false, error: CHANGED_ELSEWHERE, conflict: true };
    }
    return { ok: false, error: "That video does not exist any more." };
  }

  await revalidateForVideo(supabase, data.id, data.channel_id);
  return { ok: true, state: stateOf(data) };
}

/* -------------------------------------------------------------------------- */
/* The first 24 hours                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Write the first-24-hours numbers. The one action that does.
 *
 * `metrics_logged_at` is stamped in the same write, because it is the thing
 * rule 2 reads to stop asking and rule 3 reads to start. Writing the numbers
 * and the stamp separately would leave a window in which the video has metrics
 * and is still Overdue for them.
 *
 * `views` and `newViewersNote` are written only when the caller sends the key
 * at all: `/now`'s row asks for the pair and offers views, and does not have
 * room for a sentence about new viewers — so it leaves that column alone rather
 * than clearing a note the page wrote.
 */
export async function logMetrics(input: LogMetricsInput): Promise<MetricsResult> {
  const parsed = LogMetricsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, impressions, ctr, views, newViewersNote, expectedUpdatedAt } =
    parsed.data;

  const { supabase } = await requireUser();

  const loggedAt = new Date().toISOString();

  // RLS is the ownership check: another user's id updates zero rows and the
  // select on the way back returns nothing, which is what "no such video" looks
  // like from here.
  return writeVideo(
    supabase,
    videoId,
    {
      first24_impressions: impressions,
      first24_ctr: ctr,
      ...(views === undefined ? {} : { first24_views: views }),
      ...(newViewersNote === undefined
        ? {}
        : { new_viewers_note: newViewersNote }),
      metrics_logged_at: loggedAt,
      updated_at: loggedAt,
    },
    expectedUpdatedAt,
  );
}

/**
 * "Keep it" — the other half of the swap prompt.
 *
 * PLAN.md rule 3: *`swap_dismissed_at` null … ("keep it" sets
 * `swap_dismissed_at`)*. It is a judgement, not the dismissal of a
 * notification: the creator looked at the number, decided the thumbnail is not
 * the problem, and the prompt stops asking.
 *
 * What it does **not** do is hide the block. The Publish section keeps
 * rendering the prompt afterwards, saying when the decision was made and
 * offering to reopen it — a decision that vanishes without trace is one nobody
 * can change their mind about, and "act fast" (BRIEF.md principle 8) cuts both
 * ways.
 */
export async function dismissSwap(input: {
  videoId: string;
  expectedUpdatedAt?: string | null;
}): Promise<MetricsResult> {
  const parsed = z
    .object({
      videoId: z.uuid(),
      expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a video this page could ask about." };
  }

  const { supabase } = await requireUser();

  const dismissedAt = new Date().toISOString();

  return writeVideo(
    supabase,
    parsed.data.videoId,
    { swap_dismissed_at: dismissedAt, updated_at: dismissedAt },
    parsed.data.expectedUpdatedAt,
  );
}

/**
 * Changed your mind: the prompt is a live question again.
 *
 * The column is nullable and nothing else reads it, so undoing is one write.
 * It exists because "Keep it" is one click from a list, and a decision that
 * cannot be taken back is a decision people hesitate over.
 */
export async function reopenSwap(input: {
  videoId: string;
  expectedUpdatedAt?: string | null;
}): Promise<MetricsResult> {
  const parsed = z
    .object({
      videoId: z.uuid(),
      expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a video this page could ask about." };
  }

  const { supabase } = await requireUser();

  return writeVideo(
    supabase,
    parsed.data.videoId,
    { swap_dismissed_at: null, updated_at: new Date().toISOString() },
    parsed.data.expectedUpdatedAt,
  );
}

/* -------------------------------------------------------------------------- */
/* Confirm live                                                                */
/* -------------------------------------------------------------------------- */

const ConfirmLiveInput = z.object({
  videoId: z.uuid(),
  /**
   * The URL, validated as a URL — `YoutubeUrlSchema` from
   * `lib/video-fields.ts`, the same rule the Schedule section's field uses, so
   * a link that is acceptable there is acceptable here.
   *
   * The host is deliberately not checked against a list of YouTube domains:
   * `youtu.be`, a Studio link and a members-only link are all things a creator
   * legitimately pastes. What is refused is the thing that is not a link.
   */
  url: YoutubeUrlSchema,
  expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
});

export type ConfirmLiveInput = z.input<typeof ConfirmLiveInput>;

/**
 * "It is live" — record the URL and move the video into Published.
 *
 * PLAN.md ranking rule 5: *`confirmLive` = `move_video(published,
 * p_published_at = target date)` + URL*. Three details it is worth being exact
 * about, because both surfaces depend on them:
 *
 * 1. **The Published stage is resolved here**, from the video's own channel,
 *    rather than passed in. A caller that named a stage could name one in
 *    another channel or a disabled one — `move_video` would refuse both, but
 *    the refusal would read like a bug, and `/now` and the page would each need
 *    their own copy of "which stage is Published".
 * 2. **`published_at` is the target date**, not the moment somebody got round
 *    to ticking the row. The video went live when YouTube said it would, and
 *    `published_at + 24h` is what the metrics prompt counts from — so getting
 *    this wrong makes the whole post-publish loop a day late. `move_video`
 *    reads the argument only on *first* entry to a Published stage, so it can
 *    never rewrite a date that is already recorded.
 * 3. **The URL is written first.** If the move then fails, the link is still
 *    recorded and the offer simply stays on screen. The other order would move
 *    the video and lose what was typed.
 */
export async function confirmLive(
  input: ConfirmLiveInput,
): Promise<ConfirmLiveResult> {
  const parsed = ConfirmLiveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, url, expectedUpdatedAt } = parsed.data;

  if (url === null) {
    return {
      ok: false,
      error: "Paste the video's address first — that is what confirming records.",
    };
  }

  const { supabase } = await requireUser();

  const { data: video, error: readError } = await supabase
    .from("videos")
    .select("id, channel_id, target_publish_date, published_at")
    .eq("id", videoId)
    .maybeSingle();

  if (readError) {
    return { ok: false, error: `Could not read that video: ${readError.message}` };
  }
  if (!video) return { ok: false, error: "That video does not exist any more." };

  const { data: published } = await supabase
    .from("stages")
    .select("id, name")
    .eq("channel_id", video.channel_id)
    .eq("kind", "published")
    .eq("is_enabled", true)
    .maybeSingle();

  if (!published) {
    return {
      ok: false,
      error:
        "This channel has no Published stage switched on, so there is nowhere to confirm it into.",
    };
  }

  const saved = await writeVideo(
    supabase,
    videoId,
    { youtube_url: url, updated_at: new Date().toISOString() },
    expectedUpdatedAt,
    (message) => `The link did not save, so nothing was moved: ${message}`,
  );
  if (!saved.ok) return { ok: false, error: saved.error, conflict: saved.conflict };

  const { data: moved, error: moveError } = await supabase.rpc("move_video", {
    p_video: videoId,
    p_stage: published.id,
    // A `date` with no time and no zone becomes midnight UTC. One user, one
    // zone; `lib/next-action.ts` makes the same conversion for the same reason.
    ...(video.target_publish_date === null
      ? {}
      : { p_published_at: `${video.target_publish_date}T00:00:00.000Z` }),
  });

  if (moveError) {
    return {
      ok: false,
      // The URL landed; only the move did not. Said plainly, because the next
      // thing the user does depends on which half failed.
      error: `The URL is saved, but the move was refused: ${moveError.message}`,
    };
  }
  if (!moved) {
    return { ok: false, error: "The move returned nothing. Reload the page." };
  }

  await revalidateForVideo(supabase, videoId, video.channel_id);

  return {
    ok: true,
    videoId,
    youtubeUrl: url,
    stageId: moved.stage_id,
    stageName: published.name,
    stageEnteredAt: moved.stage_entered_at,
    publishedAt: moved.published_at,
    updatedAt: moved.updated_at,
  };
}
