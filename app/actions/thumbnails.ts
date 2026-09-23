"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  alreadyLiveMessage,
  describeReasonRejection,
  LAUNCH_REASON,
  MAX_SWAP_REASON_LENGTH,
  noAssetMessage,
  ROLE_LABEL,
  shippedCannotBeRemovedMessage,
} from "@/components/thumbnails/roles";
import {
  isThumbnailRole,
  parseThumbnailVariantPath,
  removeObjects,
  thumbnailVariantPath,
  THUMBNAIL_ROLES,
  type ThumbnailRole,
} from "@/lib/storage";
import { requireUser } from "@/lib/supabase/require-user";
import { cleanProse } from "@/lib/text";

/**
 * The three thumbnail variants: recording one, removing one, and shipping one.
 *
 * ## Three writes, and only one of them is an UPDATE
 *
 * `recordThumbnailVariant` and `removeThumbnailVariant` write a
 * `videos.thumb_*_path` column, which clients hold a grant on. **Shipping does
 * not**: `update (shipped_role)` is revoked from `authenticated` in
 * `0001_init.sql`, so `shipThumbnail` has no choice but to go through the
 * `swap_thumbnail` security-definer function — which writes the
 * `thumbnail_swaps` row and the new `shipped_role` in one transaction, or
 * neither. That is not a convention this file follows; it is the only door
 * there is, and it is enforced by the database rather than by review.
 *
 * ## The bytes are already in Storage when these run
 *
 * PLAN.md warning 1, the same as `app/actions/uploads.ts`: a server action is a
 * request body and Vercel caps those at 4.5 MB, so the browser uploads with its
 * own session and this is told only the path. Nothing in this file holds image
 * bytes.
 *
 * ## The CHECKs are the guard, and this file is their translator
 *
 * Two constraints in `0001_init.sql` do the real work here:
 *
 * - `videos_shipped_role_has_asset` — a shipped role always has an image. It
 *   refuses shipping an empty slot *and* refuses removing the image out from
 *   under the role that is live, which is one rule read from two directions.
 * - `thumbnail_swaps_roles` — `from_role is distinct from to_role`, so the log
 *   can never contain a swap that swapped nothing.
 *
 * None of that is re-implemented above the database. What this file adds is the
 * sentence a person can act on, instead of `new row for relation "videos"
 * violates check constraint "videos_shipped_role_has_asset"`.
 */

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

/** Which column each role's path lives in. The schema's three slots, in code. */
const PATH_COLUMN = {
  wild_card: "thumb_wild_card_path",
  moderate: "thumb_moderate_path",
  safe: "thumb_safe_path",
} as const satisfies Record<ThumbnailRole, string>;

const Role = z.enum(THUMBNAIL_ROLES);

/**
 * A one-column patch for a role's path.
 *
 * Written as a switch rather than `{ [PATH_COLUMN[role]]: value }` because a
 * computed key widens to an index signature, and supabase-js's generated
 * `update()` type rejects anything wider than the row's own columns — which is
 * the check earning its keep: a typo in a column name has to be a type error
 * here, not an update that silently matches nothing.
 */
function pathPatch(role: ThumbnailRole, value: string | null) {
  switch (role) {
    case "wild_card":
      return { thumb_wild_card_path: value };
    case "moderate":
      return { thumb_moderate_path: value };
    case "safe":
      return { thumb_safe_path: value };
  }
}

/** The columns every one of these actions reads back, in one place. */
const VARIANT_COLUMNS =
  "id, channel_id, updated_at, shipped_role, thumb_wild_card_path, thumb_moderate_path, thumb_safe_path";

export interface VariantPaths {
  readonly wild_card: string | null;
  readonly moderate: string | null;
  readonly safe: string | null;
}

/** What every success hands back, so the page can re-render without guessing. */
export interface ThumbnailState {
  readonly paths: VariantPaths;
  readonly shippedRole: ThumbnailRole | null;
  /**
   * The `updated_at` this write stamped.
   *
   * Every one of these writes the row, so the detail page's shared version
   * token has to hear about it or the next packaging save looks like somebody
   * else's write — see `components/video-version.tsx`.
   */
  readonly updatedAt: string | null;
}

export type ThumbnailResult =
  | ({ ok: true } & ThumbnailState)
  | { ok: false; error: string };

type VideoRow = {
  id: string;
  channel_id: string;
  updated_at: string | null;
  shipped_role: string | null;
  thumb_wild_card_path: string | null;
  thumb_moderate_path: string | null;
  thumb_safe_path: string | null;
};

function stateOf(row: VideoRow): ThumbnailState {
  return {
    paths: {
      wild_card: row.thumb_wild_card_path,
      moderate: row.thumb_moderate_path,
      safe: row.thumb_safe_path,
    },
    shippedRole: isThumbnailRole(row.shipped_role) ? row.shipped_role : null,
    updatedAt: row.updated_at,
  };
}

/**
 * The paths that stop existing for the page when this write lands.
 *
 * `/now` reads `shipped_role` for its swap row, and the board card does not
 * show variants but does show everything else on the row that these writes
 * stamp. The slug is looked up rather than passed in, so a caller cannot aim a
 * revalidation at a path it does not own.
 */
