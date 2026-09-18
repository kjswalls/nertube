import { cache } from "react";

import { CHECKLIST_COLUMNS, readChecklistItem, type ChecklistItem } from "@/lib/checklist";
import { isStageKind } from "@/lib/defaults";
import {
  channelExpectation,
  EXPECTATION_SAMPLE,
  rankNow,
  type NowChannel,
  type NowStage,
  type NowVideo,
} from "@/lib/next-action";
import { readHooks } from "@/lib/packaging";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * Everything `/now` ranks, read once per request.
 *
 * ## Why this is not simply the body of `app/now/page.tsx`
 *
 * Because two things ask the same question and must not answer it differently.
 * The page draws the rows; the sidebar draws *how many rows there are*, on every
 * signed-in route. A count computed from its own cheaper query — "videos not
 * archived", say — would be a second definition of "something to do", and it
 * would be wrong in all the interesting ways: it would count ideas, which
 * `/now` deliberately never shows; it would count a video in a terminal stage
 * with nothing left to do; and it would not know that a Scheduled video with no
 * target date produces no row at all. The badge would say 14 and the page would
 * list 9, and the user would be right to stop believing either.
 *
 * So there is one reader and one ranking. The sidebar's number is
 * `rankNow(...).length` over exactly the rows the page renders.
 *
 * ## `cache()` is what makes that free
 *
 * React's `cache` memoises per *request*, not across requests, so on `/now` —
 * where the shell and the page both ask — the five queries run once and both
 * callers get the same object. On the board and the video page the cost is real
 * and it is these five reads, which is the honest price of a count that agrees
 * with the view it counts. PLAN.md sizes the account at one user and hundreds of
 * rows; the reads are flat and RLS-scoped, and `videos` is capped below.
 *
 * ## Five reads, no embeds
 *
 * `videos` has two foreign keys to `stages` (the tenant one and the channel
 * one), so a PostgREST embed would be ambiguous — the board hit this first.
 * Five flat selects with the joining done in memory is both easier to reason
 * about and, at this size, faster.
 */
export interface NowInputs {
  readonly channels: readonly NowChannel[];
  readonly videos: readonly NowVideo[];
}

