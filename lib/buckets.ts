/**
 * Content buckets, as everything outside the database speaks about them.
 *
 * A bucket is a row in `buckets`: one channel's `vertical` (a topic pillar) or
 * `horizontal` (a format). A video may carry **one of each**, and that is not a
 * rule this file enforces — it is the shape of the schema. `videos` has exactly
 * two bucket columns, `vertical_id` and `horizontal_id`, each bound by a
 * three-column foreign key through a pinned axis column:
 *
 * ```sql
 * foreign key (vertical_id, channel_id, vertical_axis)
 *   references public.buckets (id, channel_id, axis) on delete set null (vertical_id)
 * ```
 *
 * So "at most one vertical" is *one column*, "this channel's" is the middle
 * member of the key, and "of the right axis" is the third. There is nothing for
 * application code to check and nothing it could weaken. What application code
 * owes the user is a picker that cannot offer a choice the key would refuse —
 * which is why the options in `BucketChoices` are two lists, already split by
 * axis and already scoped to one channel, rather than one list with an `axis`
 * field that a caller could filter wrongly.
 *
 * Pure, so the server actions, the capture form and the video page can all
 * import it: no `server-only`, no Supabase, no React.
 */

/** One option in a picker: the bucket's id, and the word on it. */
export interface BucketOption {
  readonly id: string;
  readonly name: string;
}

/** One channel's buckets, split by axis — the only shape a picker is given. */
export interface BucketChoices {
  readonly verticals: readonly BucketOption[];
  readonly horizontals: readonly BucketOption[];
}

export const NO_BUCKETS: BucketChoices = { verticals: [], horizontals: [] };

/** The two axes, and what each is called in front of a person. */
export const AXIS_LABEL = {
  vertical: "Topic pillar",
  horizontal: "Format",
} as const;

export type BucketAxis = keyof typeof AXIS_LABEL;

/**
 * What the empty option in a bucket picker says.
 *
 * Not "None": a video with no vertical is not a video that was assigned
 * nothing, it is one nobody has filed yet, and the matrix counts it nowhere.
 */
export const UNFILED = "— not filed —";

/**
 * A Postgres refusal about a bucket, in a sentence.
 *
 * `23503` is `foreign_key_violation`. Reaching it from the video page means one
 * of three things — the bucket was deleted or renamed in another tab, the ids
 * on this page belong to a channel this video is no longer in, or something
 * posted a hand-made patch — and all three have the same honest answer: this
 * page is looking at something the database has moved past, so reload it. The
 * message is worth writing down rather than passing `error.message` through,
 * because Postgres's own wording is
 * `insert or update on table "videos" violates foreign key constraint
 * "videos_vertical_id_channel_id_vertical_axis_fkey"`, which tells the person
 * nothing they can act on.
 *
 * `null` when the error is not about a bucket, so the caller falls through to
 * its own reporting rather than mislabelling every refusal as this one.
 */
export function describeBucketRefusal(
  code: string | undefined,
  message: string,
): string | null {
  if (code !== "23503") return null;
  const vertical = message.includes("vertical_id");
  const horizontal = message.includes("horizontal_id");
  if (!vertical && !horizontal) return null;

  const which = vertical ? "topic pillar" : "format";
  return (
    `The database refused that ${which}: a video can only be filed under its own ` +
    `channel's buckets, on the matching axis. The bucket was probably deleted or ` +
    `renamed somewhere else — reload to see this channel's buckets as they are now.`
  );
}

/* -------------------------------------------------------------------------- */
/* Membership — the one answer to "is this video in that bucket?"              */
/* -------------------------------------------------------------------------- */

/**
 * The two bucket slots a video carries, one per axis.
 *
 * Deliberately structural rather than a named row type: the idea bank's `Idea`,
 * the matrix's `MatrixVideo` and a raw `videos` row all satisfy it, so all
 * three can be asked the same question without first being converted into a
 * common shape.
 */
export interface BucketSlots {
  readonly verticalId: string | null;
  readonly horizontalId: string | null;
}

/**
 * Which bucket this video sits in on `axis`, or `null` when it is unfiled.
 *
 * This is the whole of "which bucket is it in", and it exists as a function for
 * one reason: the idea bank filters by bucket and the matrix counts by bucket,
 * and if those two ever answered differently the product would be showing a
 * cell that says 3 above a list that shows 2, with nothing on either page to
 * say which one is lying. `components/ideas/list/filtering.ts` and
 * `components/ideas/matrix/tally.ts` both route through here, and
 * `components/ideas/agreement.test.ts` runs one fixture through both and
 * asserts they name the same videos.
 *
 * It takes the axis as an argument rather than exposing the two fields because
 * the axis is the thing that varies — a caller holding `axis` as data (a filter
 * key, a URL parameter, a column header) would otherwise write the ternary
 * itself, once per call site, which is the duplication this is here to
 * prevent.
 */
export function bucketOn(slots: BucketSlots, axis: BucketAxis): string | null {
  return axis === "vertical" ? slots.verticalId : slots.horizontalId;
}

/**
 * Does this video sit in `bucketId` on `axis`?
 *
 * `null` for `bucketId` means "any bucket, and unfiled too" — the filter is off.
 * That is the convention both callers need: a bank with no vertical filter
 * shows every row, including the ones with no vertical at all.
 */
export function inBucket(
  slots: BucketSlots,
  axis: BucketAxis,
  bucketId: string | null,
): boolean {
  return bucketId === null || bucketOn(slots, axis) === bucketId;
}
