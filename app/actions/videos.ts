"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/supabase/require-user";

/**
 * Video server actions. M1 owns exactly one of them: `captureVideo`.
 *
 * `updateVideo`, `moveVideo` and the rest of PLAN.md's list land with the
 * milestones that need them; nothing here should grow into a general "save a
 * video" endpoint.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/** How many tags one capture may carry, and how long each may be. */
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_TITLE_LENGTH = 300;

/**
 * A single-line value from the form: trimmed, and `undefined` when it is empty.
 *
 * Capture's disclosure fields are optional, and an empty box must leave the
 * column NULL rather than writing `''` — `/now` and the idea bank both test
 * these for "is there anything here".
 */
const OptionalText = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value === "" ? undefined : value));

/**
 * The comma-separated tag box. `"tutorial, behind the scenes,,tutorial"` →
 * `["tutorial", "behind the scenes"]`.
 */
const Tags = z
  .string()
  .transform((value) =>
    Array.from(
      new Set(
        value
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ""),
      ),
    ),
  )
  .refine((tags) => tags.length <= MAX_TAGS, {
    message: `Keep it to ${MAX_TAGS} tags or fewer.`,
  })
  .refine((tags) => tags.every((tag) => tag.length <= MAX_TAG_LENGTH), {
    message: `Each tag has to be ${MAX_TAG_LENGTH} characters or fewer.`,
  });

/**
 * The capture payload.
 *
 * The title is trimmed *before* `min(1)`, so "   " is refused here — in the
 * browser, before any network call — rather than becoming a blank idea. That is
 * the one validation rule this action really has to get right: `capture_video`
 * itself defaults the title to `''` quite happily.
 */
const CaptureInput = z.object({
  channelId: z.uuid("Pick a channel to capture into."),
  title: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, "Give the idea a title — anything you will recognise later.")
        .max(
          MAX_TITLE_LENGTH,
          `Titles are capped at ${MAX_TITLE_LENGTH} characters here; the real one gets written in packaging.`,
        ),
    ),
  oneLineHook: OptionalText.optional(),
  notes: OptionalText.optional(),
  tags: Tags.optional(),
});

export type CaptureVideoInput = z.input<typeof CaptureInput>;

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the form renders. `null` before the first submit.
 *
 * A success carries the id and the channel it landed in, so the capture UI can
 * say *where* the idea went (the channel can be retargeted with `1..9`, and a
 * silent "Saved" would not tell you whether it worked) and remember it as the
 * last-used channel.
 */
export type CaptureState =
  | { ok: true; id: string; title: string; channelId: string; channelName: string }
  | { ok: false; error: string }
  | null;

/* -------------------------------------------------------------------------- */
/* The action                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Capture an idea.
 *
 * `capture_video(p_channel, p_title)` is the only way a client creates a video
 * — `INSERT` on `videos` is revoked — and it always lands the row in the
 * channel's Idea stage, which is what capture means. The disclosure fields
 * (hook, notes, tags) are a follow-up `UPDATE` on the row it returns: those
 * columns are in the client's `UPDATE` grant, and none of them is a field the
 * gate or the stage machinery cares about.
 *
 * Two round trips, not one, and deliberately so: adding four more parameters to
 * `capture_video` would put the idea-bank fields inside a security-definer
 * function that exists to enforce one thing. If the update fails the idea still
 * exists — capture never loses the title, which is the whole point of it — and
 * the message says which half worked.
 */
export async function captureVideo(input: CaptureVideoInput): Promise<CaptureState> {
  const parsed = CaptureInput.safeParse(input);
  if (!parsed.success) {
    // One message, the first one: the form has a single error line.
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { channelId, title, oneLineHook, notes, tags } = parsed.data;

  const { supabase } = await requireUser();

  // Also the ownership check: RLS scopes this to the signed-in user, so a
  // channel belonging to someone else reads as "no such channel". The name is
  // for the confirmation message, the slug for the revalidation below.
  const { data: channel } = await supabase
    .from("channels")
    .select("id, name, slug")
    .eq("id", channelId)
    .maybeSingle();

  if (!channel) {
    return { ok: false, error: "That channel does not exist any more." };
  }

  const { data: video, error } = await supabase.rpc("capture_video", {
    p_channel: channel.id,
    p_title: title,
  });

  if (error || !video) {
    return {
      ok: false,
      error: `Could not capture that: ${error?.message ?? "the database returned no row."}`,
    };
  }

  const extras = {
    ...(oneLineHook === undefined ? {} : { one_line_hook: oneLineHook }),
    ...(notes === undefined ? {} : { notes }),
    ...(tags === undefined || tags.length === 0 ? {} : { tags }),
  };

  if (Object.keys(extras).length > 0) {
    const { error: updateError } = await supabase
      .from("videos")
      .update({ ...extras, updated_at: new Date().toISOString() })
      .eq("id", video.id);

    if (updateError) {
      return {
        ok: false,
        error: `Saved "${title}", but the extra fields did not stick: ${updateError.message}`,
      };
    }
  }

  // The board is the page that grows a card. `/capture` and the modal both read
  // only the channel list, which this does not change. `/c/[slug]/ideas` is M5;
  // it will be revalidated by the same call once the route exists.
  revalidatePath(`/c/${channel.slug}/board`);

  return {
    ok: true,
    id: video.id,
    title: video.title,
    channelId: channel.id,
    channelName: channel.name,
  };
}

/**
 * `useActionState` wrapper. The form posts `FormData`; everything arrives as a
 * string or not at all.
 */
export async function captureVideoAction(
  _prevState: CaptureState,
  formData: FormData,
): Promise<CaptureState> {
  const field = (name: string): string | undefined => {
    const value = formData.get(name);
    return typeof value === "string" ? value : undefined;
  };

  return captureVideo({
    channelId: field("channelId") ?? "",
    title: field("title") ?? "",
    oneLineHook: field("oneLineHook"),
    notes: field("notes"),
    tags: field("tags"),
  });
}