async function revalidateForVideo(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  videoId: string,
  channelId: string,
): Promise<void> {
  revalidatePath(`/videos/${videoId}`);
  revalidatePath("/now");

  const { data: channel } = await supabase
    .from("channels")
    .select("slug")
    .eq("id", channelId)
    .maybeSingle();

  if (channel) revalidatePath(`/c/${channel.slug}/board`);
}

/* -------------------------------------------------------------------------- */
/* Recording an upload                                                         */
/* -------------------------------------------------------------------------- */

const RecordInput = z.object({
  videoId: z.uuid(),
  role: Role,
  /**
   * The object name the browser uploaded to. Checked against the convention
   * rather than trusted: this action can only be made to write a path of the
   * shape `{caller}/{that video}/{that role}.{known ext}`, so the worst a
   * forged call can do is point a video at an object the caller already owns.
   * The real boundary is the storage policy — see `lib/storage.ts`.
   */
  path: z.string().max(200),
});

export type RecordThumbnailVariantInput = z.input<typeof RecordInput>;

export async function recordThumbnailVariant(
  input: RecordThumbnailVariantInput,
): Promise<ThumbnailResult> {
  const parsed = RecordInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That upload was not something the app asked for." };
  }
  const { videoId, role, path } = parsed.data;

  const { supabase, user } = await requireUser();

  const pieces = parseThumbnailVariantPath(path);
  if (
    !pieces ||
    pieces.userId !== user.id ||
    pieces.videoId !== videoId ||
    pieces.role !== role ||
    thumbnailVariantPath(user.id, videoId, role, pieces.extension) !== path
  ) {
    return { ok: false, error: `That is not this video's ${ROLE_LABEL[role]} path.` };
  }

  // RLS scopes this read, so another user's video is indistinguishable from an
  // id that was never issued — the same 404-shaped answer the page gives.
  const { data: video, error: readError } = await supabase
    .from("videos")
    .select(VARIANT_COLUMNS)
    .eq("id", videoId)
    .maybeSingle<VideoRow>();

  if (readError) return { ok: false, error: `Could not save that: ${readError.message}` };
  if (!video) return { ok: false, error: "That video does not exist any more." };

  const previous = video[PATH_COLUMN[role]];

  // A re-upload of the same *format* landed on the same object name and has
  // already replaced it (`upsert: true`); there is nothing to remove. A
  // different format is a different name, so the old object would sit in the
  // bucket forever with nothing referencing it. Removed before the row is
  // updated, which is the order PLAN.md gives and the safer failure: a row
  // pointing at a missing object degrades to "could not be loaded", whereas
  // the other way round leaves an invisible orphan nothing will clean up.
  if (previous && previous !== path) {
    await removeObjects(supabase, [previous]);
  }

  const { data: written, error: updateError } = await supabase
    .from("videos")
    .update({ ...pathPatch(role, path), updated_at: new Date().toISOString() })
    .eq("id", videoId)
    .select(VARIANT_COLUMNS)
    .maybeSingle<VideoRow>();

  if (updateError || !written) {
    return {
      ok: false,
      error: `The image uploaded, but the video did not keep it: ${
        updateError?.message ?? "the row did not come back"
      }`,
    };
  }

  await revalidateForVideo(supabase, videoId, written.channel_id);

  return { ok: true, ...stateOf(written) };
}

/* -------------------------------------------------------------------------- */
/* Removing one                                                                */
/* -------------------------------------------------------------------------- */

const RemoveInput = z.object({ videoId: z.uuid(), role: Role });

export type RemoveThumbnailVariantInput = z.input<typeof RemoveInput>;

/**
 * Clear a slot: the column first, then the object.
 *
 * The order is deliberate and it is the opposite of the one above. Here the
 * update is the thing that can be refused — removing the image the live role
 * points at violates `videos_shipped_role_has_asset` — so the bytes must still
 * be there if it is. Deleting first would leave a video whose shipped thumbnail
 * is a path to nothing.
 */
export async function removeThumbnailVariant(
  input: RemoveThumbnailVariantInput,
): Promise<ThumbnailResult> {
  const parsed = RemoveInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a slot this page could clear." };
  }
  const { videoId, role } = parsed.data;

  const { supabase } = await requireUser();

  const { data: video, error: readError } = await supabase
    .from("videos")
    .select(VARIANT_COLUMNS)
    .eq("id", videoId)
    .maybeSingle<VideoRow>();

  if (readError) return { ok: false, error: `Could not read that video: ${readError.message}` };
  if (!video) return { ok: false, error: "That video does not exist any more." };

  const previous = video[PATH_COLUMN[role]];
  if (previous === null) {
    // Already empty. Not an error — two clicks on a slow connection is the
    // usual way this happens — so the answer is the current state.
    return { ok: true, ...stateOf(video) };
  }

  const { data: written, error: updateError } = await supabase
    .from("videos")
    .update({ ...pathPatch(role, null), updated_at: new Date().toISOString() })
    .eq("id", videoId)
    .select(VARIANT_COLUMNS)
    .maybeSingle<VideoRow>();

  if (updateError) {
    if (isAssetCheck(updateError.message)) {
      return { ok: false, error: shippedCannotBeRemovedMessage(role) };
    }
    return { ok: false, error: `That did not save: ${updateError.message}` };
  }
  if (!written) return { ok: false, error: "That video does not exist any more." };

  // The row no longer names it, so the object is unreferenced. Best effort:
  // the slot is empty either way, and a failure to tidy is not something the
  // person could act on.
  await removeObjects(supabase, [previous]);

  await revalidateForVideo(supabase, videoId, written.channel_id);

  return { ok: true, ...stateOf(written) };
}

