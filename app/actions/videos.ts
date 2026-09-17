"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { Database } from "@/lib/database.types";
import {
  HookListSchema,
  readHooks,
  readTitleCandidates,
  SkipReasonSchema,
  TitleCandidateListSchema,
  type Hook,
  type TitleCandidate,
} from "@/lib/packaging";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * Video server actions. M1 owns two of them: `captureVideo` and
 * `updateWorkingTitle`.
 *
 * `updateVideo` proper — the whole packaging block saved field by field — is
 * M2, and `updateWorkingTitle` is deliberately not it: it writes one column and
 * takes one column, so the M1 detail stub can autosave a title without this
 * file growing into a general "save a video" endpoint before there is a page
 * that needs one.
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

/* -------------------------------------------------------------------------- */
/* The working title                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The detail stub's title field, saved on blur.
 *
 * Deliberately narrow: one column in, one column out. `videos.title` is in the
 * client's `UPDATE` grant (unlike `stage_id` and friends), so this is a plain
 * row update and not an RPC — there is no invariant to keep. The gate reads the
 * same column at move time, which is why clearing a title here is *allowed*:
 * PLAN.md wants a cleared title to surface as "Complete packaging" on the next
 * move, not to be silently refused by a form.
 */
const TitleInput = z.object({
  videoId: z.uuid(),
  title: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .max(
          MAX_TITLE_LENGTH,
          `Titles are capped at ${MAX_TITLE_LENGTH} characters.`,
        ),
    ),
});

export type UpdateWorkingTitleInput = z.input<typeof TitleInput>;

export type UpdateWorkingTitleResult =
  | { ok: true; title: string }
  | { ok: false; error: string };

export async function updateWorkingTitle(
  input: UpdateWorkingTitleInput,
): Promise<UpdateWorkingTitleResult> {
  const parsed = TitleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, title } = parsed.data;

  const { supabase } = await requireUser();

  // RLS is the ownership check: another user's id updates zero rows, and
  // `select` on the way back returns nothing, which is what "no such video"
  // looks like from here.
  const { data, error } = await supabase
    .from("videos")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", videoId)
    .select("id, title, channel_id")
    .maybeSingle();

  if (error) {
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) {
    return { ok: false, error: "That video does not exist any more." };
  }

  revalidatePath(`/videos/${videoId}`);

  // The card on the board shows this title.
  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", data.channel_id)
    .maybeSingle();

  if (channel) {
    revalidatePath(`/c/${channel.slug}/board`);
  }

  return { ok: true, title: data.title };
}

/* -------------------------------------------------------------------------- */
/* The packaging block (M2)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `updateVideo` — the packaging block's autosave endpoint.
 *
 * One action for the whole block rather than one per field, because the block's
 * edits are not always one field: choosing a title candidate writes
 * `title_candidates` *and* `title` in the same gesture, and those two have to
 * land together or the working title and the ticked candidate disagree. Every
 * property is optional and only the ones present are written, so a blurred
 * concept box still costs exactly one column.
 *
 * ## Why it returns the whole packaging state
 *
 * The live gate indicator has to agree with what `move_video` would decide, and
 * `move_video` reads the row — not the form. So the action reads the row back
 * after writing and hands the caller the four columns the gate looks at; the
 * indicator is then derived from what is *stored*, not from what was typed. A
 * save that partially failed, a value the database rewrote, a column changed in
 * another tab: all of them show up here rather than being believed.
 *
 * ## What it refuses
 *
 * `title_candidates` and `hooks` are jsonb with almost no schema in the
 * database. `lib/packaging.ts` is where the real rules live — at most three
 * hooks, at most one chosen per list, no blank text, unique ids — and this
 * action is the only writer that goes through them. Nothing here hand-rolls a
 * second copy of those rules.
 *
 * `stage_id` is not in this action's vocabulary, and could not be even if it
 * were: `UPDATE (stage_id, stage_entered_at, published_at, shipped_role)` is
 * revoked from `authenticated`, and `move_video` is the only path.
 */
/** The written concept is a description of a picture, not a script. */
const MAX_CONCEPT_LENGTH = 2000;

const PackagingSkipInput = z.union([
  z.object({ reason: SkipReasonSchema }),
  z.null(),
]);

