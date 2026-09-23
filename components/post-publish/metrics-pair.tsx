"use client";

import { useId, useState } from "react";

import {
  MAX_NEW_VIEWERS_NOTE,
  PAIR_REQUIRED,
  formatImpressions,
} from "@/lib/metrics";

/**
 * The first twenty-four hours: impressions, click-through, views, and the note
 * about new viewers. **One component, and impressions and CTR always both.**
 *
 * This is not a styling decision. It is the product's one non-negotiable
 * display rule, written down four times:
 *
 * - BRIEF.md, video detail page: *"Always display impressions and CTR together,
 *   never CTR alone."*
 * - PLAN.md, post-publish: *"One component renders impressions and CTR as a
 *   pair; `logMetrics` rejects one without the other."*
 * - `0001_init.sql`: `constraint videos_ctr_needs_impressions check
 *   ((first24_impressions is null) = (first24_ctr is null))`.
 * - `lib/metrics.ts`, whose `LogMetricsSchema` has no parse that produces one
 *   without the other.
 *
 * A rate without a denominator is not a measurement: 3.1% of ninety
 * impressions and 3.1% of ninety thousand are different facts, and the whole
 * post-publish loop — swap the thumbnail fast, or leave it alone — is a
 * decision made on that difference.
 *
 * ## How the rule is made structural rather than remembered
 *
 * There is one component and it has **no prop that could hide either half**.
 * Both inputs are emitted unconditionally, in one `<fieldset>`, from one
 * function; nothing about them is conditional and nothing is exported that
 * renders less than the pair. `withNote` and `withViews` govern the two fields
 * that genuinely are optional — a `/now` row has no room for a sentence about
 * new viewers — and neither of them can reach impressions or CTR.
 *
 * The only reason a component would ever be asked to show one without the other
 * is a screen where space is tight, and the answer to that is this file: put
 * the pair somewhere it fits, or show nothing.
 *
 * ## Both surfaces, one component
 *
 * `/now`'s rule-2 row (`components/now/now-row.tsx`) and the video page's
 * Publish section (`components/post-publish/post-publish-block.tsx`) render
 * this, and both send what it produces to the one `logMetrics` action. The two
 * differ only in `density`, which is spacing.
 */

/** What is stored. Both halves of the pair, or neither — never one. */
export interface MetricsValues {
  readonly impressions: number | null;
  readonly ctr: number | null;
  readonly views: number | null;
  readonly newViewersNote: string | null;
}

/** What the component asks to be written. The pair is not optional. */
export interface MetricsSubmission {
  readonly impressions: number;
  readonly ctr: number;
  readonly views: number | null;
  /** Absent when this instance does not show the note. */
  readonly newViewersNote?: string | null;
}

