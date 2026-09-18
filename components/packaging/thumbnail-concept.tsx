"use client";

import { useId } from "react";

/**
 * The written thumbnail concept — the field the gate actually reads.
 *
 * ## The one thing this component exists to prevent
 *
 * `videos.thumbnail_concept` (text, written here) and
 * `videos.thumbnail_concept_path` (an uploaded image, the "concept sketch" on
 * the detail page) are two different columns at two different stages, and M1's
 * review found the app shipping a refusal that said "Packaging still needs a
 * thumbnail concept" to someone looking at a card with a visible sketch on it.
 * The gate reads the text. It has never read the picture.
 *
 * So the label says *written*, the help line says which of the two the gate
 * reads and what the sketch is for, and the placeholder is a description rather
 * than a file name. PLAN.md and BRIEF.md both separate concept from asset — the
 * concept is decided at the TTH stage so the right shots get filmed, and the
 * actual thumbnail files are made much later, at Publish Prep.
 *
 * A textarea, not an input: a concept is "face left, shocked, three props on
 * the desk, big yellow number 3" — a sentence or two, and a field that scrolls
 * sideways discourages writing the second half of it.
 */
export function ThumbnailConcept({
  anchorId,
  value,
  onChange,
  onCommit,
  maxLength,
}: {
  /**
   * The textarea's `id` — `GATE_ANCHOR.thumbnail_concept`. A refusal that says
   * the concept is missing links straight into this box.
   */
  anchorId: string;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  maxLength: number;
}) {
  const helpId = useId();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={anchorId} className="text-xs font-medium text-muted">
        Thumbnail concept (written)
      </label>

      <p id={helpId} className="text-xs text-muted">
        Describe the picture in words — subject, expression, framing, the two or
        three words on it. <strong className="font-medium">This is the field
        the gate reads.</strong> The concept sketch you upload is a reference
        image and does not satisfy it.
      </p>

      <textarea
        id={anchorId}
        name="thumbnailConcept"
        value={value}
        rows={3}
        maxLength={maxLength}
        placeholder="Face left, shocked, three props on the desk, big yellow 3"
        aria-describedby={helpId}
        data-testid="thumbnail-concept"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        className="w-full resize-y rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </div>
  );
}
