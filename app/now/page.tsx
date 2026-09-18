import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { NowView } from "@/components/now/now-view";
import { CHECKLIST_COLUMNS, readChecklistItem, type ChecklistItem } from "@/lib/checklist";
import { isStageKind } from "@/lib/defaults";
import {
  channelExpectation,
  EXPECTATION_SAMPLE,
  type NowChannel,
  type NowStage,
  type NowVideo,
} from "@/lib/next-action";
import { readHooks } from "@/lib/packaging";
import { requireUser } from "@/lib/supabase/require-user";

export const metadata = { title: "Now · NerTube" };

/**
 * `/now` — "I have ten minutes. What can I move right now?"
 *
 * BRIEF.md calls this view *as important as the board*, and it is the one page
 * that is deliberately **not** about a video: it is about the next ten minutes.
 * Every row is one action on one video, and every row can be finished where it
 * stands.
 *
 * ## What this file does, and what it refuses to do
 *
 * It reads, and it hands the result to `lib/next-action.ts`. It contains no
 * rule about what the next action *is* — that lives in the pure function, where
 * it is unit-tested against PLAN.md's eight rules, and it is the same function
 * the client re-runs when a row is completed. Two copies of the ranking, one on
 * each side of the wire, is exactly the bug that would make a ticked row
 * reappear in the wrong section.
 *
 * ## Five reads, no embeds
 *
 * `videos` has two foreign keys to `stages` (the tenant one and the channel
 * one), so a PostgREST embed would be ambiguous — the board hit this first.
 * Five flat, RLS-scoped selects and the joining done in memory is both faster to
 * reason about and, at this size, faster: PLAN.md sizes the account at one user
 * and hundreds of rows.
 *
 * ## The clock is read once
 *
 * `Date.now()` here, passed down as a number, and used for every age on the
 * page — including the ones the client recomputes after an interaction. That is
 * what makes the server's HTML and the browser's first render agree, and it is
 * why "3 days in stage" does not silently become "4 days" halfway down the
 * list. A reload gets a new clock; nothing else does.
 */
export default async function NowPage() {
  const { supabase } = await requireUser();

  const { data: channelRows, error: channelsError } = await supabase
    .from("channels")
    .select("id, name, slug, expected_ctr")
    .order("created_at", { ascending: true });

  if (channelsError) {
    throw new Error(`Could not load the channels: ${channelsError.message}`);
  }
  if (!channelRows || channelRows.length === 0) {
    // Same destination as `/`: there is nothing to have ten minutes *for* yet.
    redirect("/c/new");
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

  /* ---------------------------------------------------------------------- */
  /* Shaping                                                                 */
  /* ---------------------------------------------------------------------- */

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

  // The page's one clock read. See the file comment.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <AppShell section="now">
      <NowView channels={channels} videos={videos} now={now} />
    </AppShell>
  );
}
