"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  EstMinutesSchema,
  TEMPLATE_COLUMNS,
  TemplateTextSchema,
  isPermutationOf,
  nextPosition,
  readTemplateItem,
  sortTemplates,
  type TemplateItem,
  type TemplateRow,
} from "@/lib/checklist-templates";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * The checklist template editor's write paths — `/settings/checklists/[slug]`.
 *
 * ## The boundary these writes live behind
 *
 * A template is copied onto a video by `move_video` and `capture_video` on
 * first entry to a stage, and the copy carries no reference back (PLAN.md open
 * question 2: no `template_item_id` in v1). So nothing here can reach a list a
 * person is already ticking, and nothing here tries to: every action below
 * writes `checklist_templates` and only `checklist_templates`. The next video
 * to enter the stage gets what the table says then. That is the entire
 * contract, and `e2e/settings-checklists.spec.ts` proves both halves of it.
 *
 * ## Plain table writes, and one that has to be one statement
 *
 * `checklist_templates` carries no column revoke and no cross-row invariant
 * except one: `unique (stage_id, position) deferrable initially deferred`.
 * Adding, editing and removing a row are each one request. Reordering is not
 * a sequence of updates — a swap done as two requests violates the unique
 * halfway through, and the deferral only helps inside one transaction, which
 * for PostgREST means one request. supabase-js cannot express PLAN.md's
 * `update … set position = case …`, and adding a SQL function for it would be
 * a fifth function where `supabase/tests/90_schema_contract.test.sql` pins
 * four, so the one statement is an **upsert**: every row of the stage with its
 * new position, `insert … on conflict (id) do update`, one request, one
 * transaction, checked at commit. `reorderTemplateItems` explains the rest.
 *
 * ## The stage is read, never trusted
 *
 * Every action reads the row it is about through RLS and refuses when nothing
 * comes back. A reorder is refused unless the ids it was handed are *exactly*
 * the stage's rows — an id from another stage, a missing row or a duplicate
 * all fail `isPermutationOf` before a position is touched.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

const AddInput = z.object({
  stageId: z.uuid(),
  text: TemplateTextSchema,
  estMinutes: EstMinutesSchema,
});

const EditInput = z
  .object({
    templateId: z.uuid(),
    text: TemplateTextSchema.optional(),
    estMinutes: EstMinutesSchema.optional(),
  })
  .refine((value) => value.text !== undefined || value.estMinutes !== undefined, {
    message: "Nothing to change.",
  });

const RemoveInput = z.object({ templateId: z.uuid() });

const ReorderInput = z.object({
  stageId: z.uuid(),
  orderedIds: z.array(z.uuid()).min(1),
});

export type AddTemplateItemInput = z.input<typeof AddInput>;
export type EditTemplateItemInput = z.input<typeof EditInput>;
export type RemoveTemplateItemInput = z.input<typeof RemoveInput>;
export type ReorderTemplateItemsInput = z.input<typeof ReorderInput>;

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every write answers with the stage's whole template as it now stands.
 *
 * The list is small (the longest seed is nine rows) and every write here
 * changes what the *rest* of the list means — a removal leaves a gap in the
 * positions, a reorder renumbers everything, an add takes the position after
 * the last — so the client replaces rather than merges, and can never hold a
 * row the table does not.
 */
export type TemplateResult =
  | { ok: true; stageId: string; items: TemplateItem[] }
  | { ok: false; error: string };

/** Said when the row is simply not there any more. */
const GONE =
  "That template row is not there any more — it may have been removed in another tab. Reload to see the template as it stands.";

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

type Supabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

/**
 * The stage, through RLS. Another user's stage id reads as no row, which is
 * deliberately indistinguishable from an id that was never issued.
 */
async function readStage(
  supabase: Supabase,
  stageId: string,
): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from("stages")
    .select("id, name")
    .eq("id", stageId)
    .maybeSingle();
  return data ?? null;
}

/** The stage's rows, in order. */
async function readTemplate(
  supabase: Supabase,
  stageId: string,
): Promise<{ items: TemplateItem[] } | { error: string }> {
  const { data, error } = await supabase
    .from("checklist_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("stage_id", stageId)
    .order("position", { ascending: true });

  if (error) return { error: `Could not read the template: ${error.message}` };
  return { items: sortTemplates((data ?? []).map(readTemplateItem)) };
}

/**
 * The settings page is the only reader of these rows that is cached at all.
 * The route pattern with `"page"`, because the channel is a segment of it.
 */
function revalidate(): void {
  revalidatePath("/settings/checklists/[slug]", "page");
}

/** The stage's list, after a write: the shape every success answers with. */
async function answer(
  supabase: Supabase,
  stageId: string,
): Promise<TemplateResult> {
  const read = await readTemplate(supabase, stageId);
  if ("error" in read) return { ok: false, error: read.error };
  revalidate();
  return { ok: true, stageId, items: read.items };
}

/* -------------------------------------------------------------------------- */
/* Add                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Append a row to a stage's template.
 *
 * At the **end**, unlike a custom item on a video. A video's custom item goes
 * to the top because it is the thing you have just decided to do next; a
 * template row is a step in a procedure, and a procedure is written in order.
 * Moving it is one click on the arrow.
 *
 * Two adds racing can both compute the same `max + 1`. The deferred unique
 * refuses the second at commit, and the insert is retried once with a fresh
 * read — one user, one session, so the second attempt is the last.
 */
export async function addTemplateItem(
  input: AddTemplateItemInput,
): Promise<TemplateResult> {
  const parsed = AddInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { stageId, text, estMinutes } = parsed.data;

  const { supabase } = await requireUser();

  const stage = await readStage(supabase, stageId);
  if (!stage) return { ok: false, error: "That stage does not exist any more." };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data: positions, error: readError } = await supabase
      .from("checklist_templates")
      .select("position")
      .eq("stage_id", stageId);

    if (readError) {
      return {
        ok: false,
        error: `Could not work out where to put that: ${readError.message}`,
      };
    }

    const { error } = await supabase.from("checklist_templates").insert({
      stage_id: stageId,
      text,
      position: nextPosition(positions ?? []),
      est_minutes: estMinutes,
    });

    if (!error) break;
    // 23505: the position was taken between the read and the write.
    if (error.code === "23505" && attempt === 0) continue;
    return { ok: false, error: `That did not save: ${error.message}` };
  }

  return answer(supabase, stageId);
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Change a row's words or its estimate. Absolute values, so re-sending the
 * same edit is harmless and two edits in flight are an ordering problem the
 * client's queue already solves, not a merge problem.
 */
