"use client";

import { useId, useState } from "react";

import { MAX_SKIP_REASON_LENGTH } from "@/lib/packaging";

/**
 * The escape hatch, and the reason it is deliberately awkward.
 *
 * BRIEF.md principle 1: packaging is ~20% of the effort for ~80% of the result,
 * and the app should make it *structurally awkward* to skip. Not impossible —
 * a sponsor deadline, a reupload, a video whose packaging was decided in a
 * document three weeks ago are all real — but never the path of least
 * resistance. So skipping costs three deliberate acts:
 *
 * 1. open a disclosure that is closed by default and is not styled as a
 *    primary action,
 * 2. read what it will do, which is stated before the box and not after it,
 * 3. type a reason, which cannot be blank — refused here, and refused again by
 *    `packaging_skip_reason <> ''` in `0001_init.sql` if it ever got past here.
 *
 * Compare the cost of just writing the thumbnail concept: one sentence in a box
 * that is already on screen. That asymmetry is the feature.
 *
 * ## Why the button is not disabled when the box is empty
 *
 * A disabled button is a refusal with no explanation, and this is precisely the
 * moment somebody is in a hurry and will not go looking for one. Pressing it
 * with an empty box says what is missing, which is both kinder and — since the
 * reason is the entire point of the mechanism — more likely to produce one.
 *
 * ## Un-skipping
 *
 * One click, no confirmation. Going back to doing the work properly should
 * never be the harder direction.
 */
export function SkipPackaging({
  skippedAt,
  skipReason,
  onSkip,
  onUnskip,
  busy,
}: {
  skippedAt: string | null;
  skipReason: string | null;
  onSkip: (reason: string) => void;
  onUnskip: () => void;
  busy: boolean;
}) {
  const fieldId = useId();
  const noticeId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  if (skippedAt !== null) {
    return (
      <section
        id="packaging-skip"
        data-testid="packaging-skipped"
        className="flex scroll-mt-4 flex-col gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
      >
        <p className="font-medium text-amber-800 dark:text-amber-300">
          Packaging skipped
        </p>
        <p data-testid="skip-reason" className="text-sm">
          {skipReason ?? "(no reason recorded)"}
        </p>
        <p className="text-xs text-muted">
          Skipped{" "}
          <time dateTime={skippedAt}>
            {new Date(skippedAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </time>
          . This shows as a badge on the card, and the gate lets this video
          through until it is undone.
        </p>
        <div>
          <button
            type="button"
            data-testid="packaging-unskip"
            disabled={busy}
            onClick={onUnskip}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40 disabled:opacity-60"
          >
            Un-skip — put the gate back
          </button>
        </div>
      </section>
    );
  }

  if (!open) {
    return (
      <p id="packaging-skip" className="scroll-mt-4 text-xs">
        <button
          type="button"
          data-testid="packaging-skip-open"
          onClick={() => setOpen(true)}
          className="text-muted underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          Skip the packaging gate for this video…
        </button>
      </p>
    );
  }

  return (
    <section
      id="packaging-skip"
      data-testid="packaging-skip-form"
      className="flex scroll-mt-4 flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
    >
      <p className="text-xs text-muted">
        Skipping lets this video move past Packaging with the three fields
        unfinished. It is recorded with the date and your reason, shows as a
        badge on the card, and stays visible until you undo it.
      </p>

      <label htmlFor={fieldId} className="text-xs font-medium text-muted">
        Why are you skipping packaging?
      </label>
      <textarea
        id={fieldId}
        value={reason}
        rows={2}
        maxLength={MAX_SKIP_REASON_LENGTH}
        placeholder="Sponsor deadline — packaging was decided in the brief"
        aria-describedby={noticeId}
        data-testid="skip-reason-input"
        onChange={(event) => {
          setReason(event.target.value);
          if (notice) setNotice(null);
        }}
        className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
      />

      <p
        id={noticeId}
        role="status"
        data-testid="skip-notice"
        className="min-h-4 text-xs text-amber-700 dark:text-amber-400"
      >
        {notice ?? ""}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="packaging-skip-confirm"
          disabled={busy}
          onClick={() => {
            const typed = reason.trim();
            if (typed === "") {
              setNotice(
                "A reason is required — that is the whole point of skipping deliberately.",
              );
              return;
            }
            setNotice(null);
            onSkip(typed);
          }}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40 disabled:opacity-60"
        >
          Skip packaging
        </button>
        <button
          type="button"
          data-testid="packaging-skip-cancel"
          onClick={() => {
            setOpen(false);
            setReason("");
            setNotice(null);
          }}
          className="rounded-md px-3 py-1.5 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
