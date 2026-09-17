"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { Database } from "@/lib/database.types";
import {
  MAX_TITLE_LENGTH,
  readHooks,
  readTitleCandidates,
  type Hook,
  type TitleCandidate,
} from "@/lib/packaging";
import {
  CHANGED_ELSEWHERE,
  NullableText,
  VideoPatchSchema,
  type VideoPatchInput,
} from "@/lib/video-fields";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * Video server actions. There are two, and they are two because they do
 * genuinely different things:
 *
 * - `captureVideo` **creates** a video, through the `capture_video` RPC —
 *   `INSERT` on `videos` is revoked from clients, so there is no other way.
 * - `updateVideo` **changes** one, and is the single write path behind every
 *   field on `/videos/[id]`.
 *
 * Changing a *stage* is neither of them: it is `moveVideo` in
 * `app/actions/moves.ts`, over the `move_video` RPC, because the TTH gate lives
 * inside that function and the board's drag, the `[`/`]` keys and the detail
 * page's stage select must not be able to disagree about it.
 *
 * Every rule about what a field may contain lives in `lib/video-fields.ts` and
 * `lib/packaging.ts`. Nothing in this file hand-rolls a second copy.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/** How many tags one capture may carry, and how long each may be. */
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

/**
 * A single-line value from the capture form: trimmed, and `undefined` when it
 * is empty, so the key is simply left out of the follow-up update.
 *
 * The trim-then-empty-is-nothing rule is `NullableText` from
 * `lib/video-fields.ts` — the same rule the detail page writes these columns
 * with — with `null` mapped to "do not send this key at all".
 */
const OptionalText = NullableText.transform((value) => value ?? undefined);

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

/* -------------------------------------------------------------------------- */
/* The detail page's one write path                                            */
/* -------------------------------------------------------------------------- */

/**
 * `updateVideo` — everything `/videos/[id]` can change about a video.
 *
 * ## One action, not five
 *
 * M2's two halves arrived with three actions between them (`updateWorkingTitle`
 * from M1's stub, a packaging patch, a flow patch) plus a fourth for archiving.
 * They shared the ownership check, the `updated_at` stamp and both
 * revalidations, and differed in every detail of how they reported a refusal.
 * This is the merged one. Every field on the page is a key in one patch,
 * validated by one schema (`lib/video-fields.ts`), and only the keys that are
 * present are written — so a blurred notes box still costs exactly one column.
 *
 * Some edits are genuinely more than one column and have to land together:
 * choosing a title candidate writes `title_candidates` *and* `title`, and a
 * skip writes `packaging_skipped_at` *and* `packaging_skip_reason` (a CHECK
 * pairs them). One patch is how they cannot land half-applied.
 *
 * ## Why it returns the whole row
 *
 * The live gate indicator has to agree with what `move_video` would decide, and
 * `move_video` reads the row — not the form. So the action reads the row back
 * after writing and hands the caller what is *stored*. A save that partially
 * failed, a value the database rewrote, a column changed in another tab: all of
 * them show up here rather than being believed. The flow fields get the same
 * treatment for the same reason, and `waiting_since` and `published_at` ride
 * along because two fields render from them.
 *
 * ## What it cannot do
 *
 * `stage_id` is not in its vocabulary. `UPDATE (stage_id, stage_entered_at,
 * published_at, shipped_role)` is revoked from `authenticated`, so `move_video`
 * — reached through `moveVideo` in `app/actions/moves.ts` — is the only path,
 * and the TTH gate cannot be walked around from the page where the packaging
 * fields live.
 */

