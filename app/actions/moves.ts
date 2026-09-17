"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { GATE_WORDING, type GateField } from "@/lib/packaging";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * `moveVideo` — the single client-facing path for changing a video's stage.
 *
 * It is a thin wrapper over the `move_video(p_video, p_stage)` RPC and it
 * deliberately adds no rules of its own. `UPDATE (stage_id, stage_entered_at,
 * published_at, shipped_role)` is revoked from `authenticated`
 * (`0001_init.sql`), so there is no second path to guard: the gate, the
 * cross-channel refusal, the disabled-stage refusal, the `stage_entered_at`
 * stamp, the checklist snapshot and the script fill all happen inside the
 * function, in one transaction, as the database sees it.
 *
 * What this file *does* own is turning the function's `raise exception` into
 * something a human reads. `move_video` raises `gate:<field>` with the field
 * name it stopped on, so a refusal can say which of the three packaging fields
 * is missing rather than "could not move".
 *
 * Drag and drop and the `[` / `]` shortcuts both call this, so they cannot
 * disagree about the gate.
 */

/**
 * The three fields the TTH gate checks, in the order `move_video` checks them.
 * Re-exported so the board keeps importing it from here; the definition itself
 * lives with the predicate in `lib/packaging.ts`.
 */
export type { GateField };

export type MoveVideoResult =
  | {
      ok: true;
      videoId: string;
      /** The stage the row actually ended up in, read back from the function. */
      stageId: string;
      /** The fresh `stage_entered_at` stamp, so the card can show "0 days". */
      stageEnteredAt: string;
    }
  | {
      ok: false;
      /** Set when the refusal was the packaging gate; null for anything else. */
      missing: GateField | null;
      /** One sentence, naming the missing field when there is one. */
      message: string;
    };

const MoveInput = z.object({
  videoId: z.uuid(),
  stageId: z.uuid(),
  /**
   * Only ever used to revalidate the right board path. It is never trusted as
   * an authorisation input — RLS and `move_video`'s own ownership check decide
   * that — but it lands in `revalidatePath`, so it is pinned to the shape
   * `slugify()` produces.
   */
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "not a channel slug"),
});

export type MoveVideoInput = z.input<typeof MoveInput>;

/*
 * How each gate field reads in a sentence — `GATE_WORDING` in
 * `lib/packaging.ts`, imported rather than repeated.
 *
 * `thumbnail_concept` is the *written* concept (BRIEF.md principle 2: the
 * concept is locked at the TTH stage so the right shots get filmed; the image
 * files come much later). The detail page's upload is a reference sketch and
 * satisfies nothing, so the refusal says which of the two it means — a card
 * that visibly carries a sketch being refused for "a thumbnail concept" is the
 * one refusal a person cannot act on.
 *
 * M2's packaging block shows the same decision as a live indicator on the
 * detail page, so the two wordings have to be one wording: the board's refusal
 * and the page's indicator are describing the same row, and two phrasings for
 * it is exactly how "the sketch is the concept" got believed the first time.
 */

/**
 * `move_video` raises `gate:title`, `gate:thumbnail_concept` or `gate:hook`.
 * PostgREST hands that back as the error message, sometimes with its own
 * prefix, so this matches rather than compares.
 */
function readGateField(message: string): GateField | null {
  const match = /gate:(title|thumbnail_concept|hook)/.exec(message);
  return match ? (match[1] as GateField) : null;
}

export async function moveVideo(
  input: MoveVideoInput,
): Promise<MoveVideoResult> {
  const parsed = MoveInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      missing: null,
      message: "That move was not something the board could ask for.",
    };
  }

  const { supabase } = await requireUser();

  const { data, error } = await supabase.rpc("move_video", {
    p_video: parsed.data.videoId,
    p_stage: parsed.data.stageId,
  });

  if (error) {
    const missing = readGateField(error.message);
    if (missing) {
      return {
        ok: false,
        missing,
        // The field is named, which is the whole point of the gate refusal.
        message: `Packaging still needs ${GATE_WORDING[missing]}.`,
      };
    }

    // Everything else `move_video` refuses: a stage in another channel, a
    // disabled stage, a row this user does not own. These are bugs or races,
    // not user errors, so the database's own wording is the most useful thing
    // to show.
    return {
      ok: false,
      missing: null,
      message: `The move was refused: ${error.message}`,
    };
  }

  if (!data) {
    return {
      ok: false,
      missing: null,
      message: "The move returned nothing. Reload the board.",
    };
  }

  // The board keeps its own copy of where the cards are so a move does not cost
  // a full reload; this keeps the server's copy honest for the next navigation,
  // a hard refresh, or another tab.
  revalidatePath(`/c/${parsed.data.slug}/board`);

  return {
    ok: true,
    videoId: data.id,
    stageId: data.stage_id,
    stageEnteredAt: data.stage_entered_at,
  };
}
