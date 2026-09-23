import { redirect } from "next/navigation";

import { settingsPath, type SettingsSection } from "@/components/settings/settings-nav";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * A settings address with no channel named — `/settings`, or one of the four
 * sections bare — is sent to the first channel's page for that section, by
 * the same rule the sidebar's Board row uses (the channels in `created_at`
 * order), or to `/c/new` when there is nothing to configure yet.
 *
 * A redirect rather than a page, so every setting has exactly one address:
 * `/settings/<section>/[slug]`. Five index routes share this one function
 * because four copies of it had already been written by the time the area
 * was put together, and a fifth would have been the pattern.
 */
export async function redirectToFirstChannel(section: SettingsSection): Promise<never> {
  const { supabase } = await requireUser();

  const { data, error } = await supabase
    .from("channels")
    .select("slug")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // A failed read is not "no channels" (M9): it goes to `app/error.tsx`.
  if (error) throw new Error(`Could not load your channels: ${error.message}`);
  if (!data) redirect("/c/new");
  redirect(settingsPath(section, data.slug));
}
