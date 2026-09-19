"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  BucketNameSchema,
  QuotaSchema,
  bucketNameTaken,
  duplicateSentence,
  moveBucket,
  nextBucketPosition,
  sortBuckets,
} from "@/lib/bucket-settings";
import { AXIS_LABEL, NO_BUCKETS, type BucketChoices } from "@/lib/buckets";
import { isPermutationOf } from "@/lib/checklist-templates";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * One channel's content buckets, for a picker.
 *
 * ## Why capture reads them through an action rather than being handed them
 *
 * The `c` modal is mounted by the sidebar, which every signed-in route renders.
 * Handing it the buckets would mean reading them on every page load — the
 * board, the video page, `/now` — to fill in a disclosure that is closed until
 * Shift+Enter and a dialog that is usually never opened. BRIEF.md principle 6
 * is that friction is the product's enemy, and PLAN.md's capture is *one field,
 * Enter, saved*; paying a query per page for it is the same mistake in a
 * different currency.
 *
 * So the pickers ask for their options when they are first shown, once per
 * channel, and the fast path costs nothing at all. The modal is JavaScript by
 * definition — there is no dialog without it — so nothing is lost to the
 * no-JavaScript path that was not already gone: the disclosure itself is a
 * button with an `onClick`.
 *
 * `/videos/[id]` does **not** call this. That page already reads the row it is
 * editing, so its buckets come down with the server render, in the same request
 * that knows which of them the video currently carries.
 *
 * ## What it is not
 *
 * Not a write path, and not a validator. RLS scopes the read to the signed-in
 * user, so a channel belonging to someone else returns nothing — the same
 * answer as a channel id that was never issued. Whether a *chosen* bucket is
 * legitimate is settled by the three-column composite foreign key on `videos`,
 * not here: this only decides what a person is offered.
 */
export async function listBuckets(
  channelId: string,
): Promise<
  | { ok: true; choices: BucketChoices }
  | { ok: false; error: string; choices: BucketChoices }
> {
  const { supabase } = await requireUser();

  const { data, error } = await supabase
    .from("buckets")
    .select("id, axis, name, position")
    .eq("channel_id", channelId)
    .order("position", { ascending: true });

  /*
    A reported failure, not a throw and not an empty pair.

    A capture whose pickers could not load is still a capture — the title is
    already typed and Enter must still save it — so this never takes the form
    down. But "the read failed" and "this channel has no pillars yet" are
    different sentences and the second one is a lie about the first: the form
    says which it was, beside the pickers, and the title is untouched either
    way.
  */
  if (error || !data) {
    return {
      ok: false,
      error: `Could not load this channel's buckets: ${error?.message ?? "no rows came back."}`,
      choices: NO_BUCKETS,
    };
  }

  const verticals: { id: string; name: string }[] = [];
  const horizontals: { id: string; name: string }[] = [];
  for (const bucket of data) {
    const option = { id: bucket.id, name: bucket.name };
    if (bucket.axis === "vertical") verticals.push(option);
    else if (bucket.axis === "horizontal") horizontals.push(option);
  }

  return { ok: true, choices: { verticals, horizontals } };
}

/* ========================================================================== */
/* The settings half — `/settings/buckets/[slug]`                             */
/* ========================================================================== */

/*
  Everything below is M7's. Add, rename, re-quota, reorder and remove a
  bucket, each as one request against `buckets`, which the client holds every
  column of (there is no revoke on this table; RLS scopes it to the owner).

  ## What the database already refuses, and what is refused first

  - `unique (channel_id, axis, name)` — caught as 23505 and said in words, but
    refused before that, case-insensitively, by `bucketNameTaken`: the
    database would let "Review" and "review" coexist, and the matrix would
    then draw two headings nobody could tell apart.
  - `check (monthly_quota > 0)` — `QuotaSchema` refuses zero and negatives in
    a sentence, so the CHECK is never reached from this file. The screen
    refuses them a third time, before the request is made.
  - `unique (channel_id, axis, position) deferrable initially deferred` — a
    reorder is ONE upsert of the whole axis (`reorderAxis`), the same statement
    the checklist-template editor uses for the same constraint, so the
    colliding intermediate state is inside one transaction and the unique is
    checked once at commit.

  ## Removal

  `videos.vertical_id` and `videos.horizontal_id` reference this table
  `on delete set null`. So a delete does not fail while videos carry the
  bucket — it unfiles them, on that axis only, and nothing else about them
  changes. `removeBucket` therefore reads the count first and returns it, so
  the screen can say what the click will do before it is made, and the
  removal itself is one `delete` the key finishes.

  ## Every action reads the bucket first, through RLS

  Another user's bucket id reads as no row, which is the same answer as an id
  that was never issued. The channel's slug comes from the same read, for
  `revalidatePath`, never from the caller.
*/

type Supabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

const AxisSchema = z.enum(["vertical", "horizontal"]);

/** One bucket as the settings screen holds it. */
export interface SettingsBucket {
  readonly id: string;
  readonly channelId: string;
  readonly axis: "vertical" | "horizontal";
  readonly name: string;
  readonly position: number;
  readonly monthlyQuota: number | null;
}

/**
 * Every write answers with the axis as it now stands. A list of at most a
 * dozen rows, and every write here changes what the rest of the list means
 * (a removal leaves a gap, a reorder renumbers, an add takes the last slot),
 * so the client replaces rather than merges.
 */
export type BucketWriteResult =
  | { ok: true; axis: "vertical" | "horizontal"; buckets: SettingsBucket[] }
  | { ok: false; error: string };

const BUCKET_COLUMNS = "id, channel_id, axis, name, position, monthly_quota" as const;

interface BucketRow {
  id: string;
  channel_id: string;
  axis: string;
  name: string;
  position: number;
  monthly_quota: number | null;
}

function readSettingsBucket(row: BucketRow): SettingsBucket {
  return {
    id: row.id,
    channelId: row.channel_id,
    axis: row.axis === "vertical" ? "vertical" : "horizontal",
    name: row.name,
    position: row.position,
    monthlyQuota: row.monthly_quota,
  };
}

const GONE = "That bucket is not there any more — it may have been removed in another tab. Reload to see the channel's buckets as they stand.";

/** One bucket and its channel's slug, or null when RLS shows nothing. */
async function readBucket(
  supabase: Supabase,
  bucketId: string,
): Promise<{ bucket: SettingsBucket; slug: string } | { error: string } | null> {
  const { data, error } = await supabase
    .from("buckets")
    .select(BUCKET_COLUMNS)
    .eq("id", bucketId)
    .maybeSingle();

  if (error) return { error: `Could not read that bucket: ${error.message}` };
  if (!data) return null;

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", data.channel_id)
    .maybeSingle();

  return { bucket: readSettingsBucket(data), slug: channel?.slug ?? "" };
}

/** One axis of one channel, in order. */
async function readAxis(
  supabase: Supabase,
  channelId: string,
  axis: "vertical" | "horizontal",
): Promise<{ buckets: SettingsBucket[] } | { error: string }> {
  const { data, error } = await supabase
    .from("buckets")
    .select(BUCKET_COLUMNS)
    .eq("channel_id", channelId)
    .eq("axis", axis)
    .order("position", { ascending: true });

  if (error) return { error: `Could not read the channel's ${AXIS_LABEL[axis].toLowerCase()}s: ${error.message}` };
  return { buckets: sortBuckets((data ?? []).map(readSettingsBucket)) };
}

/**
 * Everything that draws a bucket's name or count: the matrix and the bank
 * (both under `/c/[slug]/ideas`), the video page's picker, the capture
 * modal's picker (which reads through `listBuckets` on open, uncached), and
 * this settings screen.
 */
function revalidateBucketViews(slug: string): void {
  if (slug !== "") revalidatePath(`/c/${slug}/ideas`);
  revalidatePath("/videos/[id]", "page");
  revalidatePath("/settings/buckets/[slug]", "page");
}

/** The axis, after a write: the shape every success answers with. */
async function answer(
  supabase: Supabase,
  channelId: string,
  axis: "vertical" | "horizontal",
  slug: string,
): Promise<BucketWriteResult> {
  const read = await readAxis(supabase, channelId, axis);
  if ("error" in read) return { ok: false, error: read.error };
  revalidateBucketViews(slug);
  return { ok: true, axis, buckets: read.buckets };
}

/* -------------------------------------------------------------------------- */
/* Add                                                                         */
/* -------------------------------------------------------------------------- */

const AddInput = z.object({
  channelId: z.uuid(),
  axis: AxisSchema,
  name: BucketNameSchema,
  monthlyQuota: QuotaSchema.nullable().default(null),
});

export type AddBucketInput = z.input<typeof AddInput>;

/**
 * Append a bucket to one axis, at the end. A quota may come with it, or not.
 *
 * Two adds racing can both compute the same `max + 1`; the deferred unique
 * refuses the second at commit and the insert is retried once with a fresh
 * read. One user, one session, so the second attempt is the last.
 */
