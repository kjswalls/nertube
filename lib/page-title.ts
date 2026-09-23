import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Document titles that name the thing on the page.
 *
 * A screen-reader user, and anyone with several tabs open, tells pages apart
 * by their title. Until the M9 review every video page was "Video · NerTube"
 * whatever the video, and the channel pages used the lowercase slug
 * ("personal · board") where the page's own heading says "Personal".
 *
 * One small read each, through the request's RLS-scoped client: a row the
 * reader cannot see is indistinguishable from one that does not exist, so a
 * title never confirms another user's video or channel — it falls back to the
 * generic wording the page had before.
 */

/** `"<Channel name> · <what> · NerTube"`, or the slug when the read finds nothing. */
export async function channelPageTitle(slug: string, what: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("channels")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  const name = data?.name?.trim() || slug;
  return `${name} · ${what} · NerTube`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `"<working title> · NerTube"`, "Untitled" for an empty one. */
export async function videoPageTitle(id: string): Promise<string> {
  if (!UUID.test(id)) return "Video · NerTube";
  const supabase = await createClient();
  const { data } = await supabase.from("videos").select("title").eq("id", id).maybeSingle();
  if (!data) return "Video · NerTube";
  const title = data.title.trim();
  return `${title === "" ? "Untitled" : title} · NerTube`;
}
