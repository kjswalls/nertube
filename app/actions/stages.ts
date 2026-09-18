"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * Turning a stage on and off.
 *
 * ## What this is for in M4, and what it is not
 *
 * BRIEF.md's stage table ends with *"Repurposed | Clips/newsletter/social
 * derived (**optional lane — can be toggled off**)"*, and that toggle is the
 * only part of the settings screen the post-publish loop cannot do without: a
 * creator who does not cut clips should not have a column asking them to. The
 * settings screen itself — renaming stages, reordering them, checklist
 * templates, buckets, thresholds — is M7, and none of it is here.
 *
 * So this file has one action, and the Publish section is its only caller.
 *
 * ## The rule it enforces, and where that rule really lives
 *
 * PLAN.md, stages: *"Core stages may be renamed and disabled, never deleted;
 * disabling one holding non-archived videos is refused."* The reason is not
 * tidiness. A disabled stage is filtered out of every read in the app — the
 * board's columns (`app/c/[slug]/board/page.tsx`), the ranking's stage list
 * (`lib/now-data.ts`), the detail page's stage select — and `nextAction()`
 * returns null for a video whose stage it cannot find. Disabling an occupied
 * stage therefore does not hide a column; it **hides the videos in it**, from
 * the board, from `/now` and from the sidebar's count, with nothing anywhere
 * saying where they went.
 *
 * **This check is in the application, and that is a deviation worth naming.**
 * Everywhere else in this app an invariant of this weight is in the database —
 * `move_video`'s gate, the paired-CHECK on the metrics, the append-only swap
 * log — precisely so that it cannot be walked around by a client that does not
 * call the right function. Here it is not, because `stages.is_enabled` is in
 * the client's UPDATE grant on purpose (`0001_init.sql`) and
 * `supabase/tests/20_column_privileges.test.sql` asserts that a client can
 * disable a core stage: *"Renaming and disabling a core stage still work"*.
 * Moving the rule into the database means revoking that column and rewriting a
 * passing test of a deliberate decision, which is M7's argument to have with
 * the whole settings screen in front of it, not this milestone's.
 *
 * The honest consequences, stated rather than discovered:
 *
 * - The check is **read-then-write**, so a video moved into the stage in the
 *   microseconds between the two would be hidden. One user, one session; the
 *   race is real and it is not reachable in practice.
 * - A client that calls PostgREST directly can still disable an occupied
 *   stage. Nothing in the app does, and the app is the only thing that talks
 *   to this database — but that is a statement about the code, not a guarantee
 *   from the schema, which is the difference this note exists to record.
 */

const SetStageEnabledInput = z.object({
  stageId: z.uuid(),
  enabled: z.boolean(),
});

export type SetStageEnabledInput = z.input<typeof SetStageEnabledInput>;

export type SetStageEnabledResult =
  | {
      ok: true;
      stageId: string;
      stageName: string;
      enabled: boolean;
    }
  | {
      ok: false;
      error: string;
      /** How many non-archived videos are sitting in it, when that is why. */
      occupied?: number;
    };

export async function setStageEnabled(
  input: SetStageEnabledInput,
): Promise<SetStageEnabledResult> {
  const parsed = SetStageEnabledInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a stage this page could ask about." };
  }
  const { stageId, enabled } = parsed.data;

  const { supabase } = await requireUser();

  // RLS scopes this to the signed-in user, so another user's stage id simply
  // is not found — the same answer as an id that was never issued.
  const { data: stage, error: readError } = await supabase
    .from("stages")
    .select("id, name, channel_id, is_enabled")
    .eq("id", stageId)
    .maybeSingle();

  if (readError) {
    return { ok: false, error: `Could not read that stage: ${readError.message}` };
  }
  if (!stage) return { ok: false, error: "That stage does not exist any more." };

  if (!enabled) {
    /*
      Archived videos do not count. PLAN.md review item 10: *"disable check
      ignores archived videos"* — an archived video is already off the board and
      out of `/now`, so it is not something disabling the lane would hide.
    */
    const { count, error: countError } = await supabase
      .from("videos")
      .select("id", { count: "exact", head: true })
      .eq("stage_id", stageId)
      .is("archived_at", null);

    if (countError) {
      return {
        ok: false,
        error: `Could not check what is in ${stage.name}: ${countError.message}`,
      };
    }

    if ((count ?? 0) > 0) {
      const n = count ?? 0;
      return {
        ok: false,
        occupied: n,
        error:
          n === 1
            ? `${stage.name} still holds a video. Move it on or archive it first — switching the lane off would hide it from the board and from /now.`
            : `${stage.name} still holds ${n} videos. Move them on or archive them first — switching the lane off would hide them from the board and from /now.`,
      };
    }
  }

  const { data, error } = await supabase
    .from("stages")
    .update({ is_enabled: enabled })
    .eq("id", stageId)
    .select("id, name, is_enabled")
    .maybeSingle();

  if (error) {
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) return { ok: false, error: "That stage does not exist any more." };

  // The board draws the columns and `/now` ranks by them; both change shape.
  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", stage.channel_id)
    .maybeSingle();

  if (channel) revalidatePath(`/c/${channel.slug}/board`);
  revalidatePath("/now");

  return {
    ok: true,
    stageId: data.id,
    stageName: data.name,
    enabled: data.is_enabled,
  };
}
