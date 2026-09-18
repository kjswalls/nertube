"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  CHECKLIST_COLUMNS,
  ChecklistItemTextSchema,
  readChecklistItem,
  topPosition,
  type ChecklistItem,
  type ChecklistItemRow,
} from "@/lib/checklist";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * The stage checklist's write paths.
 *
 * ## What the database already does, and this file therefore does not
 *
 * `checklist_items` are **snapshot-copied** from `checklist_templates` on first
 * entry to a stage, inside `move_video` and `capture_video` (PLAN.md open
 * question 2). Nothing here copies a template on entry, nothing here decides
 * when a stage is "first" entered, and nothing here reads a template except
 * `resetChecklist`, which is the one place the user asks for the copy again.
 *
 * ## Why these are plain table writes and not an RPC
 *
 * `videos.stage_id` is revoked from `authenticated`, which is why every stage
 * change goes through `move_video`. `checklist_items` carries no such revoke and
 * no invariant that spans rows: a tick is one column on one row, and the
 * composite tenant FKs already make it impossible to name another tenant's
 * video or a stage in another channel. So these are `UPDATE`, `INSERT` and
 * `DELETE` through PostgREST with RLS on — with the app's rule that every write
 * still goes through a server action, so there is one place that validates, one
 * place that stamps and one place that revalidates.
 *
 * ## The stage is never taken from the caller
 *
 * Every action here reads `videos.stage_id` itself. A page that has been open
 * while the video moved — in another tab, or from the board — would otherwise
 * add a row to a stage the video has left, where nobody would ever see it. The
 * result carries the stage it actually used, so a client showing a different
 * one can say the video has moved instead of silently dropping the write.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

const ToggleInput = z.object({
  videoId: z.uuid(),
  itemId: z.uuid(),
  /**
   * The state the row should end in, not "the other one".
   *
   * A toggle that read the row and flipped it would flip *twice* on a
   * double-click and land wherever the race left it. The tick is a judgement
   * the user made about a specific row, so the client says which judgement it
   * is and re-sending it is harmless.
   */
  checked: z.boolean(),
});

const AddInput = z.object({ videoId: z.uuid(), text: ChecklistItemTextSchema });
const DeleteInput = z.object({ videoId: z.uuid(), itemId: z.uuid() });
const ResetInput = z.object({ videoId: z.uuid() });

export type AddChecklistItemInput = z.input<typeof AddInput>;

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a write answers with.
 *
 * `stageId` is on every success: it is the stage the write actually landed in,
 * read from the row rather than taken from the caller. `items` is the stage's
 * whole list when the write changed more than one row (a reset), and the one
 * row that changed otherwise — the client merges rather than re-fetches, so a
 * tick costs one round trip.
 */
export type ChecklistResult =
  | {
      ok: true;
      stageId: string;
      /** The row this write produced, or null when it removed one. */
      item: ChecklistItem | null;
      /** Set only by `resetChecklist`: the stage's list, as it now stands. */
      items?: ChecklistItem[];
    }
  | { ok: false; error: string };

/** Said when the row is simply not there any more. */
const GONE =
  "That checklist item is not there any more — it may have been deleted in another tab. Reload to see the list as it stands.";

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

interface VideoStage {
  readonly videoId: string;
  readonly channelId: string;
  readonly stageId: string;
  readonly slug: string | null;
}

/**
 * The video's *current* stage, and the channel path to revalidate.
 *
 * RLS is the ownership check: another user's video reads as no row, which is
 * deliberately indistinguishable from an id that was never issued.
 */
async function videoStage(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  videoId: string,
): Promise<VideoStage | null> {
  const { data: video } = await supabase
    .from("videos")
    .select("id, channel_id, stage_id")
    .eq("id", videoId)
    .maybeSingle();

  if (!video) return null;

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", video.channel_id)
    .maybeSingle();

  return {
    videoId: video.id,
    channelId: video.channel_id,
    stageId: video.stage_id,
    slug: channel?.slug ?? null,
  };
}