export async function addBucket(input: AddBucketInput): Promise<BucketWriteResult> {
  const parsed = AddInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { channelId, axis, name, monthlyQuota } = parsed.data;

  const { supabase } = await requireUser();

  const { data: channel } = await supabase
    .from("channels")
    .select("id, slug")
    .eq("id", channelId)
    .maybeSingle();
  if (!channel) return { ok: false, error: "That channel does not exist any more." };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readAxis(supabase, channelId, axis);
    if ("error" in current) return { ok: false, error: current.error };

    if (bucketNameTaken(name, current.buckets)) {
      return { ok: false, error: duplicateSentence(axis, name) };
    }

    const { error } = await supabase.from("buckets").insert({
      channel_id: channelId,
      axis,
      name,
      position: nextBucketPosition(current.buckets),
      monthly_quota: monthlyQuota,
    });

    if (!error) break;
    if (error.code === "23505") {
      // The name unique, or the position unique from a racing add. The name
      // was checked a moment ago, so one retry settles which it was.
      if (attempt === 0) continue;
      return { ok: false, error: duplicateSentence(axis, name) };
    }
    if (error.code === "23514") {
      return { ok: false, error: "A monthly quota has to be at least one." };
    }
    return { ok: false, error: `That did not save: ${error.message}` };
  }

  return answer(supabase, channelId, axis, channel.slug);
}

/* -------------------------------------------------------------------------- */
/* Rename                                                                      */
/* -------------------------------------------------------------------------- */

const RenameInput = z.object({
  bucketId: z.uuid(),
  name: BucketNameSchema,
});

export type RenameBucketInput = z.input<typeof RenameInput>;

/**
 * Change the label. Only the label: every video that carries the bucket
 * carries its id, so the matrix, the bank's filter and the pickers all show
 * the new name on the next render and nothing is re-filed.
 */
export async function renameBucket(input: RenameBucketInput): Promise<BucketWriteResult> {
  const parsed = RenameInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { bucketId, name } = parsed.data;

  const { supabase } = await requireUser();

  const found = await readBucket(supabase, bucketId);
  if (found === null) return { ok: false, error: GONE };
  if ("error" in found) return { ok: false, error: found.error };
  const { bucket, slug } = found;

  if (name !== bucket.name) {
    const current = await readAxis(supabase, bucket.channelId, bucket.axis);
    if ("error" in current) return { ok: false, error: current.error };
    if (bucketNameTaken(name, current.buckets.filter((other) => other.id !== bucketId))) {
      return { ok: false, error: duplicateSentence(bucket.axis, name) };
    }

    const { data, error } = await supabase
      .from("buckets")
      .update({ name })
      .eq("id", bucketId)
      .select("id")
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error:
          error.code === "23505"
            ? duplicateSentence(bucket.axis, name)
            : `That did not save: ${error.message}`,
      };
    }
    if (!data) return { ok: false, error: GONE };
  }

  return answer(supabase, bucket.channelId, bucket.axis, slug);
}

/* -------------------------------------------------------------------------- */
/* Quota                                                                       */
/* -------------------------------------------------------------------------- */

const QuotaInput = z.object({
  bucketId: z.uuid(),
  monthlyQuota: QuotaSchema.nullable(),
});

export type SetBucketQuotaInput = z.input<typeof QuotaInput>;

/**
 * Set or clear the monthly quota. It is the denominator the matrix draws as
 * `n of quota` beside the row or column, this month; null takes the bar away
 * and leaves the count.
 */
export async function setBucketQuota(input: SetBucketQuotaInput): Promise<BucketWriteResult> {
  const parsed = QuotaInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }
  const { bucketId, monthlyQuota } = parsed.data;

  const { supabase } = await requireUser();

  const found = await readBucket(supabase, bucketId);
  if (found === null) return { ok: false, error: GONE };
  if ("error" in found) return { ok: false, error: found.error };
  const { bucket, slug } = found;

  if (monthlyQuota !== bucket.monthlyQuota) {
    const { data, error } = await supabase
      .from("buckets")
      .update({ monthly_quota: monthlyQuota })
      .eq("id", bucketId)
      .select("id")
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error:
          error.code === "23514"
            ? "A monthly quota has to be at least one. Clear the box to have no quota."
            : `That did not save: ${error.message}`,
      };
    }
    if (!data) return { ok: false, error: GONE };
  }

  return answer(supabase, bucket.channelId, bucket.axis, slug);
}

/* -------------------------------------------------------------------------- */
/* Move                                                                        */
/* -------------------------------------------------------------------------- */

const MoveInput = z.object({
  bucketId: z.uuid(),
  direction: z.enum(["up", "down"]),
});

export type MoveBucketInput = z.input<typeof MoveInput>;

