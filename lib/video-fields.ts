import { z } from "zod";

import {
  HookListSchema,
  MAX_TITLE_LENGTH,
  SkipReasonSchema,
  TitleCandidateListSchema,
} from "./packaging";

/**
 * The one schema for everything `/videos/[id]` can write.
 *
 * ## Why there is exactly one
 *
 * M2's two halves each arrived with their own: the packaging block validated
 * its four columns one way, the flow fields validated their four another, and
 * M1's title field validated `videos.title` a third time with a third message.
 * Three schemas over one row is three places for "what counts as empty" to
 * drift, and the answer matters: `/now`, the board and the idea bank all test
 * these columns for *is there anything here*, and `''` is a value that reads as
 * present and looks absent.
 *
 * So the rules live here, once, and `updateVideo` in `app/actions/videos.ts` is
 * the only writer that goes through them. The packaging *element* rules — at
 * most three hooks, at most one chosen, unique ids — stay in `lib/packaging.ts`
 * beside the gate predicate they exist to protect, and are composed in below
 * rather than restated.
 *
 * ## The shape of a patch
 *
 * Every key is optional and only the keys that are present are written. A
 * blurred notes box costs one column; choosing a title candidate costs two
 * (`title_candidates` and `title`) and they land together, because a tick that
 * left the working title behind would be a decision the gate does not believe
 * in.
 *
 * `stage_id` is not in this vocabulary, and could not be even if it were:
 * `UPDATE (stage_id, stage_entered_at, published_at, shipped_role)` is revoked
 * from `authenticated` in `0001_init.sql`, and `move_video` is the only path.
 */

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** The written concept is a description of a picture, not a script. */
export const MAX_CONCEPT_LENGTH = 2_000;
/** Long enough for a script, not for a book. */
export const MAX_NOTES_LENGTH = 20_000;
/** It is a chip on a card, not a note. */
export const MAX_WAITING_ON_LENGTH = 200;
export const MAX_URL_LENGTH = 2_000;

/**
 * What the page says when a write lost a race with another tab.
 *
 * One wording, in a module both halves can import: `app/actions/videos.ts` is
 * a `"use server"` file and may only export async functions, and
 * `components/video-version.tsx` is a client component the action must not
 * pull in.
 */
export const CHANGED_ELSEWHERE =
  "This video changed somewhere else — another tab, another window — so this was not saved over it. Reload to see what it holds now.";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `"  "` and `""` both mean NULL; anything else is trimmed and kept verbatim.
 *
 * Used by every nullable text column on the page. The alternative — writing
 * `''` — is the bug this exists to prevent: a `waiting_on` of `''` puts an
 * empty chip on a card and a blank row in `/now`'s Waiting section.
 */
export const NullableText = z
  .union([z.string(), z.null()])
  .transform((value) => (value === null ? null : value.trim()))
  .transform((value) => (value === "" ? null : value));

/**
 * The working title: trimmed, capped, and **allowed to be empty**.
 *
 * PLAN.md wants a cleared title to surface at the gate as "Complete packaging",
 * not to be refused by a form. The gate is the one place that decides whether a
 * title is required, and `videos.title` is `not null default ''`, so empty is a
 * real value here rather than an absence.
 */
export const WorkingTitleSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .max(MAX_TITLE_LENGTH, `Titles are capped at ${MAX_TITLE_LENGTH} characters.`),
  );

/**
 * The *written* thumbnail concept — the field the gate reads.
 *
 * The concept sketch is `thumbnail_concept_path`, an uploaded reference image
 * written by a different action. The two are never conflated: an M1 reviewer
 * found the app refusing a move for "a thumbnail concept" to someone looking at
 * a card with a visible sketch on it.
 */
export const ThumbnailConceptSchema = NullableText.refine(
  (value) => value === null || value.length <= MAX_CONCEPT_LENGTH,
  {
    message: `The thumbnail concept is capped at ${MAX_CONCEPT_LENGTH} characters — it is a description, not the script.`,
  },
);

