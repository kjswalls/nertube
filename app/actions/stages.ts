"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isStageKind, type StageKind } from "@/lib/defaults";
import {
  StageNameSchema,
  canMove,
  ideaStaysOnSentence,
  isIdeaStageRefusal,
  moved,
  nameTaken,
  occupiedHref,
  occupiedSentence,
  readCoreOrderRefusal,
  readOccupied,
  type MoveDirection,
} from "@/lib/stage-settings";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * A channel's stages: the label, the order, on or off, and adding one.
 *
 * ## What this file is, since M7
 *
 * M4 put one action here — `setStageEnabled`, for the Repurposed lane switch
 * on the video page — and wrote, at length, that the "cannot disable an
 * occupied stage" rule lived in the application rather than the database
 * because moving it meant revoking a column and rewriting a passing test,
 * which was "M7's argument to have with the whole settings screen in front of
 * it". M7 had the argument. `0007_stage_settings.sql` takes `is_enabled` and
 * `position` out of the client's UPDATE grant and puts the two rules that
 * matter into two SQL functions:
 *
 * - `set_stage_enabled(stage, enabled)` refuses a stage holding non-archived
 *   videos (`occupied:<n>`), refuses switching off the Idea stage (capture
 *   must always have a column to land in — 0008) and the last enabled stage;
 * - `reorder_stages(channel, ids)` writes the whole order in ONE statement —
 *   the `unique (channel_id, position)` is deferrable precisely so that a swap
 *   can pass through a colliding intermediate state — and refuses a core
 *   stage carried across another core stage.
 *
 * So the read-then-write race M4 documented is gone (the count and the write
 * are one transaction), and a client that PATCHes the columns directly gets a
 * 42501 from the grant rather than a quiet success. `supabase/tests/35_stage_settings.test.sql`
 * is the proof; `e2e/settings-stages.spec.ts` posts the forged requests from
 * a real browser session.
 *
 * ## What stays a plain table write, and why
 *
 * Renaming and adding. A name is a label — behaviour binds to `kind`, which no
 * client can write, and to `CORE_KIND_ORDER` in code — so the only thing a
 * rename can break is legibility, and `StageNameSchema` plus the blank-name
 * CHECK cover that. Adding a stage is an insert with `kind = null`, which is
 * what makes it inert: `move_video` gives a null kind order 0 (no gate),
 * `nextStageAfter()` skips it, the WIP warning ignores it, and the board draws
 * it like any other column. The insert policy and the partial unique on
 * `(channel_id, kind)` mean a client cannot use the same insert to conjure a
 * second Packaging.
 *
 * ## Every action reads the stage first, through RLS
 *
 * Another user's stage id reads as no row, which is deliberately the same
 * answer as an id that was never issued. The channel's slug comes from the
 * same read, for `revalidatePath` and for the link a refusal carries — never
 * from the caller.
 */

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

type Supabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

interface StageRead {
  readonly id: string;
  readonly channelId: string;
  readonly channelSlug: string;
  readonly name: string;
  readonly kind: StageKind | null;
  readonly position: number;
  readonly isEnabled: boolean;
}

/** One stage and the slug of its channel, or null when RLS shows nothing. */
async function readStage(
  supabase: Supabase,
  stageId: string,
): Promise<StageRead | { error: string } | null> {
  const { data: stage, error } = await supabase
    .from("stages")
    .select("id, channel_id, name, kind, position, is_enabled")
    .eq("id", stageId)
    .maybeSingle();

  if (error) return { error: `Could not read that stage: ${error.message}` };
  if (!stage) return null;

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", stage.channel_id)
    .maybeSingle();

  return {
    id: stage.id,
    channelId: stage.channel_id,
    // A stage whose channel cannot be read is not a state RLS produces (the
    // composite FK ties the two to one user), so "" only ever means a read
    // failure, and a link to `/c//board` is a 404 rather than a wrong channel.
    channelSlug: channel?.slug ?? "",
    name: stage.name,
    kind: isStageKind(stage.kind) ? stage.kind : null,
    position: stage.position,
    isEnabled: stage.is_enabled,
  };
}

