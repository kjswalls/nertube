"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  MAX_FILMING_DAY_VIDEOS,
  MAX_FILMING_NOTES_LENGTH,
  type FilmingDay,
} from "@/components/calendar/filming/types";
import { formatDateColumn, isDateColumn } from "@/lib/calendar-dates";
import { readFilmingDay } from "@/lib/filming-data";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * Filming days: the write path behind BRIEF.md principle 4.
 *
 * > *Batch filming. Filming is the only step needing a big time block. When 3+
 * > videos are sitting in Filming, that's a signal to schedule a batch day.*
 *
 * The board has been showing that signal as a sentence since M1. This file is
 * what turns it into a decision: one date, the videos it covers, and the words
 * "one creator, one camera" made structural by `unique (user_id, on_date)`.
 *
 * ## Why the table is user-level and these actions never take a channel
 *
 * `filming_days` has no `channel_id`, deliberately (PLAN.md: *user-level and
 * cross-channel — one creator, one camera*). A Saturday shoot covers whatever
 * is ready to shoot, and which channel each video is for is a fact about the
 * video, not about the day. So every action here is scoped by the user alone,
 * and a day gathers videos from every channel.
 *
 * ## The four writes, and why they are four
 *
 * - `createFilmingDay` — the day, plus the videos it starts with, because the
 *   board badge's whole point is that noticing and scheduling are one click.
 * - `linkVideosToFilmingDay` / `unlinkVideoFromFilmingDay` — one column on
 *   `videos`, from either end of the relationship. PLAN.md asks for linking to
 *   be quick *from the day and from a video*; both directions come through here
 *   rather than through `updateVideo`, so `filming_day_id` has exactly one
 *   write path and the "is there already a day on that date" question has
 *   exactly one answer.
 * - `updateFilmingDay` — the notes, and moving the shoot to another date.
 * - `deleteFilmingDay` — which does *not* touch `videos`: the composite foreign
 *   key is `on delete set null (filming_day_id)`, so the database unlinks them.
 *   Reimplementing that here would be a second opinion about what deleting a
 *   day means, and the one in the schema is the one that is true even when the
 *   row is deleted by hand.
 *
 * ## The duplicate date is a feature, not an error
 *
 * `unique (user_id, on_date)` is the constraint that makes a filming day *the*
 * Saturday rather than *a* Saturday. A second attempt on the same date is
 * therefore not a failure to report — it is the answer "you already have one,
 * here it is" — so `createFilmingDay` catches `23505`, reads the existing row
 * back and hands it to the caller with the videos it already covers. The dialog
 * then offers to add to it. Nobody is ever shown
 * `filming_days_user_id_on_date_key`.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A calendar day, as `<input type="date">` and a Postgres `date` column both
 * speak it. Validated through `lib/calendar-dates.ts` — the one place in this
 * app that decides what a date column is — so the 31st of February is refused
 * here rather than silently becoming the 3rd of March somewhere downstream.
 */
const DateColumnSchema = z
  .string()
  .refine(isDateColumn, "Pick a date for the shoot — a real one, day by day.");

/**
 * The notes box. Trimmed, and empty means NULL — the same rule every other
 * optional text column in this app is written with (`lib/video-fields.ts`), so
 * "no notes" is one value rather than two that look alike.
 */
const NotesSchema = z
  .string()
  .max(
    MAX_FILMING_NOTES_LENGTH,
    `Keep the shoot notes under ${MAX_FILMING_NOTES_LENGTH} characters.`,
  )
  .transform((value) => value.trim())
  .transform((value) => (value === "" ? null : value));

/**
 * The videos a write is about.
 *
 * Capped by `MAX_FILMING_DAY_VIDEOS`, because this is a list posted from a
 * browser and a server action is an HTTP endpoint like any other.
 *
 * The message **names the number**. M6's review drove the board badge with 57
 * videos in Filming and got "That is more videos than one day of filming." — a
 * refusal that says neither what the limit is nor how far over it you are, in
 * front of a dialog with no way to get under it. The dialog now ticks at most
 * this many by itself, so reaching this message takes deliberate ticking, and
 * when it happens it says what to do.
 */