/**
 * A real calendar date in `YYYY-MM-DD`, which is what a `date` column holds.
 *
 * `<input type="date">` cannot produce anything else, but a server action is a
 * POST endpoint like any other and `2026-02-30` would otherwise reach Postgres
 * and come back as a 400 with a wire-format complaint in it. Round-tripping
 * through `Date.UTC` is what rejects the days that do not exist.
 */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1970 || year > 2999) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export const TargetPublishDateSchema = NullableText.refine(
  (value) => value === null || isCalendarDate(value),
  { message: "That is not a date the calendar has. Use the date picker." },
);

/**
 * An `http`/`https` URL.
 *
 * The host is not checked against a list of YouTube domains: the public link,
 * `youtu.be`, a Studio link and a members-only link are all things a creator
 * legitimately pastes here, and a field that refuses the address the site
 * actually gave them is worse than one that stores it. What is refused is the
 * thing that is not a link at all — `javascript:`, a bare "tomorrow", a video
 * id on its own — because this string ends up in an anchor's `href`.
 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export const YoutubeUrlSchema = NullableText.refine(
  (value) => value === null || value.length <= MAX_URL_LENGTH,
  { message: `That link is longer than ${MAX_URL_LENGTH} characters.` },
).refine((value) => value === null || isHttpUrl(value), {
  message: "That is not a link. Paste the whole address, starting with https://.",
});

export const NotesSchema = NullableText.refine(
  (value) => value === null || value.length <= MAX_NOTES_LENGTH,
  {
    message: `Notes are capped at ${MAX_NOTES_LENGTH} characters — long enough for a script, not for a book.`,
  },
);

export const WaitingOnSchema = NullableText.refine(
  (value) => value === null || value.length <= MAX_WAITING_ON_LENGTH,
  {
    message: `Keep "waiting on" to ${MAX_WAITING_ON_LENGTH} characters — it is a chip on a card, not a note.`,
  },
);

/**
 * `{ reason }` skips packaging, `null` un-skips it, absent leaves it alone.
 *
 * The two columns are always written together because `0001_init.sql` pairs
 * them: `(packaging_skipped_at is null) = (packaging_skip_reason is null)`, and
 * `packaging_skip_reason <> ''`.
 */
export const PackagingSkipSchema = z.union([
  z.object({ reason: SkipReasonSchema }),
  z.null(),
]);

/* -------------------------------------------------------------------------- */
/* The patch                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything a patch may carry, minus the id. The action refuses an empty one. */
const FIELDS = {
  title: WorkingTitleSchema.optional(),
  thumbnailConcept: ThumbnailConceptSchema.optional(),
  titleCandidates: TitleCandidateListSchema.optional(),
  hooks: HookListSchema.optional(),
  packagingSkip: PackagingSkipSchema.optional(),
  targetPublishDate: TargetPublishDateSchema.optional(),
  youtubeUrl: YoutubeUrlSchema.optional(),
  notes: NotesSchema.optional(),
  waitingOn: WaitingOnSchema.optional(),
  /**
   * Archive (`true`) or restore (`false`). Not a stage and not a delete: the
   * row keeps its stage, its dates and its notes, and the board's queries
   * already end in `.is("archived_at", null)`.
   */
  archived: z.boolean().optional(),
} as const;

/** The keys a caller may send. Used to check that a patch is not empty. */
export const VIDEO_PATCH_KEYS = Object.keys(FIELDS) as readonly (keyof typeof FIELDS)[];

export const VideoPatchSchema = z
  .object({
    videoId: z.uuid(),
    /**
     * The `updated_at` the caller computed this patch against, or `null` when
     * the row had never been written. Absent means "write unconditionally".
     *
     * It is not a field and is never written: it is the precondition the update
     * matches on, so a patch built from a version of the row that something
     * else has since replaced touches zero rows instead of clobbering it. See
     * `components/video-version.tsx`.
     */
    expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
    ...FIELDS,
  })
  .refine(
    (patch) => VIDEO_PATCH_KEYS.some((key) => patch[key] !== undefined),
    { message: "That save had nothing in it." },
  );

/** What a caller sends. Pre-transform: `thumbnailConcept` may be a plain string. */
export type VideoPatchInput = z.input<typeof VideoPatchSchema>;