/** Every column the detail page reads back, as the row holds it after a write. */
export interface VideoState {
  /* packaging — the four columns the gate reads, plus the skip pair */
  readonly title: string;
  readonly thumbnailConcept: string | null;
  readonly titleCandidates: TitleCandidate[];
  readonly hooks: Hook[];
  readonly packagingSkippedAt: string | null;
  readonly packagingSkipReason: string | null;
  /* flow */
  readonly targetPublishDate: string | null;
  readonly youtubeUrl: string | null;
  readonly publishedAt: string | null;
  readonly notes: string | null;
  readonly waitingOn: string | null;
  /** When `waiting_on` was first set; paired with it by a CHECK. */
  readonly waitingSince: string | null;
  readonly archivedAt: string | null;
  /**
   * The row's new version stamp. The page hands it back as the precondition on
   * its next write — see `components/video-version.tsx`.
   */
  readonly updatedAt: string | null;
}

export type UpdateVideoResult =
  | { ok: true; video: VideoState }
  | {
      ok: false;
      error: string;
      /**
       * The row was changed by something else between the page reading it and
       * this write. Nothing was written, and re-sending the same patch would
       * only overwrite the newer values — so the page offers a reload.
       */
      conflict?: boolean;
    };

/** The columns every write reads back. `channel_id` is for the revalidation. */
const VIDEO_COLUMNS =
  "channel_id, updated_at, title, thumbnail_concept, title_candidates, hooks, packaging_skipped_at, packaging_skip_reason, target_publish_date, youtube_url, published_at, notes, waiting_on, waiting_since, archived_at";

interface VideoRow {
  channel_id: string;
  updated_at: string | null;
  title: string;
  thumbnail_concept: string | null;
  title_candidates: unknown;
  hooks: unknown;
  packaging_skipped_at: string | null;
  packaging_skip_reason: string | null;
  target_publish_date: string | null;
  youtube_url: string | null;
  published_at: string | null;
  notes: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  archived_at: string | null;
}

/**
 * The row as the page reads it.
 *
 * The two jsonb columns go through the lenient readers in `lib/packaging.ts`:
 * a row written by the seed, by a future brainstorm import or by hand still has
 * to render. What they will not do is *repair* `chosen` — a row that really
 * carries two chosen hooks reads as two chosen hooks, so the indicator says
 * what the gate will say.
 *
 * Not exported: a `"use server"` module may only export async functions, and
 * Turbopack refuses the whole file otherwise ("Server Actions must be async
 * functions"), which takes every route down with it.
 */
