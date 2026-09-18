"use client";

import { useId, useState } from "react";

import { confirmLive } from "@/app/actions/metrics";
import { useVideoVersion } from "@/components/video-version";
import { describeUrlRejection } from "@/lib/video-fields";

/**
 * "It is live" — the one gesture that turns a scheduled video into a published
 * one.
 *
 * PLAN.md, ranking rule 5: *kind `scheduled`: `target_publish_date` in the
 * future → Waiting "Goes live &lt;date&gt;"; on/after → "Confirm live + record
 * URL" (Ready) → `confirmLive` = `move_video(published, p_published_at = target
 * date)` + URL*. The same offer `/now` makes, on the page, through the same
 * action — see `app/actions/metrics.ts` for why the stage and the date are
 * resolved there rather than by whichever surface asked.
 *
 * ## Two things it will not do
 *
 * **It will not move the video without a link.** The stage is called Published
 * and BRIEF.md's exit criterion for it is *"Live, URL recorded"* — a video in
 * Published with no address is a row that cannot be checked, and the next step
 * in the loop is going to look at its analytics. The button is disabled until
 * there is something in the box, and the URL is validated as a URL before
 * anything moves.
 *
 * **It will not set the stage directly.** `UPDATE (stage_id, published_at)` is
 * revoked from clients; `move_video` is the only path, and it is the thing that
 * stamps `published_at`, snapshots the Published checklist and applies the
 * packaging gate. A confirm that wrote the columns itself would skip all three.
 */
export function ConfirmLive({
  videoId,
  initialUrl,
  due,
  targetLabel,
  onConfirmed,
}: {
  videoId: string;
  /** `videos.youtube_url` as it stands — usually empty, sometimes pre-pasted. */
  initialUrl: string;
  /** The target date has arrived (or there is none). */
  due: boolean;
  /** The target date in words, or null when there is none. */
  targetLabel: string | null;
  /** The move landed; the page needs a fresh server render. */
  onConfirmed: (message: string) => void;
}) {
  const inputId = useId();
  const version = useVideoVersion();

  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const value = url.trim();
    if (value === "") {
      setError("Paste the video's address first — that is what confirming records.");
      return;
    }
    /*
      The rule and its sentence come from `lib/video-fields.ts`, which is also
      what `YoutubeUrlSchema` is built out of — so this check and the action's
      cannot drift into disagreeing about what a link is, or into refusing the
      same thing in two different words. Checked here only so the refusal does
      not cost a round trip. The host is deliberately not checked: youtu.be, a
      Studio link and a members-only link are all things a creator legitimately
      pastes.
    */
    const rejection = describeUrlRejection(value);
    if (rejection) {
      setError(rejection);
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await confirmLive({
        videoId,
        url: value,
        // This page holds one version token for the whole row; a write that did
        // not carry it could overwrite a change made in another tab, and one
        // that did not report the new stamp would make the *next* save on this
        // page look like a conflict. See `components/video-version.tsx`.
        expectedUpdatedAt: version.peek(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      version.adopt(result.updatedAt);
      onConfirmed(`Live. Moved to ${result.stageName}.`);
    } catch {
      setError(
        "Could not reach the server, so nothing was moved. Nothing you typed has been lost — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="confirm-live"
      data-due={due ? "true" : "false"}
      className="flex flex-col gap-2"
    >
      <label htmlFor={inputId} className="text-xs font-medium text-muted">
        Confirm live and record the URL
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="url"
          data-testid="confirm-live-url"
          value={url}
          disabled={busy}
          placeholder="https://www.youtube.com/watch?v=…"
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          className="min-w-0 flex-1 rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          type="button"
          data-testid="confirm-live-save"
          disabled={busy || url.trim() === ""}
          onClick={() => void submit()}
          className="shrink-0 rounded-button border border-border px-3 py-2 text-sm outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          {busy ? "Confirming…" : "Confirm live"}
        </button>
      </div>

      <p
        data-testid="confirm-live-note"
        role={error ? "alert" : undefined}
        className={[
          "min-h-4 text-xs leading-5",
          error ? "text-over-limit" : "text-muted",
        ].join(" ")}
      >
        {error ??
          (due
            ? `Records the link and moves this into the Published stage, dated ${
                targetLabel ?? "today"
              } — the day it went live, which is what the 24-hour check counts from.`
            : `Not due until ${targetLabel ?? "its target date"}. If it went live early, the URL is all this needs.`)}
      </p>
    </div>
  );
}
