"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { setAssistCap } from "@/app/actions/spend";
import { SaveStatus, useSaveQueue } from "@/components/autosave";

/**
 * Settings → API spending (M11): what the brainstorm has cost on the API this
 * calendar month, and the cap on it.
 *
 * Every number is the server's, computed in `lib/assist/spend.ts` and handed
 * down already formatted, so nothing here knows a price or a model name (the
 * price table is `server-only`: PLAN.md's bundle grep must keep finding
 * nothing). Money is a measured number, so it is set in the mono face.
 *
 * The cap is saved with Save, like the time zone above it, through the one
 * save queue — its status line and Retry are the ones every setting has. An
 * empty box means "no cap"; the default for somebody who has never saved one
 * is said beside the box, in the words of `DEFAULT_CAP_DOLLARS`.
 */
export interface SpendingView {
  /** "September 2026". */
  readonly monthLabel: string;
  /** "1 Oct": when the count starts again. */
  readonly resets: string;
  /** "$3.42". */
  readonly spent: string;
  readonly calls: number;
  /** "$0.29", once there is a call this month. */
  readonly mean: string | null;
  /** Calls priced by assumption (an unknown model). */
  readonly assumedCalls: number;
  /** The cap in force, in dollars; null for no cap. */
  readonly capDollars: number | null;
  /** Whether the person chose it or it is the default. */
  readonly capSource: "default" | "chosen";
  /** The default, in dollars, for the sentence beside the box. */
  readonly defaultCap: number;
  /** 0–1, how much of the cap is used; null with no cap. */
  readonly used: number | null;
  /** The most expensive rate, per million tokens, for the assumed-price note. */
  readonly assumedRate: string;
}

export function SpendingForm({ view }: { view: SpendingView }) {
  const router = useRouter();
  const inputId = useId();
  const statusId = `${inputId}-status`;
  const hintId = `${inputId}-hint`;

  const shown = view.capDollars === null ? "" : String(view.capDollars);
  const [text, setText] = useState(shown);
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    // A fresh server render (after a save) is the new baseline.
    setSeen(shown);
    setText(shown);
  }

  const queue = useSaveQueue<number | null>({
    merge: (_, next) => next,
    save: async (dollars) => {
      const result = await setAssistCap(dollars);
      if (!result.ok) return { ok: false, error: result.error };
      router.refresh();
      return { ok: true };
    },
  });

  const trimmed = text.trim();
  const valid = trimmed === "" || /^\d{1,6}$/.test(trimmed);
  const next = trimmed === "" ? null : Number(trimmed);
  // Emptying the box on the default is a real change: it turns the $10
  // default into "no cap".
  const changed = valid && trimmed !== shown;

  const atCap = view.used !== null && view.used >= 1;
  const capText =
    view.capDollars === null ? "No cap" : `$${view.capDollars.toLocaleString("en-US")}`;

  return (
    <section
      id="spending"
      aria-labelledby={`${inputId}-heading`}
      data-testid="settings-spending"
      className="flex scroll-mt-6 flex-col gap-4 rounded-card border border-border bg-surface px-4 py-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${inputId}-heading`} className="text-[13px] font-semibold">
          API spending
        </h2>
        <p className="text-[13px] leading-5 text-muted">
          What the brainstorm has cost on the API in {view.monthLabel}, counted in your time zone.
          Open in Claude and the built-in fixtures cost nothing and are not counted.
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3 max-[360px]:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-muted">Spent this month</dt>
          <dd data-testid="spending-spent" className="font-mono text-[18px] leading-6 text-foreground">
            {view.spent}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-muted">Calls</dt>
          <dd data-testid="spending-calls" className="font-mono text-[18px] leading-6 text-foreground">
            {view.calls.toLocaleString("en-US")}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-muted">
            Cap{view.capSource === "default" ? " (default)" : ""}
          </dt>
          <dd data-testid="spending-cap" className="font-mono text-[18px] leading-6 text-foreground">
            {capText}
          </dd>
        </div>
      </dl>

      {view.used !== null ? (
        <div className="flex flex-col gap-1">
          <div
            role="meter"
            aria-label="Share of this month's cap used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(view.used, 1) * 100)}
            aria-valuetext={`${view.spent} of ${capText}`}
            data-testid="spending-meter"
            className="h-1.5 w-full overflow-hidden rounded-full bg-border"
          >
            <div
              className={["h-full rounded-full", atCap ? "bg-attention" : "bg-accent"].join(" ")}
              style={{ width: `${Math.min(view.used, 1) * 100}%` }}
            />
          </div>
          {atCap ? (
            <p data-testid="spending-at-cap" className="text-[12px] leading-5 text-attention">
              Cap reached: the brainstorm will not call the API again until {view.resets} unless
              the cap is raised. Open in Claude still works.
            </p>
          ) : null}
        </div>
      ) : null}

      <p data-testid="spending-mean" className="text-[13px] leading-5 text-muted">
        {view.mean !== null ? (
          <>
            A typical call has cost <span className="font-mono text-foreground">{view.mean}</span>{" "}
            this month (the mean of {view.calls}). The count starts again on {view.resets}.
          </>
        ) : (
          <>No API calls yet this month. The count starts again on {view.resets}.</>
        )}
      </p>

      {view.assumedCalls > 0 ? (
        <p data-testid="spending-assumed" className="text-[13px] leading-5 text-muted">
          {view.assumedCalls === 1 ? "One call was" : `${view.assumedCalls} calls were`} answered
          by a model this app has no price for, so the price was assumed: the most expensive rate it
          knows ({view.assumedRate}). The real cost was probably lower.
        </p>
      ) : null}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && changed) queue.send(next);
        }}
      >
        <label htmlFor={inputId} className="text-[13px] font-medium sm:shrink-0">
          Monthly cap
        </label>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden className="font-mono text-[13px] text-muted">
            $
          </span>
          <input
            id={inputId}
            name="cap"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            data-testid="spending-cap-input"
            value={text}
            placeholder="No cap"
            aria-invalid={!valid || undefined}
            aria-describedby={`${hintId} ${statusId}`}
            onChange={(event) => {
              queue.touch();
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && text !== shown) {
                event.preventDefault();
                setText(shown);
              }
            }}
            className="w-full min-w-0 rounded-input border border-border bg-background px-3 py-2 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-accent aria-invalid:border-attention sm:w-32 md:pointer-fine:text-[13px] thumb:min-h-11"
          />
          <button
            type="submit"
            data-testid="spending-cap-save"
            aria-disabled={!valid || !changed || queue.pending || undefined}
            className="shrink-0 rounded-button border border-accent px-3 py-2 text-sm font-medium outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent aria-disabled:border-border aria-disabled:text-muted aria-disabled:hover:bg-transparent thumb:min-h-11"
          >
            Save
          </button>
        </div>
      </form>

      <p id={hintId} className="text-[12px] leading-5 text-muted">
        Whole dollars a calendar month; leave it empty for no cap. With no setting the cap is $
        {view.defaultCap}. It is checked before every call: at the cap the brainstorm stops calling
        the API and says so. A call already running when the cap is reached finishes and is counted,
        and two calls started at the same moment can pass it by one call.
      </p>

      <SaveStatus
        id={statusId}
        state={queue.state}
        testId="spending-cap-status"
        idle={
          !valid
            ? "Whole dollars only, like 10 or 25 — or empty for no cap."
            : changed
              ? "Not saved yet — press Save, or Escape to put it back."
              : ""
        }
        onRetry={(dollars) => queue.send(dollars)}
      />
    </section>
  );
}
