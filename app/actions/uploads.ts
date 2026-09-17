"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  conceptSketchPath,
  parseConceptSketchPath,
  removeSketches,
} from "@/lib/storage";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * `recordConceptSketch` — the server half of an upload.
 *
 * The browser has already put the bytes in Storage by the time this runs
 * (PLAN.md warning 1: a server action is a request body, and Vercel caps those
 * at 4.5 MB, so images must never pass through one). All that is left is the
 * bookkeeping only the server can do: point `videos.thumbnail_concept_path` at
 * the object, and clean up the object the row used to point at.
 *
 * It takes a path, not a file. That is the entire contract.
 */

const RecordInput = z.object({
  videoId: z.uuid(),
  /**
   * The object name the browser uploaded to. Checked against the convention
   * below rather than trusted: this action can only ever be made to write a
   * path of the shape `{caller}/{that video}/concept.{known ext}`, so the worst
   * a forged call can do is point a video at an object the caller already owns.
   * The actual boundary is the storage policy — see `lib/storage.ts`.
   */
  path: z.string().max(200),
});

export type RecordConceptSketchInput = z.input<typeof RecordInput>;

export type RecordConceptSketchResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export async function recordConceptSketch(
  input: RecordConceptSketchInput,
): Promise<RecordConceptSketchResult> {
  const parsed = RecordInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That upload was not something the app asked for." };
  }
  const { videoId, path } = parsed.data;

  const { supabase, user } = await requireUser();

  // The path must be *this* caller's, for *this* video, with an extension the
  // app knows how to produce. Anything else is a bug or a forgery; either way
  // the row should not be made to point at it.
  const pieces = parseConceptSketchPath(path);
  if (
    !pieces ||
    pieces.userId !== user.id ||
    pieces.videoId !== videoId ||
    conceptSketchPath(pieces.userId, pieces.videoId, pieces.extension) !== path
  ) {
    return { ok: false, error: "That is not this video's sketch path." };
  }

  // RLS scopes this read, so someone else's video is indistinguishable from one
  // that does not exist — the same 404-shaped answer the detail page gives.
  const { data: video, error: readError } = await supabase
    .from("videos")
    .select("id, channel_id, thumbnail_concept_path")
    .eq("id", videoId)
    .maybeSingle();

  if (readError) {
    return { ok: false, error: `Could not save that: ${readError.message}` };
  }
  if (!video) {
    return { ok: false, error: "That video does not exist any more." };
  }

  const previous = video.thumbnail_concept_path;

  // The stable path means a re-upload of the same *format* has already replaced
  // the old object in place (`upsert: true`), and there is nothing to remove. A
  // different format is a different object name, so the old one would sit in
  // the bucket forever with nothing referencing it.
  //
  // PLAN.md says to remove it *before* updating the row, and that order is kept
  // here. It is the safer of the two failure modes by a small margin: if the
  // delete succeeds and the update then fails, the row points at an object that
  // no longer exists, which every read path already degrades to "no sketch"
  // over — whereas updating first and failing to delete leaves an invisible
  // orphan that nothing will ever clean up.
  if (previous && previous !== path) {
    await removeSketches(supabase, [previous]);
  }

  const { error: updateError } = await supabase
    .from("videos")
    .update({ thumbnail_concept_path: path, updated_at: new Date().toISOString() })
    .eq("id", videoId);

  if (updateError) {
    return {
      ok: false,
      error: `The image uploaded, but the video did not keep it: ${updateError.message}`,
    };
  }

  revalidatePath(`/videos/${videoId}`);

  // The board shows the same sketch on the card. One more read to learn which
  // board: `videos` reaches `channels` through a composite FK, and a PostgREST
  // embed across it is more machinery than a select by id.
  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", video.channel_id)
    .maybeSingle();

  if (channel) {
    revalidatePath(`/c/${channel.slug}/board`);
  }

  return { ok: true, path };
}
