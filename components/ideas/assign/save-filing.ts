import { updateVideo, type VideoState } from "@/app/actions/videos";
import type { SaveResult } from "@/components/autosave";
import type { VideoVersion } from "@/components/video-version";

/**
 * How the filing block writes: through `updateVideo`, the page's one write
 * path, carrying the page's one version token.
 *
 * Two controls send these patches — the bucket row and the tag editor — and
 * they are two components because they are two different interactions, not
 * because they are two different mechanisms. Both go through this function so
 * neither can quietly grow its own error handling, forget the version
 * precondition, or start sending relative changes.
 *
 * The values are absolute, like everything else this page sends: the whole tag
 * list, the bucket id or `null`. That is what makes the save queue in
 * `components/autosave.tsx` able to merge two edits into one write without
 * thinking about order.
 */
export interface FilingPatch {
  readonly verticalId?: string | null;
  readonly horizontalId?: string | null;
  readonly tags?: readonly string[];
}

export async function saveFiling(
  videoId: string,
  version: VideoVersion,
  patch: FilingPatch,
  onSaved: (video: VideoState) => void,
): Promise<SaveResult> {
  // The version this patch was computed against, so a row something else has
  // changed in the meantime is reported rather than overwritten. `undefined`
  // means there is no provider — an editor rendered outside the page — and its
  // writes are not refused for that.
  const expected = version.peek();

  const result = await updateVideo({
    videoId,
    ...(expected === undefined ? {} : { expectedUpdatedAt: expected }),
    ...(patch.verticalId === undefined ? {} : { verticalId: patch.verticalId }),
    ...(patch.horizontalId === undefined
      ? {}
      : { horizontalId: patch.horizontalId }),
    ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
  });

  if (!result.ok) {
    return { ok: false, error: result.error, conflict: result.conflict };
  }

  /*
    The page's version token advances here, once, for both callers.

    Every write on `/videos/[id]` stamps `updated_at`, and the next write has to
    quote the value its own patch was computed against. A caller that forgot
    this would send a token the row has moved past — its *own* previous save —
    and report a conflict that is not one, which is worse than the clobbering
    the token exists to prevent. So it is not a caller's job; see
    `components/video-version.tsx`.
  */
  version.adopt(result.video.updatedAt);
  onSaved(result.video);
  return { ok: true };
}
