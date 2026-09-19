import { redirect } from "next/navigation";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * `/settings/stages` with no channel named — sent to the first channel's
 * stages, by the same rule the sidebar's Board row uses (channels in
 * `created_at` order), or to `/c/new` when there is no channel to configure.
 *
 * A redirect rather than a page so that a channel's stages have exactly one
 * address, `/settings/stages/[slug]`, the shape every settings screen uses.
 */
export default async function StageSettingsIndex() {
  const { supabase } = await requireUser();

  const { data } = await supabase
    .from("channels")
    .select("slug")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) redirect("/c/new");
  redirect(`/settings/stages/${encodeURIComponent(data.slug)}`);
}