const VideoIdsSchema = z
  .array(z.uuid("That is not a video id."))
  .max(
    MAX_FILMING_DAY_VIDEOS,
    `A filming day takes at most ${MAX_FILMING_DAY_VIDEOS} videos at a time. Untick some, or attach the rest afterwards.`,
  )
  // The same video twice is the same video.
  .transform((ids) => [...new Set(ids)]);

const CreateInput = z.object({
  onDate: DateColumnSchema,
  notes: NotesSchema.optional(),
  videoIds: VideoIdsSchema.optional(),
});

const LinkInput = z.object({
  dayId: z.uuid("That filming day does not exist any more."),
  videoIds: VideoIdsSchema,
});

const UnlinkInput = z.object({
  videoId: z.uuid("That is not a video id."),
  /**
   * The day the caller believes it is unlinking from.
   *
   * Optional, and a precondition when it is given: the calendar's own unlink
   * button knows which day it is drawn under, and a second tab that re-pointed
   * the video at another day in the meantime should not have that link quietly
   * removed by a click aimed at the old one. The video page has no such belief
   * — it unlinks "whatever day this video is on" — so it sends none.
   */
  dayId: z.uuid().optional(),
});

const UpdateInput = z.object({
  dayId: z.uuid("That filming day does not exist any more."),
  notes: NotesSchema.optional(),
  onDate: DateColumnSchema.optional(),
});

const DeleteInput = z.object({
  dayId: z.uuid("That filming day does not exist any more."),
});

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A filming day as every caller here reads it back — the same `FilmingDay` the
 * calendar renders, videos and all.
 *
 * Deliberately not a thinner "just the ids" shape. Every caller of these
 * actions is about to draw the day it just changed (the dialog shows what the
 * existing day already covers; the day panel redraws its own list after an
 * unlink), and handing back ids would make each of them do a second read with
 * its own idea of what a video on a day looks like.
 */
export type FilmingDayState = FilmingDay;

export type FilmingDayResult =
  | { ok: true; day: FilmingDayState; linked: number; warning?: string }
  /**
   * The date is taken. Not an error in the sense that something went wrong —
   * the day the caller asked for exists, and it is attached, so the dialog can
   * offer to add to it instead. See the file note.
   */
  | { ok: false; kind: "exists"; day: FilmingDayState; error: string }
  | { ok: false; kind: "error"; error: string };

export type FilmingDayWriteResult =
  | { ok: true; day: FilmingDayState; linked: number; warning?: string }
  | { ok: false; kind: "error" | "exists"; error: string };

/**
 * Detaching one video. `day` is the day it came off, re-read — or `null` when
 * the caller did not say which day it was (the video page's own button), which
 * is the honest answer rather than an empty object pretending to be a day.
 */
export type UnlinkResult =
  | { ok: true; day: FilmingDayState | null }
  | { ok: false; error: string };

export type DeleteFilmingDayResult =
  | { ok: true; unlinked: number; onDate: string }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                             */
/* -------------------------------------------------------------------------- */

/** Postgres' unique violation — here, always `(user_id, on_date)`. */
const UNIQUE_VIOLATION = "23505";
/** Postgres' foreign-key violation — here, always a day that is not there. */
const FK_VIOLATION = "23503";

/** The columns a day is read back with. */
const DAY_COLUMNS = "id, on_date, notes";

interface DayRow {
  id: string;
  on_date: string;
  notes: string | null;
}

/*
  Every write in this file ends with `readFilmingDay` — read back rather than
  assumed, for the reason `updateVideo` reads its row back: the caller is about
  to render this, and what is stored is the only version of it that is still
  true in another tab. It is `lib/filming-data.ts`'s reader, the same one the
  calendar page uses, so an action's answer and a page render cannot disagree
  about what a day covers.
*/

/**
 * Revalidate everything a link change is visible on: the calendar, each
 * video's own page, and the board of every channel those videos belong to.
 *
 * The slugs are looked up from the video ids rather than passed in, exactly as
 * `updateVideo` does it: a caller cannot then aim a revalidation at a path it
 * does not own, and a day that gathers three channels refreshes all three.
 */
