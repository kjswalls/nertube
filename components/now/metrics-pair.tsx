"use client";

import { useId, useState } from "react";

/**
 * Impressions and click-through rate. **One component, always both.**
 *
 * This is not a styling decision, it is the product's one non-negotiable
 * display rule, and it is written down three times:
 *
 * - BRIEF.md, video detail page: *"Always display impressions and CTR together,
 *   never CTR alone."*
 * - PLAN.md, post-publish: *"One component renders impressions and CTR as a
 *   pair; `logMetrics` rejects one without the other."*
 * - `0001_init.sql`: `check ((first24_impressions is null) = (first24_ctr is
 *   null))`.
 *
 * The reason is that a rate without a denominator is not a measurement. "3.1%"
 * from 90 impressions and "3.1%" from 90,000 are different facts, and the whole
 * post-publish loop — swap the thumbnail fast, or leave it alone — is a
 * decision made on that difference. A component that could render one without
 * the other would eventually be asked to, on some screen where space was
 * tight.
 *
 * So there is exactly one of these. Both fields are in the same `<fieldset>`,
 * neither can be rendered without the other, and the submit handler refuses a
 * half-filled pair before any network call. Views is genuinely optional and
 * rides along; the "new viewers" note is on the detail page in M4, where there
 * is room for a sentence.
 */
export function MetricsPair({
  impressions,
  ctr,
  busy,
  onSubmit,
  primaryRef,
}: {
  /** What is stored, if anything. Both or neither — see the file comment. */
  impressions: number | null;
  ctr: number | null;
  busy: boolean;
  onSubmit: (values: { impressions: number; ctr: number }) => void;
  /** Marks the field the `x` shortcut puts the caret in. */
  primaryRef?: (element: HTMLInputElement | null) => void;
}) {
  const impressionsId = useId();
  const ctrId = useId();

  const [impressionsText, setImpressionsText] = useState(
    impressions === null ? "" : String(impressions),
  );
  const [ctrText, setCtrText] = useState(ctr === null ? "" : String(ctr));
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    const parsedImpressions = Number(impressionsText.trim());
    const parsedCtr = Number(ctrText.trim());

    // The pair rule, enforced here as well as in `logMetrics` and in the CHECK:
    // one without the other is refused before anything is sent.
    if (impressionsText.trim() === "" || ctrText.trim() === "") {
      setError("Both numbers, or neither — a CTR with no impressions is not a measurement.");
      return;
    }
    if (!Number.isFinite(parsedImpressions) || !Number.isFinite(parsedCtr)) {
      setError("Those are not numbers. Studio shows impressions as a count and CTR as 4.8.");
      return;
    }

    setError(null);
    onSubmit({ impressions: Math.round(parsedImpressions), ctr: parsedCtr });
  }

  return (
    <fieldset
      data-testid="metrics-pair"
      disabled={busy}
      className="flex min-w-0 flex-wrap items-end gap-2 border-0 p-0"
    >
      <legend className="sr-only">First 24 hours: impressions and CTR</legend>

      <div className="flex flex-col gap-1">
        <label htmlFor={impressionsId} className="text-[11px] text-muted">
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
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className="w-24 rounded-input border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ctrId} className="text-[11px] text-muted">
          CTR %
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
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className="w-20 rounded-input border border-border bg-background px-2 py-1 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      <button
        type="button"
        data-testid="metrics-save"
        onClick={submit}
        className="rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
      >
        Log
      </button>

      {error ? (
        <p
          role="alert"
          data-testid="metrics-error"
          className="w-full text-[11px] text-over-limit"
        >
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
