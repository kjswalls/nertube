import { redirect } from "next/navigation";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * The entry point. PLAN.md's routing table: *no channel → `/c/new`; else →
 * `/now`*.
 *
 * M1 and M2 sent an existing channel to its board instead, because `/now` did
 * not exist and a front door onto a 404 is worse than a front door onto the
 * wrong room. M3 built it, so the door goes where the plan always said.
 *
 * ## Why the front door is the list and not the board
 *
 * BRIEF.md's complaint about every other tool is that they answer "what is the
 * state of everything" when the question in the morning is "what do I do next".
 * The board answers the first; `/now` answers the second. Opening on the board
 * makes the answer to the actual question one click away, every day, forever —
 * and the board is one click away from `/now` in exactly the same way.
 *
 * The channel read is still here, because "no channel yet" is still the first
 * branch: `/now` with nothing to be busy about sends the user to `/c/new`
 * anyway, and going straight there saves a redirect through a page that only
 * redirects again.
 */
export default async function Home() {
  const { supabase } = await requireUser();

  // "First" = earliest created, matching the order the sidebar lists them in.
  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  redirect(channel ? "/now" : "/c/new");
}