async function revalidateFor(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  videoIds: readonly string[],
): Promise<void> {
  revalidatePath("/calendar");
  if (videoIds.length === 0) return;

  for (const id of videoIds) revalidatePath(`/videos/${id}`);

  const { data: videos } = await supabase
    .from("videos")
    .select("channel_id")
    .in("id", [...videoIds]);

  const channelIds = [...new Set((videos ?? []).map((v) => v.channel_id))];
  if (channelIds.length === 0) return;

  const { data: channels } = await supabase
    .from("channels")
    .select("slug")
    .in("id", channelIds);

  for (const channel of channels ?? []) {
    revalidatePath(`/c/${channel.slug}/board`);
  }
}

/**
 * Point videos at a day, and say how many actually moved.
 *
 * `in (...)` under RLS: another user's ids match no rows, which is the same
 * answer as an id that was never issued. The returned rows are the ones that
 * really changed, so the count the caller reports is a fact rather than the
 * length of the list it sent.
 */
async function link(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  dayId: string,
  videoIds: readonly string[],
): Promise<{ linked: string[]; movedFrom: number; error: string | null }> {
  if (videoIds.length === 0) return { linked: [], movedFrom: 0, error: null };

  /*
    How many of these were already on a *different* day.

    Read before the update, because afterwards there is nothing left to read:
    one column, overwritten. M6's review found that a re-book was completely
    silent — the previous shoot was emptied and neither the dialog, the toast
    nor the day panel said so. The dialog now leaves a booked video unticked,
    so this can only happen deliberately; this count is what lets the answer
    say it happened at all. A failed read yields zero rather than a wrong
    number: it is a sentence in a toast, not a precondition for the write.
  */
  const { data: before } = await supabase
    .from("videos")
    .select("id, filming_day_id")
    .in("id", [...videoIds]);

  const movedFrom = (before ?? []).filter(
    (row) => row.filming_day_id !== null && row.filming_day_id !== dayId,
  ).length;

  /*
    One column, and deliberately not `updated_at` with it.

    Every other write to `videos` in this app stamps `updated_at`, because that
    column is the detail page's optimistic-concurrency token and the board's
    recency key. Attaching a video to a filming day is neither of those things:
    bumping it would invalidate a half-typed packaging edit in another tab over
    a change that does not touch a single field of it, and would reshuffle the
    Idea column's "ten most recently updated" for a decision about a Saturday.
  */
  const { data, error } = await supabase
    .from("videos")
    .update({ filming_day_id: dayId })
    .in("id", [...videoIds])
    .select("id");

  if (error) {
    return {
      linked: [],
      movedFrom: 0,
      error:
        error.code === FK_VIOLATION
          ? "That filming day does not exist any more — reload the calendar."
          : `Those videos could not be attached: ${error.message}`,
    };
  }

  return { linked: (data ?? []).map((row) => row.id), movedFrom, error: null };
}

/**
 * "2 of these were on another day and have been moved off it."
 *
 * A move is never silent, whichever end asked for it. Returned as the result's
 * `warning`, which both callers of these actions already render — the dialog in
 * its `filming-day-notice` paragraph, which is `role="status"`.
 */
function movedWarning(movedFrom: number): string | null {
  if (movedFrom === 0) return null;
  return movedFrom === 1
    ? "1 of these was already on another filming day and has been moved off it."
    : `${movedFrom} of these were already on another filming day and have been moved off it.`;
}