/** The channel's stages, in display order — enabled or not. */
async function readOrder(
  supabase: Supabase,
  channelId: string,
): Promise<
  | { stages: { id: string; name: string; kind: StageKind | null; position: number }[] }
  | { error: string }
> {
  const { data, error } = await supabase
    .from("stages")
    .select("id, name, kind, position")
    .eq("channel_id", channelId)
    .order("position", { ascending: true });

  if (error) return { error: `Could not read this channel's stages: ${error.message}` };
  return {
    stages: (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      kind: isStageKind(row.kind) ? row.kind : null,
      position: row.position,
    })),
  };
}

/**
 * Everything that draws a stage's name or set: the board's columns, the idea
 * bank's promote target, `/now`'s rows and "move to", the calendar's chips,
 * the video page's stage select, and this settings screen itself.
 */
function revalidateStageViews(slug: string): void {
  if (slug !== "") {
    revalidatePath(`/c/${slug}/board`);
    revalidatePath(`/c/${slug}/ideas`);
  }
  revalidatePath("/now");
  revalidatePath("/calendar");
  revalidatePath("/settings/stages/[slug]", "page");
  revalidatePath("/videos/[id]", "page");
}

const GONE = "That stage does not exist any more.";

/* -------------------------------------------------------------------------- */
/* Rename                                                                      */
/* -------------------------------------------------------------------------- */

const RenameInput = z.object({
  stageId: z.uuid(),
  name: StageNameSchema,
});

export type RenameStageInput = z.input<typeof RenameInput>;

export type RenameStageResult =
  | { ok: true; stageId: string; name: string }
  | { ok: false; error: string };

/**
 * Change the label. Only the label: the row's `kind` is not in any client
 * grant, so this cannot become a way to relabel behaviour, and nothing in the
 * app compares names.
 */
export async function renameStage(
  input: RenameStageInput,
): Promise<RenameStageResult> {
  const parsed = RenameInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { stageId, name } = parsed.data;

  const { supabase } = await requireUser();

  const stage = await readStage(supabase, stageId);
  if (stage === null) return { ok: false, error: GONE };
  if ("error" in stage) return { ok: false, error: stage.error };

  if (name === stage.name) return { ok: true, stageId, name };

  const order = await readOrder(supabase, stage.channelId);
  if ("error" in order) return { ok: false, error: order.error };
  if (nameTaken(name, order.stages.filter((other) => other.id !== stageId))) {
    return {
      ok: false,
      error: `This channel already has a stage called “${name}”. Two columns with one heading is a board nobody can navigate by name.`,
    };
  }

  const { data, error } = await supabase
    .from("stages")
    .update({ name })
    .eq("id", stageId)
    .select("id, name")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error:
        error.code === "23514"
          ? "A stage needs a name."
          : `That did not save: ${error.message}`,
    };
  }
  if (!data) return { ok: false, error: GONE };

  revalidateStageViews(stage.channelSlug);
  return { ok: true, stageId: data.id, name: data.name };
}

/* -------------------------------------------------------------------------- */
/* Move                                                                        */
/* -------------------------------------------------------------------------- */

const MoveInput = z.object({
  stageId: z.uuid(),
  direction: z.enum(["up", "down"]),
});

export type MoveStageInput = z.input<typeof MoveInput>;

export type MoveStageResult =
  | {
      ok: true;
      /** The channel's whole order as the database now holds it. */
      order: { id: string; position: number }[];
    }
  | { ok: false; error: string };

/**
 * One step up or down the board.
 *
 * The step is checked here with `canMove` — the same function that decides
 * which arrows the screen draws, so a refusal from this action is only ever
 * reached by a forged request — and then the whole order is handed to
 * `reorder_stages`, which checks it again and writes it in one statement. Two
 * checks are not belt and braces for their own sake: the first one gives a
 * sentence naming the pair, the second one is the one that cannot be skipped.
 */
