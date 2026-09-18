import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import type { ChecklistProgress } from "@/lib/checklist";

/**
 * The `done/total` a board card shows, for a whole board, in as few queries as
 * there are occupied columns.
 *
 * ## Why it is one query per stage and not one query for the board
 *
 * The ratio a card shows is the video's **current** stage's list, and
 * `checklist_items` holds a row for every stage the video has ever entered. So
 * the filter this needs is "`stage_id` = *that video's* stage", which is a
 * different value per row and not something a single PostgREST filter can say.
 *
 * The obvious workarounds are both worse:
 *
 * - Fetching every item for every video on the board and filtering in memory
 *   reads nine stages' lists to use one of them, and runs into PostgREST's
 *   `db-max-rows` ceiling (1000, matching a hosted project) — at which point the
 *   rows are *silently* truncated and every ratio past the cut is wrong.
 * - An `or=(and(video_id.eq…,stage_id.eq…),…)` filter is exact, but it is one
 *   URL segment per card and a board is allowed a couple of thousand cards.
 *
 * Grouping the cards by the stage they are in gives one exact query per
 * occupied column — at most nine on a seeded channel — each of which reads only
 * the rows a card will actually use. They run together.
 *
 * ## It refuses to guess when it might have been truncated
 *
 * Each query asks for one row more than it is willing to trust. If that many
 * come back, the answer may be short, so every video in that group is left
 * *absent* from the map rather than given a ratio computed from a fraction of
 * its list. The card renders nothing for an absent video — which is the same
 * thing it renders for a stage with no checklist, and is the honest output for
 * "this number could be wrong".
 */

/** What one query will read before it stops believing its own answer. */
const MAX_ROWS_PER_STAGE = 900;

export interface CardChecklist {
  readonly videoId: string;
  readonly stageId: string;
}

export async function checklistRatios(
  supabase: SupabaseClient<Database>,
  cards: readonly CardChecklist[],
): Promise<Map<string, ChecklistProgress>> {
  const ratios = new Map<string, ChecklistProgress>();
  if (cards.length === 0) return ratios;

  const byStage = new Map<string, string[]>();
  for (const card of cards) {
    const ids = byStage.get(card.stageId);
    if (ids) ids.push(card.videoId);
    else byStage.set(card.stageId, [card.videoId]);
  }

  const groups = Array.from(byStage.entries());

  const results = await Promise.all(
    groups.map(([stageId, videoIds]) =>
      supabase
        .from("checklist_items")
        .select("video_id, checked_at")
        .eq("stage_id", stageId)
        .in("video_id", videoIds)
        .limit(MAX_ROWS_PER_STAGE + 1),
    ),
  );

  for (let index = 0; index < groups.length; index += 1) {
    const [, videoIds] = groups[index];
    const { data, error } = results[index];

    // A failed read is not a zero. Leaving the group out of the map is what
    // makes the card render no ratio rather than "0/8".
    if (error || !data) continue;
    if (data.length > MAX_ROWS_PER_STAGE) continue;

    // Every video in the group starts at 0/0 so that a video whose stage has
    // no rows is still *present* with a total of zero — the card's own rule
    // turns that into nothing rendered, in one place rather than two.
    const counts = new Map<string, { done: number; total: number }>(
      videoIds.map((videoId) => [videoId, { done: 0, total: 0 }]),
    );

    for (const row of data) {
      const count = counts.get(row.video_id);
      if (!count) continue;
      count.total += 1;
      if (row.checked_at !== null) count.done += 1;
    }

    for (const [videoId, count] of counts) {
      ratios.set(videoId, { done: count.done, total: count.total });
    }
  }

  return ratios;
}