/** The warnings a write produced, as one sentence or none. */
function joinWarnings(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length === 0 ? null : kept.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Schedule a batch filming day, optionally with the videos it covers.
 *
 * The two statements are not one transaction and cannot be: PostgREST has no
 * multi-statement call, and wrapping them in a SQL function would put a plain
 * INSERT behind a security-definer barrier for no guarantee — nothing here is
 * revoked from the client the way `videos.stage_id` is. What that costs is one
 * failure mode, and it is reported rather than hidden: if the day is created
 * and the links fail, the day exists, the caller is told which half worked, and
 * the videos can be attached from either end afterwards.
 */
export async function createFilmingDay(
  input: z.input<typeof CreateInput>,
): Promise<FilmingDayResult> {
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, kind: "error", error: parsed.error.issues[0].message };
  }
  const { onDate, notes, videoIds = [] } = parsed.data;

  const { supabase } = await requireUser();

  const { data: created, error } = await supabase
    .from("filming_days")
    // `user_id` is `default auth.uid()` and the RLS policy checks it, so it is
    // neither sent nor trusted from here.
    .insert({ on_date: onDate, notes: notes ?? null })
    .select(DAY_COLUMNS)
    .maybeSingle<DayRow>();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      /*
        One creator, one camera, one day per date. The row that is already
        there is the answer, so it is read and handed back with everything it
        already covers; the caller offers "add to it" rather than reporting a
        constraint name.
      */
      const { data: existing } = await supabase
        .from("filming_days")
        .select("id")
        .eq("on_date", onDate)
        .maybeSingle();

      const day = existing ? await readFilmingDay(existing.id) : null;
      if (day) {
        return {
          ok: false,
          kind: "exists",
          day,
          error: "You already have a filming day on that date.",
        };
      }
    }
    return {
      ok: false,
      kind: "error",
      error: `That filming day could not be scheduled: ${error.message}`,
    };
  }

  if (!created) {
    return {
      ok: false,
      kind: "error",
      error: "That filming day could not be scheduled.",
    };
  }

  const { linked, movedFrom, error: linkError } = await link(
    supabase,
    created.id,
    videoIds,
  );

  await revalidateFor(supabase, videoIds);

  /*
    The day as it now is. The fallback is for the read failing, not for the
    day being absent — it was created one statement ago — and it says exactly
    what is known rather than claiming an empty shoot: the videos the link
    reported, with nothing dressed on them that was not read.
  */
  const day = (await readFilmingDay(created.id)) ?? {
    id: created.id,
    onDate: created.on_date,
    label: formatDateColumn(created.on_date, "full") ?? created.on_date,
    notes: created.notes,
    videos: [],
  };

  const warning = joinWarnings(
    linkError
      ? `The day is scheduled, but ${linkError}`
      : videoIds.length > linked.length
        ? "The day is scheduled. Some of those videos are no longer there, so they were not attached."
        : null,
    movedWarning(movedFrom),
  );

  return {
    ok: true,
    day,
    linked: linked.length,
    ...(warning ? { warning } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Link and unlink                                                             */
/* -------------------------------------------------------------------------- */

/** Attach videos to a day that already exists. The "add to it" half of above. */
export async function linkVideosToFilmingDay(
  input: z.input<typeof LinkInput>,
): Promise<FilmingDayWriteResult> {
  const parsed = LinkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, kind: "error", error: parsed.error.issues[0].message };
  }
  const { dayId, videoIds } = parsed.data;

  const { supabase } = await requireUser();

  // Checked before the write so a missing day is a sentence rather than a
  // foreign-key violation, and so the read-back below has something to read.
  const before = await readFilmingDay(dayId);
  if (!before) {
    return {
      ok: false,
      kind: "error",
      error: "That filming day does not exist any more — reload the calendar.",
    };
  }

  const { linked, movedFrom, error } = await link(supabase, dayId, videoIds);
  if (error) return { ok: false, kind: "error", error };

  await revalidateFor(supabase, videoIds);

  const day = (await readFilmingDay(dayId)) ?? before;
  const warning = joinWarnings(
    linked.length < videoIds.length
      ? "Some of those videos are no longer there, so they were not attached."
      : null,
    movedWarning(movedFrom),
  );

  return {
    ok: true,
    day,
    linked: linked.length,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Take one video off a filming day.
 *
 * The video is untouched otherwise — this is one column going to NULL. A video
 * that is not on a day is the normal state of most of the board, so there is
 * nothing to confirm and nothing to explain.
 */
export async function unlinkVideoFromFilmingDay(
  input: z.input<typeof UnlinkInput>,
): Promise<UnlinkResult> {
  const parsed = UnlinkInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, dayId } = parsed.data;

  const { supabase } = await requireUser();

  let write = supabase
    .from("videos")
    .update({ filming_day_id: null })
    .eq("id", videoId);

  // The precondition, when the caller has a belief about which day this is.
  if (dayId !== undefined) write = write.eq("filming_day_id", dayId);

  const { data, error } = await write.select("id").maybeSingle();

  if (error) {
    return { ok: false, error: `That could not be detached: ${error.message}` };
  }

  if (!data) {
    return {
      ok: false,
      error:
        dayId === undefined
          ? "That video does not exist any more."
          : "That video is not on this filming day any more — reload the calendar.",
    };
  }

  await revalidateFor(supabase, [videoId]);

  // Only the caller that named a day gets one back: without a `dayId` there is
  // nothing to re-read, because the link that was just removed is the only
  // thing that knew which day it had been.
  const day = dayId === undefined ? null : await readFilmingDay(dayId);

  return { ok: true, day };
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The call sheet, and moving the shoot.
 *
 * Moving a day onto a date that already has one is refused rather than merged:
 * merging two days would silently move somebody else's list of videos, and the
 * two-step (attach these videos to that day, delete this one) is both explicit
 * and already built.
 */
export async function updateFilmingDay(
  input: z.input<typeof UpdateInput>,
): Promise<FilmingDayWriteResult> {
  const parsed = UpdateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, kind: "error", error: parsed.error.issues[0].message };
  }
  const { dayId, notes, onDate } = parsed.data;

  if (notes === undefined && onDate === undefined) {
    return { ok: false, kind: "error", error: "Nothing to change." };
  }

  const { supabase } = await requireUser();

  const patch: { notes?: string | null; on_date?: string } = {};
  if (notes !== undefined) patch.notes = notes;
  if (onDate !== undefined) patch.on_date = onDate;

  const { data, error } = await supabase
    .from("filming_days")
    .update(patch)
    .eq("id", dayId)
    .select(DAY_COLUMNS)
    .maybeSingle<DayRow>();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return {
        ok: false,
        kind: "exists",
        error:
          "You already have a filming day on that date. Attach these videos to it instead, then delete this one.",
      };
    }
    return {
      ok: false,
      kind: "error",
      error: `That did not save: ${error.message}`,
    };
  }

  if (!data) {
    return {
      ok: false,
      kind: "error",
      error: "That filming day does not exist any more.",
    };
  }

  const day = (await readFilmingDay(dayId)) ?? {
    id: data.id,
    onDate: data.on_date,
    label: formatDateColumn(data.on_date, "full") ?? data.on_date,
    notes: data.notes,
    videos: [],
  };

  await revalidateFor(
    supabase,
    day.videos.map((video) => video.id),
  );

  return { ok: true, day, linked: 0 };
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Cancel a filming day.
 *
 * It deletes one row and nothing else. The videos survive and are unlinked by
 * the foreign key — `references filming_days (id, user_id) on delete set null
 * (filming_day_id)`, the Postgres 15+ column-list form, which nulls *only* that
 * column of the composite key and leaves `user_id` alone. Deleting the videos'
 * link here as well would be a second implementation of the same rule, and the
 * one in the schema is the one that also holds when the row is deleted from
 * psql.
 *
 * The videos are read *before* the delete so the caller can say how many came
 * loose. That count is the proof, and `e2e/filming-days.spec.ts` checks it
 * against the rows themselves.
 */
export async function deleteFilmingDay(
  input: z.input<typeof DeleteInput>,
): Promise<DeleteFilmingDayResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { dayId } = parsed.data;

  const { supabase } = await requireUser();

  const before = await readFilmingDay(dayId);
  if (!before) {
    return { ok: false, error: "That filming day does not exist any more." };
  }

  const { data, error } = await supabase
    .from("filming_days")
    .delete()
    .eq("id", dayId)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, error: `That could not be deleted: ${error.message}` };
  }
  if (!data) {
    return { ok: false, error: "That filming day does not exist any more." };
  }

  await revalidateFor(
    supabase,
    before.videos.map((video) => video.id),
  );

  return { ok: true, unlinked: before.videos.length, onDate: before.onDate };
}
