"use client";

import type { DragEvent, ReactNode } from "react";

/**
 * One kanban column: the stage's name, its real count, the bottleneck signals
 * that belong to it, and the cards.
 *
 * The signals are the point of the column, not decoration on it (BRIEF.md
 * principles 4 and 5 — *make the bottleneck visible* and *the board should
 * nag*). There are three, and each has a rule that matters:
 *
 * - **Count.** Every column. The honest total, including the Idea cards the
 *   column does not render.
 * - **WIP warning.** Only for `WIP_KINDS` (packaging … scheduled). Idea is a
 *   bank and Published/Repurposed are terminal: a big number in any of the
 *   three is not a bottleneck, and a board that cried wolf about the idea bank
 *   would teach its one user to ignore the colour everywhere else. The caller
 *   decides; this component only renders what it is told.
 * - **Filming batch badge.** Counted across *all* channels, because there is
 *   one creator and one camera. Text only from M1 to M5; M6 hands it in as a
 *   control (`components/calendar/filming/schedule-day-button.tsx`) that opens
 *   the schedule flow with those videos pre-selected. This component still only
 *   renders what it is told — it has never known what the badge *means*, and
 *   making it know now would put the "three in Filming" rule in two places.
 *
 * The column is also the drop target — the whole `<section>`, not just the
 * scrolling list inside it. The header is 38px of a 737px column and the user
 * aiming at a short column's title bar is aiming at the column; with the
 * handlers on the inner list that drop was silently ignored and the column did
 * not even highlight. `onDragOver` must `preventDefault()` or the browser
 * refuses the drop — that one line is the whole of native HTML5 drop-target
 * opt-in.
 */
export function BoardColumn({
  name,
  count,
  wipWarning,
  wipThreshold,
  filmingBadge,
  isDropTarget,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  children,
  footer,
}: {
  name: string;
  count: number;
  /** Render the over-WIP treatment. The caller has already applied `WIP_KINDS`. */
  wipWarning: boolean;
  wipThreshold: number;
  /**
   * The Filming column's batch-day signal, or null.
   *
   * A node rather than a string since M6: it arrives as the button that opens
   * the schedule dialog, carrying its own `data-testid="filming-badge"` and the
   * same sentence it has always read. The column gives it the slot it has
   * always had, under the count.
   */
  filmingBadge: ReactNode;
  /** A card is being dragged over this column. */
  isDropTarget: boolean;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  children: ReactNode;
  /** The Idea column's "+K more in Ideas" line, or null. */
  footer?: ReactNode;
}) {
  return (
    <section
      aria-label={name}
      data-testid="board-column"
      data-stage-name={name}
      data-wip-warning={wipWarning ? "true" : "false"}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        // 216px and 1px, from the metrics in `globals.css`. A column that is
        // not in trouble gets no colour at all: an empty Idea column and a
        // quiet Filming column look like the furniture they are, which is what
        // makes the one column that *is* over its limit findable at a glance.
        "flex w-column shrink-0 flex-col self-stretch rounded-card border bg-surface transition",
        // A phone (M10): one column at a time, the width of the screen less a
        // 16px sliver of the next, snapped. At 216px a card's title had a
        // 106px column and was cut at three lines of two words each.
        "max-md:w-[calc(100vw-4rem)] max-md:snap-start",
        wipWarning ? "border-over-limit/60" : "border-border",
        isDropTarget ? "ring-2 ring-accent" : "",
      ].join(" ")}
    >
      <header
        className={[
          "flex flex-col gap-1 border-b px-3 py-2",
          wipWarning ? "border-over-limit/40" : "border-border",
        ].join(" ")}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="truncate text-[13px] font-medium" title={name}>
            {name}
          </h2>
          <span
            data-testid="column-count"
            className={[
              // The count is something the tool measured, so it is mono.
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
              wipWarning
                ? "bg-over-limit/15 font-semibold text-over-limit"
                : "bg-background text-muted",
            ].join(" ")}
          >
            <span className="sr-only">
              {count === 1 ? "1 video" : `${count} videos`}
            </span>
            <span aria-hidden="true">{count}</span>
          </span>
        </div>

        {wipWarning ? (
          <p
            data-testid="wip-warning"
            className="text-[11px] leading-4 font-medium text-over-limit"
          >
            Over WIP: {count} in progress, threshold {wipThreshold}. Finish
            something before starting more.
          </p>
        ) : null}

        {filmingBadge}
      </header>

      {/* The scrolling list. The drop handlers live on the <section> above,
          so a drop anywhere on the column — header included — counts; this
          div is only the part that scrolls. */}
      <div
        data-testid="column-dropzone"
        data-stage-name={name}
        className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {count === 0 ? (
          /*
            M9: an empty column is a place a card can go, drawn as one — a
            quiet dashed slot — rather than the sentence "Nothing here yet."
            repeated eight times across a board whose one busy column is the
            thing worth reading. The header's count already says 0; a screen
            reader, which cannot see the slot, gets the sentence instead.
          */
          <>
            <div
              aria-hidden="true"
              data-testid="column-empty"
              className="h-16 rounded-card border border-dashed border-border"
            />
            <p className="sr-only">No videos in {name}.</p>
          </>
        ) : (
          <ul className="flex flex-col gap-2">{children}</ul>
        )}
        {footer}
      </div>
    </section>
  );
}