export const readNowInputs = cache(async (): Promise<NowInputs> => {
  const { supabase } = await requireUser();

  const { data: channelRows, error: channelsError } = await supabase
    .from("channels")
    .select("id, name, slug, expected_ctr")
    .order("created_at", { ascending: true });

  if (channelsError) {
    throw new Error(`Could not load the channels: ${channelsError.message}`);
  }
  // No channels is not an error and not a redirect — that decision belongs to
  // whoever asked. `/now` sends them to `/c/new`; the sidebar just shows no
  // count.
  if (!channelRows || channelRows.length === 0) {
    return { channels: [], videos: [] };
  }

  const { data: stageRows, error: stagesError } = await supabase
    .from("stages")
    .select("id, channel_id, name, kind")
    .eq("is_enabled", true)
    .order("position", { ascending: true });

  if (stagesError) {
    throw new Error(`Could not load the stages: ${stagesError.message}`);
  }

  const { data: videoRows, error: videosError } = await supabase
    .from("videos")
    // One literal on one line: supabase-js types the result from the select
    // string, and a concatenation is no longer a literal type to read.
    // prettier-ignore
    .select("id, channel_id, title, stage_id, stage_entered_at, thumbnail_concept, hooks, packaging_skipped_at, waiting_on, waiting_since, target_publish_date, published_at, youtube_url, first24_impressions, first24_ctr, metrics_logged_at, swap_dismissed_at")
    .is("archived_at", null)
    .limit(2000);

  if (videosError) {
    throw new Error(`Could not load the videos: ${videosError.message}`);
  }

  const videoIds = (videoRows ?? []).map((video) => video.id);

  /*
    The checklist rows for every video at once, then grouped in memory.

    Only the items for a video's *current* stage are a next action — an item
    left behind in Scripting is history, not work — but filtering that in SQL
    would be a correlated condition per row. One `in` and a grouping pass is
    simpler and reads the same rows.
  */
  const itemsByVideoAndStage = new Map<string, ChecklistItem[]>();
  if (videoIds.length > 0) {
    const { data: itemRows, error: itemsError } = await supabase
      .from("checklist_items")
      .select(`${CHECKLIST_COLUMNS}, video_id, stage_id`)
      .in("video_id", videoIds);

    if (itemsError) {
      throw new Error(`Could not load the checklists: ${itemsError.message}`);
    }

    for (const row of itemRows ?? []) {
      const key = `${row.video_id}:${row.stage_id}`;
      const list = itemsByVideoAndStage.get(key);
      if (list) list.push(readChecklistItem(row));
      else itemsByVideoAndStage.set(key, [readChecklistItem(row)]);
    }
  }

  /*
    The most recent swap per video — rule 3's "no swap after
    `metrics_logged_at`". `thumbnail_swaps` is append-only and tiny (it grows by
    one row per decision, and the decision is rare), so the whole log for these
    videos is one read and the max is taken here.
  */
  const lastSwapAt = new Map<string, string>();
  if (videoIds.length > 0) {
    const { data: swapRows, error: swapsError } = await supabase
      .from("thumbnail_swaps")
      .select("video_id, swapped_at")
      .in("video_id", videoIds);

    if (swapsError) {
      throw new Error(`Could not load the thumbnail swaps: ${swapsError.message}`);
    }

    for (const row of swapRows ?? []) {
      const current = lastSwapAt.get(row.video_id);
      if (!current || current < row.swapped_at) {
        lastSwapAt.set(row.video_id, row.swapped_at);
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Shaping                                                                   */
  /* ------------------------------------------------------------------------ */

  const stagesByChannel = new Map<string, NowStage[]>();
  for (const stage of stageRows ?? []) {
    const list = stagesByChannel.get(stage.channel_id) ?? [];
    list.push({
      id: stage.id,
      name: stage.name,
      kind: isStageKind(stage.kind) ? stage.kind : null,
    });
    stagesByChannel.set(stage.channel_id, list);
  }

  /*
    Rule 3's expectation: `coalesce(channel.expected_ctr, median first24_ctr of
    the channel's last 10 published)`.

    The sample comes from the videos already read rather than from a sixth
    query: every video with a logged CTR is in `videoRows` (the board hides a
    published card after 30 days; this query does not), so the fallback is
    computed from the same rows the rules are about.
  */
  const ctrsByChannel = new Map<string, { publishedAt: string; ctr: number }[]>();
  for (const video of videoRows ?? []) {
    if (video.first24_ctr === null || video.published_at === null) continue;
    const list = ctrsByChannel.get(video.channel_id) ?? [];
    list.push({ publishedAt: video.published_at, ctr: Number(video.first24_ctr) });
    ctrsByChannel.set(video.channel_id, list);
  }

  const channels: NowChannel[] = channelRows.map((channel) => {
    const recent = (ctrsByChannel.get(channel.id) ?? [])
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
      .slice(0, EXPECTATION_SAMPLE)
      .map((entry) => entry.ctr);

    return {
      id: channel.id,
      name: channel.name,
      slug: channel.slug,
      expectedCtr: channelExpectation(
        channel.expected_ctr === null ? null : Number(channel.expected_ctr),
        recent,
      ),
      stages: stagesByChannel.get(channel.id) ?? [],
    };
  });

  const videos: NowVideo[] = (videoRows ?? []).map((video) => ({
    id: video.id,
    channelId: video.channel_id,
    title: video.title,
    stageId: video.stage_id,
    stageEnteredAt: video.stage_entered_at,
    thumbnailConcept: video.thumbnail_concept,
    // The lenient reader in `lib/packaging.ts`: a jsonb array written by the
    // seed, by hand or by a future brainstorm import still has to render, and
    // it never *repairs* `chosen` — so the gate here says what `move_video`
    // will say.
    hooks: readHooks(video.hooks),
    packagingSkippedAt: video.packaging_skipped_at,
    waitingOn: video.waiting_on,
    waitingSince: video.waiting_since,
    targetPublishDate: video.target_publish_date,
    publishedAt: video.published_at,
    youtubeUrl: video.youtube_url,
    first24Impressions: video.first24_impressions,
    first24Ctr: video.first24_ctr === null ? null : Number(video.first24_ctr),
    metricsLoggedAt: video.metrics_logged_at,
    swapDismissedAt: video.swap_dismissed_at,
    lastSwapAt: lastSwapAt.get(video.id) ?? null,
    checklist: itemsByVideoAndStage.get(`${video.id}:${video.stage_id}`) ?? [],
  }));

  return { channels, videos };
});

/**
 * How many rows `/now` would draw, unfiltered — the number the sidebar shows.
 *
 * Unfiltered on purpose: the channel chips and the "10 minutes or less" switch
 * are a *narrowing* the user does on the page, and a badge that moved when they
 * narrowed would be reporting the filter rather than the work. This is the
 * denominator, and `/now` itself says so when a filter is on.
 *
 * `now` is an argument for the same reason it is one in `lib/next-action.ts`:
 * the ranking depends on the clock, and a page that read the clock twice could
 * cross a 24-hour boundary between the sidebar and the list.
 */
export async function countNowRows(now: number): Promise<number> {
  const { channels, videos } = await readNowInputs();
  if (channels.length === 0) return 0;

  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return rankNow(videos, { channels: byId }, now).length;
}
