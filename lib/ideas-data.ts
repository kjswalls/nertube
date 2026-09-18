import { cache } from "react";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * How many ideas one channel's bank is holding — the number the sidebar draws.
 *
 * ## Why this is not a `count` on whatever query is nearest
 *
 * Because the sidebar's number and the page it links to have to be the same
 * number, and "an idea" has exactly one definition in this product: a video in
 * this channel's **Idea** stage that is not archived. `lib/now-data.ts` makes
 * the same argument at length for `/now`'s badge and this file is its twin, but
 * the failure modes here are its own and all three are reachable from code that
 * already exists:
 *
 * 1. **Counting by stage name.** Stages can be renamed in settings (M7), and
 *    `kind` is what every other branch in this app keys on. A count that looked
 *    for "Idea" would go to zero the day somebody called it "Inbox".
 * 2. **Reusing `readNowInputs`.** It reads only `is_enabled` stages, on
 *    purpose. A channel that has switched its Idea column off still has a bank
 *    — `/c/[slug]/ideas` says so and lists it — so a count taken from that read
 *    would say 0 above a page listing 40.
 * 3. **Counting archived rows.** The bank hides them behind a toggle and the
 *    heading counts the live ones, so the badge counts the live ones.
 *
 * ## The cost, stated
 *
 * Two reads, `cache()`d per request. On `/c/[slug]/ideas` itself that is free
 * in the sense that matters — the page does its own, richer read and this one
 * is the sidebar's, and React's `cache` collapses repeat calls within the
 * request. On every other signed-in route it is two extra round trips for a
 * number that has to be right to be worth drawing at all. `head: true` makes
 * the second one a `count` with no rows in the body, which is the cheapest
 * honest form of the question.
 *
 * ## It is allowed to fail
 *
 * `null`, never a throw and never a zero. `AppShell` renders on every signed-in
 * route, and a transient failure reading `stages` must not take the board down
 * with it — the badge simply does not draw, exactly as the Now count already
 * degrades. Zero would be a claim; `null` is the absence of one.
 */
export const countIdeas = cache(
  async (channelId: string): Promise<number | null> => {
    try {
      const { supabase } = await requireUser();

      const { data: stage, error: stageError } = await supabase
        .from("stages")
        .select("id")
        .eq("channel_id", channelId)
        .eq("kind", "idea")
        .maybeSingle();

      if (stageError || !stage) return null;

      const { count, error } = await supabase
        .from("videos")
        .select("id", { count: "exact", head: true })
        .eq("channel_id", channelId)
        .eq("stage_id", stage.id)
        .is("archived_at", null);

      if (error) return null;
      return count ?? null;
    } catch {
      return null;
    }
  },
);