export async function moveStage(
  input: MoveStageInput,
): Promise<MoveStageResult> {
  const parsed = MoveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a move this page could ask for." };
  }
  const { stageId } = parsed.data;
  const direction: MoveDirection = parsed.data.direction;

  const { supabase } = await requireUser();

  const stage = await readStage(supabase, stageId);
  if (stage === null) return { ok: false, error: GONE };
  if ("error" in stage) return { ok: false, error: stage.error };

  const order = await readOrder(supabase, stage.channelId);
  if ("error" in order) return { ok: false, error: order.error };

  const index = order.stages.findIndex((other) => other.id === stageId);
  const verdict = canMove(order.stages, index, direction);
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  const next = moved(order.stages, index, direction);
  if (next === null) return { ok: false, error: "Nothing to swap with." };

  const { data, error } = await supabase.rpc("reorder_stages", {
    p_channel: stage.channelId,
    p_stage_ids: next.map((other) => other.id),
  });

  if (error) {
    const crossing = readCoreOrderRefusal(error.message);
    return {
      ok: false,
      error: crossing ?? `That move was refused: ${error.message}`,
    };
  }

  revalidateStageViews(stage.channelSlug);
  return {
    ok: true,
    order: (data ?? []).map((row) => ({ id: row.id, position: row.position })),
  };
}

/* -------------------------------------------------------------------------- */
/* On / off                                                                    */
/* -------------------------------------------------------------------------- */

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
      /** Where those videos are — the board column, or the bank for Idea. */
      occupiedHref?: string;
    };

/**
 * Switch a stage on or off.
 *
 * Off means: no column on the board, not offered in the stage select, skipped
 * by "move to next stage", and `move_video` refuses it as a destination. It
 * does **not** mean the videos in it go anywhere — which is why the function
 * refuses when there are any. The refusal carries the count and a link, so it
 * is something to act on rather than a wall.
 */
export async function setStageEnabled(
  input: SetStageEnabledInput,
): Promise<SetStageEnabledResult> {
  const parsed = SetStageEnabledInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a stage this page could ask about." };
  }
  const { stageId, enabled } = parsed.data;

  const { supabase } = await requireUser();

  const stage = await readStage(supabase, stageId);
  if (stage === null) return { ok: false, error: GONE };
  if ("error" in stage) return { ok: false, error: stage.error };

  const { data, error } = await supabase.rpc("set_stage_enabled", {
    p_stage: stageId,
    p_enabled: enabled,
  });

  if (error) {
    const occupied = readOccupied(error.message);
    if (occupied !== null) {
      return {
        ok: false,
        occupied,
        occupiedHref: occupiedHref(stage.kind, stage.channelSlug),
        error: occupiedSentence(stage.name, occupied),
      };
    }
    if (isIdeaStageRefusal(error.message)) {
      return { ok: false, error: ideaStaysOnSentence(stage.name) };
    }
    if (/last enabled stage/.test(error.message)) {
      return {
        ok: false,
        error: `${stage.name} is the only stage still switched on. A channel needs at least one column — switch another on first.`,
      };
    }
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) return { ok: false, error: GONE };

  revalidateStageViews(stage.channelSlug);
  return {
    ok: true,
    stageId: data.id,
    stageName: data.name,
    enabled: data.is_enabled,
  };
}

/* -------------------------------------------------------------------------- */
/* Add                                                                         */
/* -------------------------------------------------------------------------- */

const AddInput = z.object({
  channelId: z.uuid(),
  name: StageNameSchema,
});

export type AddStageInput = z.input<typeof AddInput>;

export type AddStageResult =
  | {
      ok: true;
      stage: {
        id: string;
        name: string;
        kind: null;
        position: number;
        isEnabled: boolean;
      };
    }
  | { ok: false; error: string };

/**
 * Add an inert stage at the end of the board. `kind` is never taken from the
 * caller: it is null here and only here, and that null is the whole of what
 * makes the stage carry no behaviour. Moving it to where it belongs is the
 * arrows' job, one step at a time, and an inert stage may go anywhere.
 *
 * Two adds racing can compute the same `max + 1`; the deferred unique refuses
 * the second at commit and the insert is retried once with a fresh read.
 */
