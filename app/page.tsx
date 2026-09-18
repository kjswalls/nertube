import { redirect } from "next/navigation";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * The entry point: no channel yet → `/c/new`, otherwise the first channel's
 * board.
 *
 * PLAN.md's destination for an existing channel is `/now`, which does not exist
 * until M3. Pointing there now would be a dead link, so until then `/` lands on
 * the board — the one page that is actually built.
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

  redirect(channel ? `/c/${channel.slug}/board` : "/c/new");
}