const UpdateVideoInput = z
  .object({
    videoId: z.uuid(),
    /**
     * The working title. Trimmed, and allowed to be empty: PLAN.md wants a
     * cleared title to surface at the gate as "Complete packaging", not to be
     * refused by a form.
     */
    title: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(MAX_TITLE_LENGTH, `Titles are capped at ${MAX_TITLE_LENGTH} characters.`))
      .optional(),
    /**
     * The *written* thumbnail concept — the field the gate reads. The concept
     * sketch is `thumbnail_concept_path` and is a different column written by a
     * different action; the two are never conflated here.
     *
     * An emptied box writes NULL rather than `''`. Both read as missing at the
     * gate (`coalesce(thumbnail_concept, '') = ''`), and one representation for
     * "there is nothing here" is what the rest of the app already assumes.
     */
    thumbnailConcept: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .max(
            MAX_CONCEPT_LENGTH,
            `The thumbnail concept is capped at ${MAX_CONCEPT_LENGTH} characters — it is a description, not the script.`,
          ),
      )
      .optional(),
    titleCandidates: TitleCandidateListSchema.optional(),
    hooks: HookListSchema.optional(),
    /**
     * `{ reason }` skips packaging, `null` un-skips it, absent leaves it alone.
     * The two columns are set together because `0001_init.sql` pairs them:
     * `(packaging_skipped_at is null) = (packaging_skip_reason is null)`.
     */
    packagingSkip: PackagingSkipInput.optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.thumbnailConcept !== undefined ||
      input.titleCandidates !== undefined ||
      input.hooks !== undefined ||
      input.packagingSkip !== undefined,
    { message: "That save had nothing in it." },
  );

export type UpdateVideoInputShape = z.input<typeof UpdateVideoInput>;

/**
 * The four columns the gate reads, as the row holds them after the write.
 * The client re-derives its indicator from exactly this.
 */
export interface PackagingState {
  readonly title: string;
  readonly thumbnailConcept: string | null;
  readonly titleCandidates: TitleCandidate[];
  readonly hooks: Hook[];
  readonly packagingSkippedAt: string | null;
  readonly packagingSkipReason: string | null;
}

export type UpdateVideoResult =
  | { ok: true; packaging: PackagingState }
  | { ok: false; error: string };

/** The columns every packaging read and write-back selects. */
const PACKAGING_COLUMNS =
  "title, thumbnail_concept, title_candidates, hooks, packaging_skipped_at, packaging_skip_reason, channel_id";

interface PackagingRow {
  title: string;
  thumbnail_concept: string | null;
  title_candidates: unknown;
  hooks: unknown;
  packaging_skipped_at: string | null;
  packaging_skip_reason: string | null;
  channel_id: string;
}

/**
 * The row as the editor reads it.
 *
 * Lenient on purpose (see `lib/packaging.ts`): a row written by the seed, by a
 * future brainstorm import or by hand still has to render. What it will not do
 * is *repair* `chosen` — a row that really carries two chosen hooks reads as
 * two chosen hooks, so the indicator says what the gate will say.
 */
// NOT exported: a `"use server"` module may only export async functions, and
// Turbopack refuses the whole file otherwise ("Server Actions must be async
// functions"), which takes every route down with it. Nothing outside this file
// uses it today. If the page shell ever needs it, it belongs in
// `lib/packaging.ts` beside `readHooks`/`readTitleCandidates`, not here.
function packagingStateFromRow(row: PackagingRow): PackagingState {
  return {
    title: row.title,
    thumbnailConcept: row.thumbnail_concept,
    titleCandidates: readTitleCandidates(row.title_candidates),
    hooks: readHooks(row.hooks),
    packagingSkippedAt: row.packaging_skipped_at,
    packagingSkipReason: row.packaging_skip_reason,
  };
}

export async function updateVideo(
  input: UpdateVideoInputShape,
): Promise<UpdateVideoResult> {
  const parsed = UpdateVideoInput.safeParse(input);
  if (!parsed.success) {
    // The block shows one line, so the first issue is what it shows. The zod
    // messages are written to be that line — "Three hooks is the limit…",
    // "Only one hook can be the chosen one…".
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, title, thumbnailConcept, titleCandidates, hooks, packagingSkip } =
    parsed.data;

  // Typed against the generated `videos.Update` so a column name that does not
  // exist is a compile error rather than a silent no-op PATCH.
  const patch: Database["public"]["Tables"]["videos"]["Update"] = {
    updated_at: new Date().toISOString(),
  };
  if (title !== undefined) patch.title = title;
  if (thumbnailConcept !== undefined) {
    patch.thumbnail_concept = thumbnailConcept === "" ? null : thumbnailConcept;
  }
  if (titleCandidates !== undefined) patch.title_candidates = titleCandidates;
  if (hooks !== undefined) patch.hooks = hooks;
  if (packagingSkip !== undefined) {
    // Both columns, always together: the CHECK pairs them, and a skip whose
    // reason failed to write would be a skip nobody can explain later.
    patch.packaging_skipped_at =
      packagingSkip === null ? null : new Date().toISOString();
    patch.packaging_skip_reason = packagingSkip === null ? null : packagingSkip.reason;
  }

  const { supabase } = await requireUser();

  // RLS is the ownership check: another user's id updates zero rows and the
  // `select` on the way back returns nothing — which is what "no such video"
  // looks like from here, and is deliberately indistinguishable from an id that
  // was never issued.
  const { data, error } = await supabase
    .from("videos")
    .update(patch)
    .eq("id", videoId)
    .select(PACKAGING_COLUMNS)
    .maybeSingle<PackagingRow>();

  if (error) {
    // The database's own refusals reach the user as themselves: the hooks CHECK
    // (a fourth hook that somehow got past zod) and the skip-reason CHECK are
    // the two that can realistically fire, and both are worth seeing verbatim
    // rather than as "that did not save".
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) {
    return { ok: false, error: "That video does not exist any more." };
  }

  revalidatePath(`/videos/${videoId}`);

  // The card carries the title, and from M2 the skipped-packaging badge.
  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", data.channel_id)
    .maybeSingle();
  if (channel) {
    revalidatePath(`/c/${channel.slug}/board`);
  }

  return { ok: true, packaging: packagingStateFromRow(data) };
}

