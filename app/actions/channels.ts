"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from "@/lib/defaults";
import { slugify } from "@/lib/slug";
import { requireUser } from "@/lib/supabase/require-user";

/** What the create-a-channel form renders. `null` before the first submit. */
export type CreateChannelState = { error: string } | null;

const ChannelName = z.string().min(1).max(80);

/**
 * Create a channel and seed everything a channel needs to be usable: its nine
 * stages, a checklist template per stage, the format buckets and the script
 * template — all from `lib/defaults.ts`, which stays the single copy of that
 * content and hands it to the database as jsonb.
 *
 * **One call, one transaction.** supabase-js has no transactions, so writing
 * the channel and then three more batches of rows meant a failure half way
 * through left a committed channel with no columns — and PLAN.md gives
 * `channels` no delete policy, so nothing could have cleaned it up. The whole
 * write is therefore a plpgsql function (`create_channel`, see
 * `supabase/migrations/0002_create_channel.sql`), and a client cannot insert a
 * channel row any other way.
 *
 * On success it redirects to the new channel's board, so it returns only on
 * failure.
 */
export async function createChannel(
  name: string,
): Promise<CreateChannelState> {
  const { supabase } = await requireUser();

  const parsed = ChannelName.safeParse(name.trim());
  if (!parsed.success) {
    return { error: "Give the channel a name of 1–80 characters." };
  }

  const slug = slugify(parsed.data);
  if (!slug) {
    return {
      error: "That name has no letters or digits to build a URL from.",
    };
  }

  // Templates travel nested inside their stage, so the function can insert each
  // stage and its rows without a second round trip to look the stage id up.
  const stages = SEED_STAGES.map((stage) => ({
    name: stage.name,
    kind: stage.kind,
    position: stage.position,
    templates: SEED_CHECKLISTS[stage.kind].map((item, index) => ({
      text: item.text,
      position: index + 1,
      est_minutes: item.est_minutes,
    })),
  }));

  const { data: channel, error } = await supabase.rpc("create_channel", {
    p_name: parsed.data,
    p_slug: slug,
    p_script_template: SCRIPT_TEMPLATE,
    p_wip_threshold: CHANNEL_DEFAULTS.wip_threshold,
    p_stale_days: CHANNEL_DEFAULTS.stale_days,
    p_expected_ctr: CHANNEL_DEFAULTS.expected_ctr,
    p_voice_guide: CHANNEL_DEFAULTS.voice_guide,
    p_stages: stages,
    p_buckets: SEED_BUCKETS.map((bucket) => ({
      axis: bucket.axis,
      name: bucket.name,
      position: bucket.position,
      monthly_quota: null,
    })),
  });

  if (error) {
    // unique (user_id, slug)
    if (error.code === "23505") {
      return { error: `You already have a channel at /c/${slug}.` };
    }
    return { error: `Could not create the channel: ${error.message}` };
  }

  // The header's channel switcher is rendered on every page.
  revalidatePath("/", "layout");
  redirect(`/c/${channel.slug}/board`);
}

/**
 * Form wrapper for `createChannel`, shaped for `useActionState`.
 */
export async function createChannelAction(
  _prevState: CreateChannelState,
  formData: FormData,
): Promise<CreateChannelState> {
  const name = formData.get("name");
  return createChannel(typeof name === "string" ? name : "");
}