export async function updateTemplateItem(
  input: EditTemplateItemInput,
): Promise<TemplateResult> {
  const parsed = EditInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { templateId, text, estMinutes } = parsed.data;

  const { supabase } = await requireUser();

  const patch: { text?: string; est_minutes?: number } = {};
  if (text !== undefined) patch.text = text;
  if (estMinutes !== undefined) patch.est_minutes = estMinutes;

  const { data, error } = await supabase
    .from("checklist_templates")
    .update(patch)
    .eq("id", templateId)
    .select(TEMPLATE_COLUMNS)
    .maybeSingle<TemplateRow>();

  if (error) return { ok: false, error: `That did not save: ${error.message}` };
  if (!data) return { ok: false, error: GONE };

  return answer(supabase, data.stage_id);
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Take a row out of the template. The positions of the rows after it are left
 * with a gap on purpose: nothing reads positions as a count, the order is
 * unchanged, and closing the gap would be a multi-row write for nothing.
 *
 * Videos already in the stage keep their copy of this row. That is not a
 * limitation to apologise for; it is the boundary, and the editor says so
 * beside the button.
 */
export async function removeTemplateItem(
  input: RemoveTemplateItemInput,
): Promise<TemplateResult> {
  const parsed = RemoveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { templateId } = parsed.data;

  const { supabase } = await requireUser();

  const { data, error } = await supabase
    .from("checklist_templates")
    .delete()
    .eq("id", templateId)
    .select("stage_id")
    .maybeSingle<{ stage_id: string }>();

  if (error) return { ok: false, error: `That did not remove: ${error.message}` };
  if (!data) return { ok: false, error: GONE };

  return answer(supabase, data.stage_id);
}

/* -------------------------------------------------------------------------- */
/* Reorder                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Put the stage's rows in the order given, as **one statement**.
 *
 * `orderedIds` has to be exactly the stage's rows — every one, once, and no
 * other — or nothing is written. The rows are then renumbered 1..n in that
 * order and written back with a single upsert: PostgREST turns it into one
 * `insert … on conflict (id) do update set position = excluded.position …`,
 * which is one statement in one transaction, so the deferred unique on
 * `(stage_id, position)` is checked once, at commit, after every row has
 * moved. A swap done as two updates is refused by that unique halfway through;
 * this cannot be.
 *
 * The text and estimate ride along because an upsert has to be a valid insert,
 * and they are the values read a moment ago through RLS — not values the
 * caller supplied. The window between that read and this write is the same
 * read-then-write window `setStageEnabled` documents, for the same one user.
 */
export async function reorderTemplateItems(
  input: ReorderTemplateItemsInput,
): Promise<TemplateResult> {
  const parsed = ReorderInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not an order this page could apply." };
  }
  const { stageId, orderedIds } = parsed.data;

  const { supabase } = await requireUser();

  const stage = await readStage(supabase, stageId);
  if (!stage) return { ok: false, error: "That stage does not exist any more." };

  const read = await readTemplate(supabase, stageId);
  if ("error" in read) return { ok: false, error: read.error };

  if (!isPermutationOf(orderedIds, read.items)) {
    return {
      ok: false,
      error: `That order does not match ${stage.name}'s template as it stands — a row was added or removed since this page loaded. Reload and try again.`,
    };
  }

  const byId = new Map(read.items.map((item) => [item.id, item]));
  const rows = orderedIds.map((id, index) => {
    const item = byId.get(id)!;
    return {
      id: item.id,
      stage_id: item.stageId,
      text: item.text,
      est_minutes: item.estMinutes,
      position: index + 1,
    };
  });

  // Nothing moved: the order given is the order held. Answer without writing.
  const unchanged = rows.every((row) => byId.get(row.id)!.position === row.position);
  if (!unchanged) {
    const { error } = await supabase
      .from("checklist_templates")
      .upsert(rows, { onConflict: "id" });

    if (error) return { ok: false, error: `That order did not save: ${error.message}` };
  }

  return answer(supabase, stageId);
}