/* -------------------------------------------------------------------------- */
/* The flow fields                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The non-packaging half of the detail page: target date, final URL, notes,
 * `waiting_on`, and the archive switch.
 *
 * All five are plain columns in the client's `UPDATE` grant — none of them is
 * `stage_id` and none of them is read by the TTH gate — so this is a row update
 * and not an RPC. The stage select next to them is *not* here: it goes through
 * `moveVideo` (`app/actions/moves.ts`) and therefore through `move_video`, so
 * the board's drag, the `[`/`]` keys and the select cannot disagree about the
 * gate. There is deliberately no code path in this file that writes a stage.
 *
 * ## One patch endpoint, not five actions
 *
 * The fields autosave one at a time on blur, so every call carries exactly one
 * key in practice. They share an endpoint because they share everything else —
 * the ownership check, the `updated_at` stamp, the two revalidations — and five
 * copies of that is five places for them to drift. Each key still has its own
 * validation and its own message, which is the part that has to be per-field.
 *
 * ## Empty means NULL, everywhere
 *
 * A cleared box writes `NULL`, never `''`. `/now` and the board both test these
 * columns for "is there anything here" (`waiting_on` is a chip, the target date
 * is the primary sort key), and `''` is a value that reads as present and looks
 * absent.
 */

/** How long each free-text column may be. Generous; these are guard rails. */
const MAX_NOTES_LENGTH = 20_000;
const MAX_WAITING_ON_LENGTH = 200;
const MAX_URL_LENGTH = 2_000;

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
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (year < 1970 || year > 2999) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

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

/** `"  "` and `""` both mean NULL; anything else is trimmed and kept verbatim. */
const NullableText = z
  .union([z.string(), z.null()])
  .transform((value) => (value === null ? null : value.trim()))
  .transform((value) => (value === "" ? null : value));

const TargetPublishDate = NullableText.refine(
  (value) => value === null || isCalendarDate(value),
  { message: "That is not a date the calendar has. Use the date picker." },
);

const YoutubeUrl = NullableText.refine(
  (value) => value === null || value.length <= MAX_URL_LENGTH,
  { message: `That link is longer than ${MAX_URL_LENGTH} characters.` },
).refine((value) => value === null || isHttpUrl(value), {
  message:
    "That is not a link. Paste the whole address, starting with https://.",
});

const Notes = NullableText.refine(
  (value) => value === null || value.length <= MAX_NOTES_LENGTH,
  {
    message: `Notes are capped at ${MAX_NOTES_LENGTH} characters — long enough for a script, not for a book.`,
  },
);

const WaitingOn = NullableText.refine(
  (value) => value === null || value.length <= MAX_WAITING_ON_LENGTH,
  {
    message: `Keep "waiting on" to ${MAX_WAITING_ON_LENGTH} characters — it is a chip on a card, not a note.`,
  },
);

const FlowInput = z.object({
  videoId: z.uuid(),
  targetPublishDate: TargetPublishDate.optional(),
  youtubeUrl: YoutubeUrl.optional(),
  notes: Notes.optional(),
  waitingOn: WaitingOn.optional(),
});

export type UpdateVideoFlowInput = z.input<typeof FlowInput>;

/**
 * Every flow field as the database now holds it.
 *
 * The whole set comes back from every call, not just the key that was written:
 * one save is one round trip, and a field that re-renders from what the server
 * confirmed cannot drift from it. `publishedAt` rides along because the URL
 * field reads it — a link is shown differently before the video is live.
 */
export interface VideoFlowSnapshot {
  targetPublishDate: string | null;
  youtubeUrl: string | null;
  publishedAt: string | null;
  notes: string | null;
  waitingOn: string | null;
  /** When `waiting_on` was first set; paired with it by a CHECK. */
  waitingSince: string | null;
  archivedAt: string | null;
}