export function MetricsPair({
  values,
  busy,
  onSubmit,
  primaryRef,
  withNote = false,
  withViews = true,
  density = "page",
  submitLabel = "Log",
}: {
  values: MetricsValues;
  busy: boolean;
  onSubmit: (submission: MetricsSubmission) => void;
  /** Marks the field `/now`'s `x` shortcut puts the caret in. */
  primaryRef?: (element: HTMLInputElement | null) => void;
  /** The free-text new-viewers note. Only where there is room for a sentence. */
  withNote?: boolean;
  /** Views. Optional in the schema and optional here; never the pair. */
  withViews?: boolean;
  /** `row` is a `/now` line; `page` is the Publish section. */
  density?: "row" | "page";
  submitLabel?: string;
}) {
  const impressionsId = useId();
  const ctrId = useId();
  const viewsId = useId();
  const noteId = useId();

  const [impressionsText, setImpressionsText] = useState(text(values.impressions));
  const [ctrText, setCtrText] = useState(text(values.ctr));
  const [viewsText, setViewsText] = useState(text(values.views));
  const [note, setNote] = useState(values.newViewersNote ?? "");
  const [error, setError] = useState<string | null>(null);

  /*
    A save that landed somewhere else — the other tab, the `/now` row for this
    same video — arrives as new props. What is *typed* wins while it differs
    from what was last seen from the server, so the boxes are only re-seeded
    when the stored value actually changed. Compare-with-last-prop rather than
    an effect on every render: this is the "reset state when a prop changes"
    shape, and doing it in an effect would paint the old number for a frame.
  */
  const stored = `${values.impressions}|${values.ctr}|${values.views}|${values.newViewersNote}`;
  const [lastStored, setLastStored] = useState(stored);
  if (stored !== lastStored) {
    setLastStored(stored);
    setImpressionsText(text(values.impressions));
    setCtrText(text(values.ctr));
    setViewsText(text(values.views));
    setNote(values.newViewersNote ?? "");
  }

  function submit(): void {
    const rawImpressions = impressionsText.trim();
    const rawCtr = ctrText.trim();

    // The pair rule, enforced here as well as in `logMetrics` and in the
    // CHECK: one without the other never reaches the wire.
    if (rawImpressions === "" || rawCtr === "") {
      setError(PAIR_REQUIRED);
      return;
    }

    const impressions = Number(rawImpressions);
    const ctr = Number(rawCtr);
    if (!Number.isFinite(impressions) || !Number.isFinite(ctr)) {
      setError(
        "Those are not numbers. Studio shows impressions as a count and click-through as 4.8.",
      );
      return;
    }

    const rawViews = viewsText.trim();
    const views =
      !withViews || rawViews === ""
        ? null
        : Number.isFinite(Number(rawViews))
          ? Math.round(Number(rawViews))
          : null;

    setError(null);
    onSubmit({
      impressions: Math.round(impressions),
      ctr,
      views,
      ...(withNote ? { newViewersNote: note } : {}),
    });
  }

  const compact = density === "row";
  const inputClass = compact
    ? // The row density is `/now`'s, which is the view a phone opens: 16px
      // type below `md` (anything smaller and iOS zooms the page on focus) and
      // a 44px target wherever a thumb is likely.
      "rounded-input border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:min-h-11"
    : "rounded-input border border-border bg-background px-3 py-2 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const labelClass = compact
    ? "text-[11px] text-muted"
    : "text-xs font-medium text-muted";

  function enterSubmits(event: React.KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  return (
    <fieldset
      data-testid="metrics-pair"
      data-density={density}
      disabled={busy}
      className={[
        "flex min-w-0 flex-col border-0 p-0",
        compact ? "gap-2" : "gap-3",
      ].join(" ")}
    >
      <legend className="sr-only">
        First 24 hours: impressions and click-through, together
      </legend>

      {/*
        The pair. One row, one border, one legend — drawn as a single control,
        because it is one.
      */}
      <div
        data-testid="metrics-impressions-ctr"
        className={[
          "flex min-w-0 flex-wrap items-end",
          compact ? "gap-2" : "gap-3",
        ].join(" ")}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={impressionsId} className={labelClass}>
            Impressions
          </label>
          <input
            id={impressionsId}
            ref={primaryRef}
            data-testid="metrics-impressions"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={impressionsText}
            onChange={(event) => setImpressionsText(event.target.value)}
            onKeyDown={enterSubmits}
            className={`${inputClass} ${compact ? "w-24" : "w-32"}`}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ctrId} className={labelClass}>
            Click-through %
          </label>
          <input
            id={ctrId}
            data-testid="metrics-ctr"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step="0.01"
            value={ctrText}
            onChange={(event) => setCtrText(event.target.value)}
            onKeyDown={enterSubmits}
            className={`${inputClass} ${compact ? "w-20" : "w-28"}`}
          />
        </div>

        {withViews ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={viewsId} className={labelClass}>
              Views
            </label>
            <input
              id={viewsId}
              data-testid="metrics-views"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={viewsText}
              onChange={(event) => setViewsText(event.target.value)}
              onKeyDown={enterSubmits}
              className={`${inputClass} ${compact ? "w-20" : "w-28"}`}
            />
          </div>
        ) : null}

        <button
          type="button"
          data-testid="metrics-save"
          onClick={submit}
          className={[
            "rounded-button border border-border outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent",
            compact
              ? "px-2 py-1 text-[12px] thumb:min-h-11 thumb:px-3 thumb:text-sm"
              : "px-3 py-2 text-sm",
          ].join(" ")}
        >
          {submitLabel}
        </button>
      </div>

      {withNote ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className={labelClass}>
            New viewers
          </label>
          <textarea
            id={noteId}
            data-testid="metrics-new-viewers"
            rows={2}
            maxLength={MAX_NEW_VIEWERS_NOTE}
            value={note}
            placeholder="What the new-viewer share looked like, in a sentence."
            onChange={(event) => setNote(event.target.value)}
            // Newlines are allowed here, so Enter does not submit: this is the
            // one field on the block that is prose rather than a measurement.
            className="w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="metrics-error"
          className="w-full text-[11px] text-over-limit"
        >
          {error}
        </p>
      ) : null}

      {/*
        What is stored, in words, for anyone who is not reading the boxes — and
        as the assertion that the two are shown together even when they are only
        being reported.
      */}
      {values.impressions !== null && values.ctr !== null ? (
        <p data-testid="metrics-stored" className="sr-only">
          {formatImpressions(values.impressions)} impressions at {values.ctr}%
          click-through
          {values.views === null
            ? ""
            : `, ${formatImpressions(values.views)} views`}
          .
        </p>
      ) : null}
    </fieldset>
  );
}

/** A stored number as the text in its box. */
function text(value: number | null): string {
  return value === null ? "" : String(value);
}