export async function addStage(input: AddStageInput): Promise<AddStageResult> {
  const parsed = AddInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { channelId, name } = parsed.data;

  const { supabase } = await requireUser();

  const { data: channel } = await supabase
    .from("channels")
    .select("id, slug")
    .eq("id", channelId)
    .maybeSingle();
  if (!channel) return { ok: false, error: "That channel does not exist any more." };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const order = await readOrder(supabase, channelId);
    if ("error" in order) return { ok: false, error: order.error };

    if (nameTaken(name, order.stages)) {
      return {
        ok: false,
        error: `This channel already has a stage called “${name}”.`,
      };
    }

    const position =
      order.stages.length === 0
        ? 1
        : Math.max(...order.stages.map((stage) => stage.position)) + 1;

    // `kind` and `is_enabled` are not named: neither is in the client's
    // INSERT grant (0008), so the row is inert and on by construction.
    const { data, error } = await supabase
      .from("stages")
      .insert({ channel_id: channelId, name, position })
      .select("id, name, position, is_enabled")
      .maybeSingle();

    if (error) {
      // 23505: the position was taken between the read and the write.
      if (error.code === "23505" && attempt === 0) continue;
      return { ok: false, error: `That did not save: ${error.message}` };
    }
    if (!data) return { ok: false, error: "The stage was not created. Reload and try again." };

    revalidateStageViews(channel.slug);
    return {
      ok: true,
      stage: {
        id: data.id,
        name: data.name,
        kind: null,
        position: data.position,
        isEnabled: data.is_enabled,
      },
    };
  }

  return { ok: false, error: "The stage was not created. Reload and try again." };
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                      */
/* -------------------------------------------------------------------------- */

const RemoveInput = z.object({ stageId: z.uuid() });

export type RemoveStageInput = z.input<typeof RemoveInput>;

export type RemoveStageResult =
  | { ok: true; stageId: string }
  | { ok: false; error: string; occupied?: number; occupiedHref?: string };

/**
 * Delete an inert stage that nothing refers to.
 *
 * Core stages are never deleted — the delete policy is `kind is null`, so the
 * refusal below is the sentence for a request the database would answer with
 * zero rows anyway. An inert stage that holds videos, archived ones included,
 * is refused here by count and by `videos.stage_id`'s `no action` FK; one that
 * videos have *passed through* still has `checklist_items` naming it, and that
 * FK is `no action` too, so the delete fails at the database and the message
 * says to switch it off instead. Off is always available; gone is only for a
 * stage that was a mistake.
 */
export async function removeStage(
  input: RemoveStageInput,
): Promise<RemoveStageResult> {
  const parsed = RemoveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a stage this page could ask about." };
  }
  const { stageId } = parsed.data;

  const { supabase } = await requireUser();

  const stage = await readStage(supabase, stageId);
  if (stage === null) return { ok: false, error: GONE };
  if ("error" in stage) return { ok: false, error: stage.error };

  if (stage.kind !== null) {
    return {
      ok: false,
      error: `${stage.name} is a core stage: it can be renamed or switched off, never removed.`,
    };
  }

  const { count, error: countError } = await supabase
    .from("videos")
    .select("id", { count: "exact", head: true })
    .eq("stage_id", stageId);

  if (countError) {
    return { ok: false, error: `Could not check what is in ${stage.name}: ${countError.message}` };
  }
  if ((count ?? 0) > 0) {
    const n = count ?? 0;
    return {
      ok: false,
      occupied: n,
      occupiedHref: occupiedHref(null, stage.channelSlug),
      error: `${stage.name} still holds ${n === 1 ? "a video" : `${n} videos`}, archived ones included. Move ${n === 1 ? "it" : "them"} elsewhere first, or switch the stage off instead.`,
    };
  }

  const { data, error } = await supabase
    .from("stages")
    .delete()
    .eq("id", stageId)
    .select("id")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error:
        error.code === "23503"
          ? `Videos have passed through ${stage.name}, so it keeps their checklist history and cannot be removed. Switch it off instead.`
          : `That did not remove: ${error.message}`,
    };
  }
  if (!data) return { ok: false, error: GONE };

  revalidateStageViews(stage.channelSlug);
  return { ok: true, stageId: data.id };
}