/**
 * One step up or down its axis — which is one row or column left or right on
 * the matrix, and one place in the pickers.
 *
 * The whole axis is renumbered 1..n in the new order and written back as one
 * upsert: `insert … on conflict (id) do update`, one request, one statement,
 * one transaction, the deferrable unique on `(channel_id, axis, position)`
 * checked once at commit after every row has moved. Done as two updates the
 * swap would trip that unique halfway through. The name and quota ride along
 * because an upsert has to be a valid insert; they are the values read a
 * moment ago through RLS, not values the caller supplied.
 */
export async function moveBucketAction(input: MoveBucketInput): Promise<BucketWriteResult> {
  const parsed = MoveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a move this page could ask for." };
  }
  const { bucketId, direction } = parsed.data;

  const { supabase } = await requireUser();

  const found = await readBucket(supabase, bucketId);
  if (found === null) return { ok: false, error: GONE };
  if ("error" in found) return { ok: false, error: found.error };
  const { bucket, slug } = found;

  const current = await readAxis(supabase, bucket.channelId, bucket.axis);
  if ("error" in current) return { ok: false, error: current.error };

  const next = moveBucket(current.buckets, bucketId, direction);
  // Off the end: nothing to write, nothing wrong. Answer with the axis as is.
  if (next !== null) {
    const written = await reorderAxis(supabase, current.buckets, next);
    if (written !== null) return { ok: false, error: written };
  }

  return answer(supabase, bucket.channelId, bucket.axis, slug);
}

/**
 * Write a whole axis's positions as one statement. `next` must be a
 * permutation of `current` — checked, so a stale list cannot re-insert a
 * bucket removed in another tab. Returns the error sentence, or null.
 */
async function reorderAxis(
  supabase: Supabase,
  current: readonly SettingsBucket[],
  next: readonly SettingsBucket[],
): Promise<string | null> {
  if (!isPermutationOf(next.map((bucket) => bucket.id), current)) {
    return "That order does not match the channel's buckets as they stand — one was added or removed since this page loaded. Reload and try again.";
  }
  const before = new Map(current.map((bucket) => [bucket.id, bucket.position]));
  if (next.every((bucket) => before.get(bucket.id) === bucket.position)) return null;

  const { error } = await supabase.from("buckets").upsert(
    next.map((bucket) => ({
      id: bucket.id,
      channel_id: bucket.channelId,
      axis: bucket.axis,
      name: bucket.name,
      position: bucket.position,
      monthly_quota: bucket.monthlyQuota,
    })),
    { onConflict: "id" },
  );

  return error ? `That order did not save: ${error.message}` : null;
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                      */
/* -------------------------------------------------------------------------- */

const RemoveInput = z.object({ bucketId: z.uuid() });

export type RemoveBucketInput = z.input<typeof RemoveInput>;

export type RemoveBucketResult =
  | {
      ok: true;
      axis: "vertical" | "horizontal";
      buckets: SettingsBucket[];
      /** The name it had, and how many videos were unfiled by its going. */
      removed: { name: string; unfiled: number };
    }
  | { ok: false; error: string };

/**
 * Delete a bucket. The composite key on `videos` is `on delete set null`, so
 * the videos filed under it are unfiled on this axis and otherwise untouched;
 * the count is read first, in the same call, so the answer can say exactly
 * what happened. The screen has already said it before the click, from the
 * count the page loaded with.
 */
export async function removeBucket(input: RemoveBucketInput): Promise<RemoveBucketResult> {
  const parsed = RemoveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a bucket this page could ask about." };
  }
  const { bucketId } = parsed.data;

  const { supabase } = await requireUser();

  const found = await readBucket(supabase, bucketId);
  if (found === null) return { ok: false, error: GONE };
  if ("error" in found) return { ok: false, error: found.error };
  const { bucket, slug } = found;

  const column = bucket.axis === "vertical" ? "vertical_id" : "horizontal_id";
  const { count, error: countError } = await supabase
    .from("videos")
    .select("id", { count: "exact", head: true })
    .eq(column, bucketId);
  if (countError) {
    return { ok: false, error: `Could not check what is filed under ${bucket.name}: ${countError.message}` };
  }

  const { data, error } = await supabase
    .from("buckets")
    .delete()
    .eq("id", bucketId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `That did not remove: ${error.message}` };
  if (!data) return { ok: false, error: GONE };

  const after = await readAxis(supabase, bucket.channelId, bucket.axis);
  if ("error" in after) return { ok: false, error: after.error };
  revalidateBucketViews(slug);
  return {
    ok: true,
    axis: bucket.axis,
    buckets: after.buckets,
    removed: { name: bucket.name, unfiled: count ?? 0 },
  };
}
