"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type ChangeEvent } from "react";

import { recordConceptSketch } from "@/app/actions/uploads";
import { useVideoVersion } from "@/components/video-version";
import {
  CONCEPT_SKETCH_ACCEPT,
  conceptSketchPath,
  describeSketchRejection,
  MAX_SKETCH_LABEL,
  sketchExtensionFor,
  uploadImage,
} from "@/lib/storage";
import { createClient } from "@/lib/supabase/client";

/**
 * The thumbnail-concept sketch: upload, and the picture once there is one.
 *
 * ## The bytes go browser → Storage, never through a server action
 *
 * PLAN.md warning 1. A server action is an HTTP request body and Vercel caps
 * those at 4.5 MB, so a 5 MB phone photo posted to an action fails in
 * production and nowhere else. The browser therefore uploads with its own
 * session — the same session the page was rendered with — and `recordConceptSketch`
 * is told only the path afterwards.
 *
 * ## The order of the two steps
 *
 * Upload first, record second. If the recording fails the object is an orphan
 * at a *stable* path, so the next successful upload of the same format lands on
 * it and it stops being one; if it were recorded first, the row would point at
 * bytes that may never arrive.
 *
 * ## The checks here are courtesy, not security
 *
 * `describeSketchRejection` runs in the browser and can be walked around from a
 * console. What actually stops a user writing outside their own folder is the
 * `thumbnails owner rw` policy on `storage.objects` in `0001_init.sql`, which
 * runs in Postgres on every request — see `lib/storage.ts`. This exists so the
 * honest mistake (a PDF, a 40 MB export) is refused instantly and legibly.
 */
