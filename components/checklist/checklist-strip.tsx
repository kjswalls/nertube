"use client";

import { useId, useState } from "react";

import { SaveStatus } from "@/components/autosave";
import {
  estMinutesOf,
  nextItem,
  progressOf,
  type ChecklistItem,
  type EvidenceFacts,
} from "@/lib/checklist";

import { ChecklistList } from "./checklist-list";
import { useChecklist } from "./use-checklist";

/**
 * The checklist strip — the stage's list, reduced to one line.
 *
 * ## It is the fixed home, and that is the design
 *
 * It sits directly under the video page's header, above every section, and it
 * does not move. A checklist that lived inside the "Scripting" section would be
 * somewhere else on every video, and the one question it answers — *what is the
 * next thing I actually do to this video* — is the question you have while
 * looking at anything else on the page. So: ratio, next unticked row, what it
 * costs, and a disclosure for the rest.
 *
 * (PLAN.md says "directly under the section tabs", and since the section
 * navigation landed that is literally where it is: the tabs, then this, then
 * whichever section is showing. It is rendered *outside* the panels — the video
 * page hands it to `VideoSections` as `underTabs` — so switching sections never
 * moves it and never remounts it.)
 *
 * ## Zero items is not "nothing to do"
 *
 * A stage with no checklist renders no ratio at all. "0/0" reads as *done*, and
 * M1 deliberately removed exactly that string from the board card rather than
 * let it mean two things. Here the strip says the stage has no list and offers
 * the template back, which is the actionable version of the same fact.
 *
 * ## What it does not do
 *
 * It never ticks anything by itself. The evidence beside a row is a *count* —
 * how many candidates exist, how long the title is, how many hooks are written
 * — and the tick stays the user's judgement (PLAN.md review item 21: auto-tick
 * is deliberately not in v1). The app can say "you have written two hooks"; it
 * cannot say "the strongest is picked".
 */
export function ChecklistStrip({
  videoId,
  stageId,
  stageName,
  initial,
  facts,
}: {
  videoId: string;
  /** The video's current stage. The list belongs to it and to no other. */
  stageId: string;
  stageName: string;
  /** This stage's rows, as the server read them. */
  initial: readonly ChecklistItem[];
  /** The video's own fields, for the evidence beside measurable rows. */
  facts: EvidenceFacts;
}) {
  const { items, state, pending, toggle, add, remove, reset, retry, movedAway } =
    useChecklist({ videoId, stageId, initial });

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const panelId = useId();
  const headingId = useId();

  const { done, total } = progressOf(items);
  const next = nextItem(items);

  return (
    <section
      data-testid="checklist-strip"
      data-stage-id={stageId}
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-card border border-border bg-surface px-3 py-2"
    >
      <h2 id={headingId} className="sr-only">
        Checklist — {stageName}
      </h2>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {total > 0 ? (
          <span
            data-testid="checklist-ratio"
            data-done={done}
            data-total={total}
            title={`${done} of ${total} done in ${stageName}`}
            className="shrink-0 font-mono text-[12px] font-medium"
          >
            {done}/{total}
          </span>
        ) : (
          <span
            data-testid="checklist-none"
            className="shrink-0 text-[12px] text-muted"
          >
            No checklist
          </span>
        )}

        <p
          data-testid="checklist-next"
          className="min-w-0 flex-1 truncate text-[13px]"
        >
          {next ? (
            <>
              <span className="sr-only">Next: </span>
              {next.text}
            </>
          ) : total > 0 ? (
            <span className="text-muted">
              Everything in {stageName} is ticked.
            </span>
          ) : (
            <span className="text-muted">
              {stageName} has no checklist on this video.
            </span>
          )}
        </p>

        {next ? (
          <span
            data-testid="checklist-next-minutes"
            title={`About ${estMinutesOf(next)} minutes`}
            className="shrink-0 font-mono text-[11px] text-muted"
          >
            {estMinutesOf(next)}m
          </span>
        ) : null}

        <button
          type="button"
          data-testid="checklist-expander"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="shrink-0 rounded-button border border-border px-2 py-0.5 text-[12px] font-medium outline-none hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent"
        >
          {open ? "Hide list" : total > 0 ? `Show list (${total})` : "Show list"}
        </button>
      </div>

      {/*
        Rendered whether it is open or not, and hidden with the `hidden`
        attribute: `aria-controls` above has to name an element that exists, and
        the half-typed item in the add box survives the panel being folded away
        and opened again.
      */}
      <div id={panelId} hidden={!open} className="flex flex-col gap-3 pt-1">
        <ChecklistList
          items={items}
          facts={facts}
          nextId={next?.id ?? null}
          onToggle={toggle}
          onDelete={remove}
          onAdd={add}
        />

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          {confirming ? (
            <>
              <span
                data-testid="checklist-reset-warning"
                className="text-[12px] text-muted"
              >
                Reset drops the ticks and any custom items in {stageName}.
              </span>
              <button
                type="button"
                data-testid="checklist-reset-confirm"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  reset();
                }}
                className="rounded-button border border-over-limit/50 px-2 py-0.5 text-[12px] font-medium text-over-limit outline-none enabled:hover:bg-over-limit/10 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
              >
                Reset it
              </button>
              <button
                type="button"
                data-testid="checklist-reset-cancel"
                onClick={() => setConfirming(false)}
                className="rounded-button border border-border px-2 py-0.5 text-[12px] outline-none hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent"
              >
                Keep them
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="checklist-reset"
              onClick={() => setConfirming(true)}
              className="rounded-button border border-border px-2 py-0.5 text-[12px] outline-none hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent"
            >
              Reset from template
            </button>
          )}
        </div>
      </div>

      {/*
        The one status line for everything above it, wired to the same retry as
        the rest of the page. A rolled-back tick is reported here — the row is
        already back where it was, so this says why.
      */}
      <SaveStatus
        state={state}
        testId="checklist-save-status"
        onRetry={movedAway ? undefined : () => retry()}
      />
    </section>
  );
}