/**
 * The detail page and the video's board.
 *
 * The board grows a `done/total` on the card from exactly these rows, so a tick
 * that did not revalidate it would leave a ratio that is one click stale on the
 * screen this product is used from most. The slug is looked up rather than
 * passed in, so a caller cannot aim a revalidation at a path it does not own.
 */
function revalidateFor(where: VideoStage): void {
  revalidatePath(`/videos/${where.videoId}`);
  if (where.slug) revalidatePath(`/c/${where.slug}/board`);
}

/* -------------------------------------------------------------------------- */
/* Tick and untick                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Tick or untick one row. The tick **is** `checked_at`: there is no boolean
 * column, so unticking writes NULL and the timestamp is the audit trail of when
 * the judgement was made.
 *
 * `eq("video_id", …)` is not redundant with `eq("id", …)`: it means a stale
 * page cannot tick a row that belongs to some other video it happens to know
 * the id of, and it is what makes the revalidation below provably about the
 * right video.
 */
export async function toggleChecklistItem(input: {
  videoId: string;
  itemId: string;
  checked: boolean;
}): Promise<ChecklistResult> {
  const parsed = ToggleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, itemId, checked } = parsed.data;

  const { supabase } = await requireUser();

  const where = await videoStage(supabase, videoId);
  if (!where) return { ok: false, error: "That video does not exist any more." };

  const { data, error } = await supabase
    .from("checklist_items")
    .update({ checked_at: checked ? new Date().toISOString() : null })
    .eq("id", itemId)
    .eq("video_id", videoId)
    .select(`${CHECKLIST_COLUMNS}, stage_id`)
    .maybeSingle<ChecklistItemRow & { stage_id: string }>();

  if (error) return { ok: false, error: `That tick did not save: ${error.message}` };
  if (!data) return { ok: false, error: GONE };

  revalidateFor(where);

  return {
    ok: true,
    stageId: data.stage_id,
    item: readChecklistItem(data),
  };
}

/* -------------------------------------------------------------------------- */
/* Add                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Add a custom item **at the top** of the current stage's list.
 *
 * `position = min(position) - 1` is the whole feature (PLAN.md open question 3:
 * *a custom next action is "add a checklist item", which inserts at the top and
 * is therefore the next action immediately*). Appending it would put the thing
 * you just decided to do next behind everything you already decided not to do
 * yet.
 *
 * There is no unique on `(video_id, stage_id, position)`, so two adds racing
 * can share a position rather than one of them failing. `compareItems` breaks
 * that tie by age, so the list still has one stable order — which is the
 * trade this takes deliberately: a duplicate number is invisible, a refused
 * insert is not.
 */
export async function addChecklistItem(
  input: AddChecklistItemInput,
): Promise<ChecklistResult> {
  const parsed = AddInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, text } = parsed.data;

  const { supabase } = await requireUser();

  const where = await videoStage(supabase, videoId);
  if (!where) return { ok: false, error: "That video does not exist any more." };

  // Only the positions, and only for this stage: the number this needs is one
  // integer, and reading the rows to find it would be a second copy of the list.
  const { data: positions, error: readError } = await supabase
    .from("checklist_items")
    .select("position")
    .eq("video_id", videoId)
    .eq("stage_id", where.stageId);

  if (readError) {
    return {
      ok: false,
      error: `Could not work out where to put that: ${readError.message}`,
    };
  }

  const position = topPosition(positions ?? []);

  const { data, error } = await supabase
    .from("checklist_items")
    .insert({
      video_id: videoId,
      channel_id: where.channelId,
      stage_id: where.stageId,
      text,
      position,
      // Left NULL on purpose: nobody types an estimate into the one-line box,
      // and NULL reads as ten minutes everywhere that asks.
      est_minutes: null,
    })
    .select(CHECKLIST_COLUMNS)
    .maybeSingle<ChecklistItemRow>();

  if (error) return { ok: false, error: `That did not save: ${error.message}` };
  if (!data) {
    return { ok: false, error: "That item did not save, and nothing said why." };
  }

  revalidateFor(where);

  return { ok: true, stageId: where.stageId, item: readChecklistItem(data) };
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Remove one row. A checklist item is a note to self, not a record: the rest of
 * the app reads `checklist_items` for "what is left to do", so a soft-deleted
 * row would have to be filtered out of every one of those reads to mean the
 * same thing.
 */