export function ConceptSketch({
  videoId,
  userId,
  title,
  url,
  hasSketch,
}: {
  videoId: string;
  /** The signed-in user's id: the first segment of every path they may write. */
  userId: string;
  /** Only used for the image's alt text. */
  title: string;
  /** A signed URL for the current sketch, or null when there is none. */
  url: string | null;
  /**
   * Whether the row names a sketch at all.
   *
   * Separate from `url` because they mean different things: no path is "you
   * have not uploaded one", while a path with no URL is "there is one, and the
   * app could not get at it" — a signing failure, a deleted object. Saying "no
   * sketch yet" to the second would be a lie the person cannot act on.
   */
  hasSketch: boolean;
}) {
  const inputId = useId();
  const router = useRouter();
  const version = useVideoVersion();
  const [busy, setBusy] = useState<null | "uploading" | "saving">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** The URL whose <img> failed to load; compared against `url` so it resets. */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  const showing = url !== null && url !== brokenUrl;

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    // Read the element now: `event.currentTarget` is cleared once the handler
    // returns, and everything below this line is awaited.
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    setError(null);
    setSaved(false);

    const rejection = describeSketchRejection(file);
    const extension = sketchExtensionFor(file.type);
    if (rejection || !extension) {
      setError(rejection ?? "That file is not an image this app can store.");
      // Clear the picker so choosing the *same* file again still fires change.
      input.value = "";
      return;
    }

    const path = conceptSketchPath(userId, videoId, extension);

    setBusy("uploading");
    // The browser's own session does the writing. `uploadImage` is the one
    // place that names the bucket and the upsert; a *format* change lands on a
    // different object name, which is what `recordConceptSketch` cleans up.
    const { error: uploadError } = await uploadImage(createClient(), path, file);

    if (uploadError) {
      setBusy(null);
      setError(`The upload did not finish: ${uploadError}`);
      input.value = "";
      return;
    }

    setBusy("saving");
    let result;
    try {
      result = await recordConceptSketch({ videoId, path });
    } catch {
      // The bytes are in Storage at a stable path; only the row that names
      // them did not get written. Say exactly that, rather than letting the
      // rejection replace the page with an error screen.
      input.value = "";
      setBusy(null);
      setError(
        "The image uploaded, but the server could not be reached to record it. Choose the file again to finish.",
      );
      return;
    }
    input.value = "";
    setBusy(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSaved(true);
    // Recording a sketch writes the row, so it stamps `updated_at` — and the
    // page's shared version token has to hear about it, or the next packaging
    // save would look like somebody else's write. See `video-version.tsx`.
    version.adopt(result.updatedAt);
    // The action revalidated this route; this is what re-reads it, so the
    // <img> below comes back with a freshly signed URL for the new object.
    router.refresh();
  }

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3">
      <h3 id={`${inputId}-heading`} className="text-xs font-medium text-muted">
        Concept sketch (reference)
      </h3>

      {/*
        The name matters. BRIEF.md principle 2 separates the thumbnail
        *concept* from the thumbnail *asset*, and the packaging gate reads the
        written concept (`videos.thumbnail_concept`) — not this picture. While
        both were called "thumbnail concept", a card with a sketch on it was
        refused a move for "a thumbnail concept", which is a refusal nobody can
        act on. This is the reference image; the written concept is the field
        the gate wants, and it is the box immediately beside this one.
      */}
      <p className="text-xs text-muted">
        A sketch, a frame or a photo to look at while you write the concept.
      </p>

      {/*
        One box, one size, whatever is inside it. The frame is 16:9 and sized in
        CSS, so "no sketch", "sketch" and "the signed URL would not load" are
        the same rectangle and nothing on the page moves between them.
      */}
      <div
        data-testid="concept-sketch-frame"
        data-has-sketch={showing ? "true" : "false"}
        className={[
          "aspect-video w-full max-w-sm overflow-hidden rounded-input border",
          showing ? "border-border bg-surface" : "border-dashed border-border bg-surface/50",
        ].join(" ")}
      >
        {showing ? (
          /*
            A plain <img>, not next/image. The source is a signed URL on a host
            that comes from an environment variable and carries a token that
            expires within the hour, so `remotePatterns` cannot describe it
            statically and the optimiser would cache private bytes under a URL
            that outlives the signature. eslint-disable with the reason, rather
            than a config change that makes every future image worse.
          */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={`Thumbnail concept sketch for ${title.trim() === "" ? "this video" : title}`}
            data-testid="concept-sketch-image"
            loading="lazy"
            decoding="async"
            // A signed URL expires, an object can be deleted from under the
            // row, and a request can simply fail. Any of those would otherwise
            // be a broken-image icon; this turns it back into the empty frame.
            onError={() => setBrokenUrl(url)}
            className="h-full w-full object-cover"
          />
        ) : (
          <p className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-muted">
            {hasSketch
              ? "The sketch could not be loaded — try uploading it again."
              : "No sketch yet"}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-muted">
          {hasSketch ? "Replace the sketch" : "Upload a sketch"}
        </label>
        <input
          id={inputId}
          type="file"
          /* Named, because it is no longer the only file picker on this page:
             every section stays mounted, and the Thumbnails section brings
             three more. A bare `input[type=file]` now matches four. */
          data-testid="concept-sketch-file"
          accept={CONCEPT_SKETCH_ACCEPT}
          disabled={busy !== null}
          onChange={onFile}
          className="w-full max-w-sm text-sm file:mr-3 file:min-h-11 file:rounded-input file:border file:border-border file:bg-surface file:px-3 file:py-2 file:text-sm file:text-foreground"
        />
        <p className="text-xs text-muted">
          PNG, JPEG, WebP, GIF or AVIF, up to {MAX_SKETCH_LABEL}. A new one
          replaces the old one.
        </p>
      </div>

      <p
        role={error ? "alert" : "status"}
        data-testid="sketch-status"
        className={[
          "min-h-4 text-xs",
          error ? "text-attention" : "text-muted",
        ].join(" ")}
      >
        {error
          ? error
          : busy === "uploading"
            ? "Uploading…"
            : busy === "saving"
              ? "Saving…"
              : saved
                ? "Sketch saved"
                : ""}
      </p>
    </section>
  );
}