function stateOf(row: VideoRow): VideoState {
  return {
    title: row.title,
    thumbnailConcept: row.thumbnail_concept,
    titleCandidates: readTitleCandidates(row.title_candidates),
    hooks: readHooks(row.hooks),
    packagingSkippedAt: row.packaging_skipped_at,
    packagingSkipReason: row.packaging_skip_reason,
    targetPublishDate: row.target_publish_date,
    youtubeUrl: row.youtube_url,
    publishedAt: row.published_at,
    notes: row.notes,
    waitingOn: row.waiting_on,
    waitingSince: row.waiting_since,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

export async function updateVideo(
  input: VideoPatchInput,
): Promise<UpdateVideoResult> {
  const parsed = VideoPatchSchema.safeParse(input);
  if (!parsed.success) {
    // The page shows one line, so the first issue is what it shows. The
    // messages in `lib/video-fields.ts` and `lib/packaging.ts` are written to
    // be that line — "Three hooks is the limit…", "That is not a link…".
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, expectedUpdatedAt, ...fields } = parsed.data;

  const { supabase } = await requireUser();

  // Typed against the generated `videos.Update`, so a column name that does not
  // exist is a compile error rather than a silent no-op PATCH.
  const patch: Database["public"]["Tables"]["videos"]["Update"] = {
    updated_at: new Date().toISOString(),
  };

  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.thumbnailConcept !== undefined) {
    patch.thumbnail_concept = fields.thumbnailConcept;
  }
  if (fields.titleCandidates !== undefined) {
    patch.title_candidates = fields.titleCandidates;
  }
  if (fields.hooks !== undefined) patch.hooks = fields.hooks;
  if (fields.packagingSkip !== undefined) {
    // Both columns, always together: the CHECK pairs them, and a skip whose
    // reason failed to write would be a skip nobody can explain later.
    patch.packaging_skipped_at =
      fields.packagingSkip === null ? null : new Date().toISOString();
    patch.packaging_skip_reason =
      fields.packagingSkip === null ? null : fields.packagingSkip.reason;
  }
  if (fields.targetPublishDate !== undefined) {
    patch.target_publish_date = fields.targetPublishDate;
  }
  if (fields.youtubeUrl !== undefined) patch.youtube_url = fields.youtubeUrl;
  if (fields.notes !== undefined) patch.notes = fields.notes;
  if (fields.archived !== undefined) {
    patch.archived_at = fields.archived ? new Date().toISOString() : null;
  }

  if (fields.waitingOn !== undefined) {
    patch.waiting_on = fields.waitingOn;

    if (fields.waitingOn === null) {
      // Cleared together, because the CHECK in `0004_waiting_since.sql` says
      // so: an unblocked video has no "since".
      patch.waiting_since = null;
    } else {
      // The stamp is *when the block started*, so re-wording it does not reset
      // the clock. Three weeks of waiting on the same editor stays three weeks
      // when "editor" becomes "editor's second pass" — that number is the whole
      // reason `/now` has a Waiting section. A block that was not there before
      // starts now.
      const { data: current } = await supabase
        .from("videos")
        .select("waiting_since")
        .eq("id", videoId)
        .maybeSingle();

      patch.waiting_since = current?.waiting_since ?? new Date().toISOString();
    }
  }

  /*
    RLS is the ownership check: another user's id updates zero rows, and the
    `select` on the way back returns nothing — which is what "no such video"
    looks like from here, and is deliberately indistinguishable from an id that
    was never issued.

    `expectedUpdatedAt` is the *other* way this can match nothing, and the
    reason it exists. Every patch this page sends carries absolute values
    computed against the row the editor was rendered with, so an unconditional
    write silently overwrites whatever a second tab did in between — including
    whole jsonb arrays. Matching on the version the caller computed against
    turns that into zero rows, which is reported rather than lost. `null` is a
    real expectation: `capture_video` leaves `updated_at` NULL, so a never-yet-
    written row has to be matched with `is` rather than `eq`.
  */
  let write = supabase.from("videos").update(patch).eq("id", videoId);
  if (expectedUpdatedAt !== undefined) {
    write =
      expectedUpdatedAt === null
        ? write.is("updated_at", null)
        : write.eq("updated_at", expectedUpdatedAt);
  }

  const { data, error } = await write
    .select(VIDEO_COLUMNS)
    .maybeSingle<VideoRow>();

  if (error) {
    // The database's own refusals reach the user as themselves: the hooks CHECK
    // (a fourth hook that somehow got past zod) and the skip-reason CHECK are
    // the two that can realistically fire, and both are worth seeing verbatim
    // rather than as "that did not save".
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) {
    /*
      Two different nothings. With a precondition, "zero rows" usually means the
      row is still there and has simply moved on — and telling someone their
      video does not exist any more when it does, and when what they typed is
      still on the screen in front of them, is the worst available answer. One
      extra read says which it was.
    */
    if (expectedUpdatedAt !== undefined) {
      const { data: still } = await supabase
        .from("videos")
        .select("id")
        .eq("id", videoId)
        .maybeSingle();

      if (still) {
        return { ok: false, error: CHANGED_ELSEWHERE, conflict: true };
      }
    }
    return { ok: false, error: "That video does not exist any more." };
  }

  /*
    The detail page and the video's board, in that order.

    Every field on the page is on one of the two: the card carries the title,
    the target date is the board's primary sort key, `waiting_on` is a chip,
    the skip is an amber badge, and archiving removes the card altogether. The
    slug is looked up rather than passed in, so a caller cannot aim a
    revalidation at a path it does not own.
  */
  revalidatePath(`/videos/${videoId}`);

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", data.channel_id)
    .maybeSingle();

  if (channel) {
    revalidatePath(`/c/${channel.slug}/board`);
  }

  return { ok: true, video: stateOf(data) };
}