export async function deleteChecklistItem(input: {
  videoId: string;
  itemId: string;
}): Promise<ChecklistResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, itemId } = parsed.data;

  const { supabase } = await requireUser();

  const where = await videoStage(supabase, videoId);
  if (!where) return { ok: false, error: "That video does not exist any more." };

  const { data, error } = await supabase
    .from("checklist_items")
    .delete()
    .eq("id", itemId)
    .eq("video_id", videoId)
    .select("stage_id")
    .maybeSingle<{ stage_id: string }>();

  if (error) {
    return { ok: false, error: `That did not delete: ${error.message}` };
  }
  if (!data) return { ok: false, error: GONE };

  revalidateFor(where);

  return { ok: true, stageId: data.stage_id, item: null };
}

/* -------------------------------------------------------------------------- */
/* Reset                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Put the current stage's list back to its template: drop what is there, copy
 * the templates in again.
 *
 * PLAN.md defines it exactly that way — *"reset from template" is delete +
 * re-copy* — and that is also its cost: it discards the ticks and every custom
 * item in this stage. The UI asks before calling it.
 *
 * ## It is two writes, and it says so when the second one fails
 *
 * supabase-js has no transactions, so this is a DELETE and then an INSERT over
 * two requests. The templates are read **first**, so the copy is never
 * attempted with nothing to copy; if the insert still fails, the stage is left
 * empty and the message says so rather than reporting a reset that did not
 * happen. Pressing reset again is a complete retry — the templates are
 * untouched, which is the property that makes the non-atomic version tolerable.
 * The alternative is a fifth `security definer` function for an operation with
 * no invariant to protect, which `supabase/tests/90_schema_contract.test.sql`
 * pins at four.
 */
export async function resetChecklist(input: {
  videoId: string;
}): Promise<ChecklistResult> {
  const parsed = ResetInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId } = parsed.data;

  const { supabase } = await requireUser();

  const where = await videoStage(supabase, videoId);
  if (!where) return { ok: false, error: "That video does not exist any more." };

  const { data: templates, error: templateError } = await supabase
    .from("checklist_templates")
    .select("text, position, est_minutes")
    .eq("stage_id", where.stageId)
    .order("position", { ascending: true });

  if (templateError) {
    return {
      ok: false,
      error: `Could not read this stage's template: ${templateError.message}`,
    };
  }

  const { error: deleteError } = await supabase
    .from("checklist_items")
    .delete()
    .eq("video_id", videoId)
    .eq("stage_id", where.stageId);

  if (deleteError) {
    return {
      ok: false,
      error: `Could not clear the list: ${deleteError.message}. Nothing was changed.`,
    };
  }

  let items: ChecklistItem[] = [];

  if ((templates ?? []).length > 0) {
    const { data, error } = await supabase
      .from("checklist_items")
      .insert(
        (templates ?? []).map((template) => ({
          video_id: videoId,
          channel_id: where.channelId,
          stage_id: where.stageId,
          text: template.text,
          position: template.position,
          est_minutes: template.est_minutes,
        })),
      )
      .select(CHECKLIST_COLUMNS);

    if (error) {
      revalidateFor(where);
      return {
        ok: false,
        error: `The list was cleared, but the template did not go back: ${error.message}. Press Reset again.`,
      };
    }

    items = (data ?? []).map(readChecklistItem);
  }

  revalidateFor(where);

  return { ok: true, stageId: where.stageId, item: null, items };
}
