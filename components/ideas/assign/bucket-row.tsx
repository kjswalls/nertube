"use client";

import { useState } from "react";

import type { VideoState } from "@/app/actions/videos";
import { SaveStatus, useSaveQueue } from "@/components/autosave";
import { useVideoVersion } from "@/components/video-version";
import type { BucketChoices } from "@/lib/buckets";

import { BucketSelect } from "./bucket-select";
import { saveFiling, type FilingPatch } from "./save-filing";

/**
 * Where this video sits in its channel's matrix: one topic pillar, one format.
 *
 * ## One of each, by construction
 *
 * Two controls, each holding one value, each offered only its own axis's
 * buckets from this video's own channel. There is no arrangement of clicks that
 * produces two verticals, a bucket from another channel or a format in the
 * pillar slot — and if one ever did arrive (a stale page, a hand-made POST),
 * the three-column composite foreign key refuses it and
 * `describeBucketRefusal` turns that refusal into a sentence with a Reload
 * beside it. See `components/ideas/assign/bucket-select.tsx`.
 *
 * ## It saves like everything else on this page
 *
 * Through `updateVideo`, on change, with the page's version token — the same
 * queue `components/autosave.tsx` gives the title, the notes and the hooks.
 * There is no blur to wait for: picking from a menu *is* the decision, exactly
 * as it is for the target date.
 *
 * The menus show the new value immediately and fall back to what the server
 * last confirmed if the write fails, which is the only way this control can be
 * honest about a refusal: a select that keeps showing a bucket the row does not
 * hold would be a lie the person cannot see.
 */
export function BucketRow({
  videoId,
  choices,
  verticalId,
  horizontalId,
  onSaved,
}: {
  videoId: string;
  /** This video's channel's buckets, already split by axis. */
  choices: BucketChoices;
  /** `videos.vertical_id` / `horizontal_id` as the server render read them. */
  verticalId: string | null;
  horizontalId: string | null;
  /** The row the save confirmed — the page adopts its `updated_at`. */
  onSaved?: (video: VideoState) => void;
}) {
  const version = useVideoVersion();

  /** What the server last confirmed. The fallback when a write is refused. */
  const [confirmed, setConfirmed] = useState({
    verticalId: verticalId ?? "",
    horizontalId: horizontalId ?? "",
  });
  /** What the menus show — ahead of the server while a save is in flight. */
  const [shown, setShown] = useState(confirmed);

  const { state, pending, send } = useSaveQueue<FilingPatch>({
    save: async (patch) =>
      saveFiling(videoId, version, patch, (video) => {
        const next = {
          verticalId: video.verticalId ?? "",
          horizontalId: video.horizontalId ?? "",
        };
        // Re-read from the row rather than assumed: this is what is stored.
        setConfirmed(next);
        setShown(next);
        onSaved?.(video);
      }),
    // A failure parks whatever was queued behind it rather than sending it, so
    // the menus have to go back to the row for that work too — otherwise a
    // second pick made during a failing save would sit on screen forever
    // without ever having been written.
    onFailure: () => setShown(confirmed),
  });

  function choose(axis: "vertical" | "horizontal", value: string): void {
    const next = { ...shown, [`${axis}Id`]: value };
    setShown(next);
    // `null` unfiles; `""` is what the empty option holds and is not a bucket.
    send(
      axis === "vertical"
        ? { verticalId: value === "" ? null : value }
        : { horizontalId: value === "" ? null : value },
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="bucket-row">
      <div className="flex flex-wrap gap-3">
        <BucketSelect
          axis="vertical"
          testId="video-vertical"
          options={choices.verticals}
          value={shown.verticalId}
          onChange={(next) => choose("vertical", next)}
          disabled={pending}
        />
        <BucketSelect
          axis="horizontal"
          testId="video-horizontal"
          options={choices.horizontals}
          value={shown.horizontalId}
          onChange={(next) => choose("horizontal", next)}
          disabled={pending}
        />
      </div>

      <SaveStatus
        state={state}
        testId="bucket-row-status"
        idle={
          shown.verticalId === "" && shown.horizontalId === ""
            ? "Not filed yet — it shows up in the bank, but in no cell of the matrix."
            : ""
        }
        onRetry={send}
      />
    </div>
  );
}
