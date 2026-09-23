"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  describeThumbnailShortfall,
  listGateFields,
  packagingGate,
  readGateField,
  readHooks,
  type GateField,
} from "@/lib/packaging";
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
      /**
       * The `updated_at` this move stamped.
       *
       * `move_video` writes the row like anything else, so the detail page's
       * version token has to learn about it — otherwise moving a video from the
       * stage select would make every later packaging save on the same page
       * look like a conflict. See `components/video-version.tsx`.
       */
      updatedAt: string | null;
      /**
       * A non-blocking remark about the move that just happened, or null.
       *
       * Today there is exactly one: PLAN.md's *Publish Prep → Scheduled with
       * < 3 thumbnail paths is a soft warning only*. It rides on the **ok**
       * result on purpose — the move succeeded, and a warning that arrived as
       * a refusal would be the hard gate PLAN.md says this must not be.
       */
      notice: string | null;
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
   * What to stamp `published_at` with, when this move is the one that reaches a
   * Published stage. Absent means `now()`, which is what a drag on the board
   * means.
   *
   * `/now`'s "Confirm live + record URL" row passes the video's own
   * `target_publish_date` here, because PLAN.md's ranking rule 5 says so:
   * *`confirmLive` = `move_video(published, p_published_at = target date)` +
   * URL*. The video went live when YouTube said it would, not when the creator
   * got round to ticking the row — and `published_at + 24h` is what rule 2 then
   * counts from, so getting this wrong would make the metrics prompt a day late.
   *
   * `move_video` only reads it on **first** entry to a Published stage
   * (`when v_stage.kind = 'published' and v.published_at is null`), so it can
   * never rewrite a date that is already recorded.
   */
  publishedAt: z.iso.datetime({ offset: true }).optional(),
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
 * What this channel calls its packaging-kind stage: the label a rename may
 * have changed. Read from the target stage's channel — the refusal path only,
 * so two small reads are fine. Falls back to the seed's word.
 */
async function packagingName(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  targetStageId: string,
): Promise<string> {
  const { data: target } = await supabase
    .from("stages")
    .select("channel_id")
    .eq("id", targetStageId)
    .maybeSingle();
  if (!target) return "Packaging";
  const { data: packaging } = await supabase
    .from("stages")
    .select("name")
    .eq("channel_id", target.channel_id)
    .eq("kind", "packaging")
    .maybeSingle();
  return packaging?.name ?? "Packaging";
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
    ...(parsed.data.publishedAt === undefined
      ? {}
      : { p_published_at: parsed.data.publishedAt }),
  });

  if (error) {
    const missing = readGateField(error.message);
    if (missing) {
      /*
        `move_video` names the first missing field only. The row is read back
        so the sentence can name every one — a person missing the concept and
        the hook used to be refused twice, learning about the hook only after
        fixing the concept (M9 review). `missing` stays the first: it is the
        field the "Fix packaging" link lands on. If the read fails, or the row
        changed in between, the database's one field is the sentence.
      */
      const { data: row } = await supabase
        .from("videos")
        .select("title, thumbnail_concept, hooks, packaging_skipped_at")
        .eq("id", parsed.data.videoId)
        .maybeSingle();
      const status = row
        ? packagingGate({
            title: row.title,
            thumbnailConcept: row.thumbnail_concept,
            hooks: readHooks(row.hooks),
            packagingSkippedAt: row.packaging_skipped_at,
          })
        : null;
      const fields =
        status && !status.ready && status.allMissing.includes(missing)
          ? status.allMissing
          : [missing];
      return {
        ok: false,
        missing,
        // The field is named, which is the whole point of the gate refusal —
        // and the stage is named by the channel's own label for it, because
        // the toast goes on to say which column the video is still in, and
        // "Packaging still needs … It is still in Grue" is two names for one
        // column (M7's review).
        message: `${await packagingName(supabase, parsed.data.stageId)} still needs ${listGateFields(fields)}.`,
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

  /*
    The soft warning. `move_video` returns the whole row, so the three path
    columns are already here; the only thing missing is the destination's kind,
    and that read is skipped entirely when all three variants exist, because
    then there is nothing to warn about whatever the stage is.
  */
  let notice: string | null = null;
  const ready = [
    data.thumb_wild_card_path,
    data.thumb_moderate_path,
    data.thumb_safe_path,
  ].filter((path) => path !== null).length;

  if (ready < 3) {
    const { data: stage } = await supabase
      .from("stages")
      .select("kind")
      .eq("id", parsed.data.stageId)
      .maybeSingle();
    if (stage?.kind === "scheduled") notice = describeThumbnailShortfall(ready);
  }

  return {
    ok: true,
    videoId: data.id,
    stageId: data.stage_id,
    stageEnteredAt: data.stage_entered_at,
    updatedAt: data.updated_at,
    notice,
  };
}