export type UpdateVideoFlowResult =
  | { ok: true; video: VideoFlowSnapshot }
  | { ok: false; error: string };

/** The columns a flow write reads back; `channel_id` is for the revalidation. */
const FLOW_SELECT =
  "channel_id, target_publish_date, youtube_url, published_at, notes, waiting_on, waiting_since, archived_at";

type FlowRow = {
  channel_id: string;
  target_publish_date: string | null;
  youtube_url: string | null;
  published_at: string | null;
  notes: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  archived_at: string | null;
};

function snapshotOf(row: FlowRow): VideoFlowSnapshot {
  return {
    targetPublishDate: row.target_publish_date,
    youtubeUrl: row.youtube_url,
    publishedAt: row.published_at,
    notes: row.notes,
    waitingOn: row.waiting_on,
    waitingSince: row.waiting_since,
    archivedAt: row.archived_at,
  };
}

export async function updateVideoFlow(
  input: UpdateVideoFlowInput,
): Promise<UpdateVideoFlowResult> {
  const parsed = FlowInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { videoId, ...fields } = parsed.data;

  const patch: Record<string, string | null> = {};
  if ("targetPublishDate" in fields) {
    patch.target_publish_date = fields.targetPublishDate ?? null;
  }
  if ("youtubeUrl" in fields) patch.youtube_url = fields.youtubeUrl ?? null;
  if ("notes" in fields) patch.notes = fields.notes ?? null;

  const { supabase } = await requireUser();

  if ("waitingOn" in fields) {
    const waitingOn = fields.waitingOn ?? null;
    patch.waiting_on = waitingOn;

    if (waitingOn === null) {
      // Cleared together, because the CHECK in 0004_waiting_since.sql says so:
      // an unblocked video has no "since".
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

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "There was nothing to save." };
  }

  // RLS is the ownership check: another user's id matches no row, the update
  // touches nothing, and the `select` comes back empty — which is exactly what
  // an id that was never issued looks like from here.
  const { data, error } = await supabase
    .from("videos")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", videoId)
    .select(FLOW_SELECT)
    .maybeSingle();

  if (error) {
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) {
    return { ok: false, error: "That video does not exist any more." };
  }

  await revalidateVideoAndBoard(supabase, videoId, data.channel_id);

  return { ok: true, video: snapshotOf(data) };
}

/* -------------------------------------------------------------------------- */
/* Archive                                                                     */
/* -------------------------------------------------------------------------- */

const ArchiveInput = z.object({
  videoId: z.uuid(),
  archived: z.boolean(),
});

export type SetVideoArchivedInput = z.input<typeof ArchiveInput>;

/**
 * Archive or restore.
 *
 * Archiving is `archived_at = now()` and nothing else. The board already reads
 * `.is("archived_at", null)` on both of its queries (the column list and the
 * cross-channel Filming count in `app/c/[slug]/board/page.tsx`), so an archived
 * video leaves the board the moment this lands and comes back the moment it is
 * restored — with its stage, its checklist, its dates and its notes untouched.
 *
 * It is not a delete and it is not a stage: there is no "Archived" column, the
 * row keeps the stage it was in, and `move_video` is still the only thing that
 * can change that. Restoring therefore needs no decision about where to put it.
 */
export async function setVideoArchived(
  input: SetVideoArchivedInput,
): Promise<UpdateVideoFlowResult> {
  const parsed = ArchiveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not something the page could ask for." };
  }
  const { videoId, archived } = parsed.data;

  const { supabase } = await requireUser();

  const { data, error } = await supabase
    .from("videos")
    .update({
      archived_at: archived ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoId)
    .select(FLOW_SELECT)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: `Could not ${archived ? "archive" : "restore"} that: ${error.message}`,
    };
  }
  if (!data) {
    return { ok: false, error: "That video does not exist any more." };
  }

  await revalidateVideoAndBoard(supabase, videoId, data.channel_id);

  return { ok: true, video: snapshotOf(data) };
}

/**
 * The detail page and the video's board, in that order.
 *
 * Every flow field is on one of the two: the target date is the board's primary
 * sort key, `waiting_on` is a chip on the card, and archiving removes the card
 * altogether. The slug is looked up rather than passed in, so a caller cannot
 * aim a revalidation at a path it does not own.
 */
async function revalidateVideoAndBoard(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  videoId: string,
  channelId: string,
): Promise<void> {
  revalidatePath(`/videos/${videoId}`);

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", channelId)
    .maybeSingle();

  if (channel) {
    revalidatePath(`/c/${channel.slug}/board`);
  }
}
