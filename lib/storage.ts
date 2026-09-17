import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

/**
 * Everything the app knows about the `thumbnails` bucket: the path convention,
 * what counts as an image, and how a batch of private paths becomes a batch of
 * URLs a browser can load.
 *
 * One file so the browser and the server cannot disagree. The upload happens in
 * the browser (`components`/`app/videos/[id]/concept-sketch.tsx`) and the path
 * is recorded by a server action (`app/actions/uploads.ts`); if each built the
 * object name its own way, a typo would not be a type error, it would be an
 * orphaned object nobody ever sees again.
 *
 * ## The bytes never touch the server
 *
 * PLAN.md warning 1: Vercel caps a request body at 4.5 MB, and a server action
 * *is* a request body. So the file goes browser → Supabase Storage directly,
 * with the user's own session, and the server action records only the resulting
 * path. Nothing here ever holds image bytes.
 */

/** The one private bucket. `0001_init.sql` creates it with `public = false`. */
export const THUMBNAILS_BUCKET = "thumbnails";

/**
 * The image types a sketch may be, and the extension each one gets.
 *
 * Keyed by MIME type rather than by the uploaded filename: a filename is a
 * label a person typed, `File.type` is what the browser sniffed, and the object
 * name has to be predictable for the `{user}/{video}/concept.{ext}` convention
 * to mean anything. `jpeg` folds onto `jpg` so the same picture re-uploaded
 * from a different camera roll lands on the same object instead of beside it.
 */
export const CONCEPT_SKETCH_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** The extensions the above can produce — what a stored path may end in. */
const ALLOWED_EXTENSIONS = new Set(Object.values(CONCEPT_SKETCH_TYPES));

/** The `accept` attribute for the file input, from the same list. */
export const CONCEPT_SKETCH_ACCEPT = Object.keys(CONCEPT_SKETCH_TYPES).join(",");

/**
 * The size ceiling, in bytes.
 *
 * A thumbnail concept is a phone photo of a scribble or a rough mock; YouTube
 * itself refuses a thumbnail over 2 MB, so 5 MB is generous for the *source* of
 * one. The number exists to catch the accidental 40 MB raw export before it is
 * uploaded over a hotel wifi, not to be a security control.
 */
export const MAX_SKETCH_BYTES = 5 * 1024 * 1024;

/** `5 MB`, for a message. */
export const MAX_SKETCH_LABEL = `${MAX_SKETCH_BYTES / (1024 * 1024)} MB`;

/**
 * What a client-side check may say about a file, or `null` when it is fine.
 *
 * **This is not security.** It runs in the browser, where the person can skip
 * it with two lines in a console, and the server action that follows never sees
 * the bytes at all, so it cannot re-check them either. The real boundary is the
 * storage policy in `0001_init.sql`:
 *
 * ```sql
 * create policy "thumbnails owner rw" on storage.objects
 *   using      (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text)
 *   with check (…same…);
 * ```
 *
 * That policy is what stops one user writing into another's folder, and it runs
 * in Postgres on every request. This function exists so the *honest* mistake —
 * picking a PDF, picking a 40 MB file — is refused instantly and legibly,
 * instead of by an upload that spends a minute and then fails.
 *
 * (A per-bucket MIME/size limit on the bucket row would be the server-side half
 * of this. `0001_init.sql` does not set one; adding it is a schema change and
 * schema is not M1's to touch.)
 */
