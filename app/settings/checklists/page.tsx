import { redirect } from "next/navigation";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * `/settings/checklists` with no channel named — sent to the first channel's
 * templates, by the same rule the sidebar's Board row uses (the channels in
 * `created_at` order), or to `/c/new` when there is nothing to configure yet.
 *
 * A redirect rather than a page so that the templates have exactly one
 * address per channel, `/settings/checklists/[slug]`, the shape the other
 * settings screens use.
 */
export default async function ChecklistSettingsIndex() {
  const { supabase } = await requireUser();

  const { data } = await supabase
    .from("channels")
    .select("slug")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) redirect("/c/new");
  redirect(`/settings/checklists/${encodeURIComponent(data.slug)}`);
}