/* -------------------------------------------------------------------------- */
/* Shipping one                                                                */
/* -------------------------------------------------------------------------- */

const ShipInput = z.object({
  videoId: z.uuid(),
  role: Role,
  /**
   * Why. Required when something is already live; absent on the first ship,
   * which is logged as `LAUNCH_REASON` — see that constant for the argument.
   */
  reason: z.string().max(MAX_SWAP_REASON_LENGTH).optional(),
});

export type ShipThumbnailInput = z.input<typeof ShipInput>;

export type ShipThumbnailResult =
  | ({ ok: true } & ThumbnailState)
  | {
      ok: false;
      error: string;
      /**
       * The refusal was "this needed a typed reason", so the caller can open
       * the dialog rather than show an error beside a button.
       */
      needsReason?: true;
      /**
       * What was live when this action looked, on a `needsReason` refusal.
       *
       * The caller cannot work this out for itself. It decides whether to open
       * the dialog from the `shipped_role` its page was rendered with, and the
       * whole point of this refusal is that that prop is *stale* — another tab
       * shipped something between the render and the click. Returning what the
       * row actually holds is what makes the recovery reachable rather than a
       * branch that can never be taken.
       */
      currentRole?: ThumbnailRole;
    };

export async function shipThumbnail(
  input: ShipThumbnailInput,
): Promise<ShipThumbnailResult> {
  const parsed = ShipInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That was not a variant this page could ship." };
  }
  const { videoId, role, reason } = parsed.data;

  const { supabase } = await requireUser();

  // Read only for the two things this action genuinely decides: whether a
  // reason is required, and whether the answer is "already live". Whether the
  // slot *has an image* is deliberately not read — that is
  // `videos_shipped_role_has_asset`'s question, and asking it here would make
  // the constraint decorative.
  const { data: video, error: readError } = await supabase
    .from("videos")
    .select(VARIANT_COLUMNS)
    .eq("id", videoId)
    .maybeSingle<VideoRow>();

  if (readError) return { ok: false, error: `Could not read that video: ${readError.message}` };
  if (!video) return { ok: false, error: "That video does not exist any more." };

  const current = isThumbnailRole(video.shipped_role) ? video.shipped_role : null;

  if (current === role) {
    return { ok: false, error: alreadyLiveMessage(role) };
  }

  let logReason: string;
  if (current === null) {
    logReason = LAUNCH_REASON;
  } else {
    const rejection = describeReasonRejection(reason ?? "");
    if (rejection) {
      return {
        ok: false,
        error: rejection,
        needsReason: true,
        // `current`, not the caller's idea of it — see `currentRole` above.
        currentRole: current,
      };
    }
    logReason = cleanProse(reason ?? "").trim();
  }

  /*
    The only write path there is.

    `swap_thumbnail` inserts the `thumbnail_swaps` row with `from_role =` the
    current `shipped_role`, then updates `shipped_role`, inside one function
    call and therefore one transaction. If the update is refused — an empty
    slot, the asset CHECK — the insert goes with it and the log does not gain a
    row for a swap that never happened. Nothing above the database could
    reproduce that: supabase-js has no transactions.
  */
  const { data, error } = await supabase.rpc("swap_thumbnail", {
    p_video: videoId,
    p_to_role: role,
    p_reason: logReason,
  });

  if (error) {
    if (isAssetCheck(error.message)) {
      return { ok: false, error: noAssetMessage(role) };
    }
    if (/thumbnail_swaps_roles/.test(error.message)) {
      return { ok: false, error: alreadyLiveMessage(role) };
    }
    if (/reason/.test(error.message) && /check/i.test(error.message)) {
      return {
        ok: false,
        error: describeReasonRejection("") ?? error.message,
        needsReason: true,
        ...(current === null ? {} : { currentRole: current }),
      };
    }
    return { ok: false, error: `The swap was refused: ${error.message}` };
  }
  if (!data) {
    return { ok: false, error: "The swap returned nothing. Reload the page." };
  }

  await revalidateForVideo(supabase, videoId, data.channel_id);

  return { ok: true, ...stateOf(data as VideoRow) };
}

/**
 * Is this Postgres telling us a shipped role would have no asset?
 *
 * Matched on the constraint's name rather than on a code alone: 23514 is every
 * CHECK on the table, and `videos` has several. PostgREST passes the whole
 * message through, so the name is there to match.
 */
function isAssetCheck(message: string): boolean {
  return /videos_shipped_role_has_asset/.test(message);
}