export function describeSketchRejection(file: {
  type: string;
  size: number;
  name: string;
}): string | null {
  if (!(file.type in CONCEPT_SKETCH_TYPES)) {
    const what =
      file.type === "" ? "that file" : `a ${file.type.replace(/^.*\//, "")} file`;
    return (
      `A concept sketch has to be an image — ${what} is not one. ` +
      `PNG, JPEG, WebP, GIF or AVIF.`
    );
  }
  if (file.size > MAX_SKETCH_BYTES) {
    return `That image is ${formatBytes(file.size)}; the limit is ${MAX_SKETCH_LABEL}.`;
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} bytes`;
}

/** The extension a file of this MIME type is stored under, or null. */
export function sketchExtensionFor(mimeType: string): string | null {
  return CONCEPT_SKETCH_TYPES[mimeType] ?? null;
}

/**
 * The stable object name: `{user_id}/{video_id}/concept.{ext}`.
 *
 * Stable is the point. Uploading with `upsert: true` onto this name replaces
 * the previous sketch rather than adding a second object nobody references, so
 * a video can never accumulate a folder of dead PNGs. The one case that does
 * leave an old object behind is a *changed extension* (JPEG replaced by PNG),
 * which is why `recordConceptSketch` deletes the previous path when it differs.
 *
 * The first segment is the user id because the storage policy reads exactly
 * that segment. The convention and the policy are the same decision.
 */
export function conceptSketchPath(
  userId: string,
  videoId: string,
  extension: string,
): string {
  return `${userId}/${videoId}/concept.${extension}`;
}

/** The pieces of a concept-sketch path, or `null` if it is not one. */
export function parseConceptSketchPath(
  path: string,
): { userId: string; videoId: string; extension: string } | null {
  const match = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/concept\.([a-z0-9]+)$/.exec(
    path,
  );
  if (!match) return null;
  const [, userId, videoId, extension] = match;
  if (!ALLOWED_EXTENSIONS.has(extension)) return null;
  return { userId, videoId, extension };
}

/** How long a signed URL lives. PLAN.md: `createSignedUrls(paths, 3600)`. */
export const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Stamp a signed URL with the version of the object behind it.
 *
 * The stable path is what keeps the bucket clean, and it is also what makes
 * this necessary. Replace a sketch and the new signed URL can come back
 * *character for character identical* to the old one — same path, and a token
 * whose only moving part is an expiry measured in whole seconds. An identical
 * `src` is not an update: React does not touch the attribute, so the browser
 * never asks for anything, and even if it did, objects are served with
 * `Cache-Control: max-age=3600` and it would be handed back what it already
 * has. The page keeps showing the old picture.
 *
 * The window is one second wide, which is why this is easy to miss by hand and
 * why the e2e spec caught it on the first run: replacing an image straight
 * after uploading it is exactly what someone comparing two sketches does.
 *
 * `cacheNonce` is storage-js's own query parameter for this. The version passed
 * in is `videos.updated_at`, which `recordConceptSketch` bumps to the
 * millisecond on every successful upload. It also moves when anything else on
 * the row is edited, which is the right way round to be wrong: the worst that
 * costs is re-fetching bytes the browser already had, whereas a version that
 * missed an upload would show the wrong picture.
 */
export function cacheBusted(
  url: string | null | undefined,
  version: string | null | undefined,
): string | null {
  if (!url) return null;
  if (!version) return url;
  return `${url}&cacheNonce=${encodeURIComponent(version)}`;
}

/**
 * Put the bytes at `path`, replacing whatever is there.
 *
 * Called from the browser and only from the browser — see this file's header.
 * It lives here rather than in the component so that `supabase.storage` is
 * named in exactly one file: the bucket, the upsert and the cache header are
 * one decision, not three that drift, and the cost of ever moving off Supabase
 * Storage stays the width of this module.
 */
export async function uploadSketch(
  supabase: SupabaseClient<Database>,
  path: string,
  file: File,
): Promise<{ error: string | null }> {
  const { error } = await supabase.storage
    .from(THUMBNAILS_BUCKET)
    .upload(path, file, {
      // A stable path plus upsert is what makes a re-upload a replacement
      // rather than an orphan — see `conceptSketchPath`.
      upsert: true,
      contentType: file.type,
      cacheControl: String(SIGNED_URL_TTL_SECONDS),
    });
  return { error: error ? error.message : null };
}

/**
 * Delete objects, best effort.
 *
 * Deliberately returns nothing. The only caller deletes a *superseded* object
 * — one the row no longer points at — and there is nothing useful a person
 * could do about a failure to delete it: the picture they uploaded is fine,
 * and the leftover is invisible. Reporting it would turn a successful upload
 * into an error message about housekeeping.
 */
export async function removeSketches(
  supabase: SupabaseClient<Database>,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await supabase.storage.from(THUMBNAILS_BUCKET).remove([...paths]);
}

/**
 * Sign a batch of object paths in one request.
 *
 * **Batched, never one at a time.** A board can hold a hundred cards with a
 * sketch each; `createSignedUrl` per card would be a hundred round trips from a
 * server component, serialised behind whatever the runtime allows, on every
 * render of the page the product is used from most. `createSignedUrls` is one.
 *
 * Failures are dropped rather than thrown. A path whose object has gone (a
 * hand-deleted bucket, a half-finished upload, a row updated by a build that
 * then failed) must not take the board down with it: the caller gets no URL for
 * that path and renders the same empty frame it renders for a video that never
 * had a sketch. Degrading is the specified behaviour — see the card.
 */
export async function signedUrlsFor(
  supabase: SupabaseClient<Database>,
  paths: readonly (string | null)[],
  expiresIn: number = SIGNED_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();

  // De-duplicated: two cards could, in principle, carry the same path, and the
  // API charges per entry.
  const wanted = Array.from(
    new Set(paths.filter((path): path is string => !!path)),
  );
  if (wanted.length === 0) return urls;

  const { data, error } = await supabase.storage
    .from(THUMBNAILS_BUCKET)
    .createSignedUrls(wanted, expiresIn);

  if (error || !data) return urls;

  for (const entry of data) {
    if (entry.error || !entry.path || !entry.signedUrl) continue;
    urls.set(entry.path, entry.signedUrl);
  }

  return urls;
}
