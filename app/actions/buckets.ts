"use server";

import { NO_BUCKETS, type BucketChoices } from "@/lib/buckets";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * One channel's content buckets, for a picker.
 *
 * ## Why capture reads them through an action rather than being handed them
 *
 * The `c` modal is mounted by the sidebar, which every signed-in route renders.
 * Handing it the buckets would mean reading them on every page load — the
 * board, the video page, `/now` — to fill in a disclosure that is closed until
 * Shift+Enter and a dialog that is usually never opened. BRIEF.md principle 6
 * is that friction is the product's enemy, and PLAN.md's capture is *one field,
 * Enter, saved*; paying a query per page for it is the same mistake in a
 * different currency.
 *
 * So the pickers ask for their options when they are first shown, once per
 * channel, and the fast path costs nothing at all. The modal is JavaScript by
 * definition — there is no dialog without it — so nothing is lost to the
 * no-JavaScript path that was not already gone: the disclosure itself is a
 * button with an `onClick`.
 *
 * `/videos/[id]` does **not** call this. That page already reads the row it is
 * editing, so its buckets come down with the server render, in the same request
 * that knows which of them the video currently carries.
 *
 * ## What it is not
 *
 * Not a write path, and not a validator. RLS scopes the read to the signed-in
 * user, so a channel belonging to someone else returns nothing — the same
 * answer as a channel id that was never issued. Whether a *chosen* bucket is
 * legitimate is settled by the three-column composite foreign key on `videos`,
 * not here: this only decides what a person is offered.
 */
export async function listBuckets(
  channelId: string,
): Promise<
  | { ok: true; choices: BucketChoices }
  | { ok: false; error: string; choices: BucketChoices }
> {
  const { supabase } = await requireUser();

  const { data, error } = await supabase
    .from("buckets")
    .select("id, axis, name, position")
    .eq("channel_id", channelId)
    .order("position", { ascending: true });

  /*
    A reported failure, not a throw and not an empty pair.

    A capture whose pickers could not load is still a capture — the title is
    already typed and Enter must still save it — so this never takes the form
    down. But "the read failed" and "this channel has no pillars yet" are
    different sentences and the second one is a lie about the first: the form
    says which it was, beside the pickers, and the title is untouched either
    way.
  */
  if (error || !data) {
    return {
      ok: false,
      error: `Could not load this channel's buckets: ${error?.message ?? "no rows came back."}`,
      choices: NO_BUCKETS,
    };
  }

  const verticals: { id: string; name: string }[] = [];
  const horizontals: { id: string; name: string }[] = [];
  for (const bucket of data) {
    const option = { id: bucket.id, name: bucket.name };
    if (bucket.axis === "vertical") verticals.push(option);
    else if (bucket.axis === "horizontal") horizontals.push(option);
  }

  return { ok: true, choices: { verticals, horizontals } };
}
