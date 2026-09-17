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
 *   one creator and one camera. Text only in M1; M6 makes it create the
 *   filming day.
 *
 * The column is also the drop target. `onDragOver` must `preventDefault()` or
 * the browser refuses the drop — that one line is the whole of native HTML5
 * drop-target opt-in.
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
  /** "N in Filming — schedule batch day?", or null. */
  filmingBadge: string | null;
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
      className={[
        "flex w-72 shrink-0 flex-col self-stretch rounded-lg border bg-surface transition",
        wipWarning
          ? "border-red-500/60 dark:border-red-500/50"
          : "border-border",
        isDropTarget ? "ring-2 ring-foreground/50" : "",
      ].join(" ")}
    >
      <header
        className={[
          "flex flex-col gap-1 border-b px-3 py-2",
          wipWarning ? "border-red-500/40" : "border-border",
        ].join(" ")}
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="truncate text-sm font-medium" title={name}>
            {name}
          </h2>
          <span
            data-testid="column-count"
            className={[
              "shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums",
              wipWarning
                ? "bg-red-100 font-semibold text-red-800 dark:bg-red-950 dark:text-red-200"
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
            className="text-[11px] leading-4 font-medium text-red-700 dark:text-red-300"
          >
            Over WIP: {count} in progress, threshold {wipThreshold}. Finish
            something before starting more.
          </p>
        ) : null}

        {filmingBadge ? (
          <p
            data-testid="filming-badge"
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] leading-4 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {filmingBadge}
          </p>
        ) : null}
      </header>

      <div
        data-testid="column-dropzone"
        data-stage-name={name}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {count === 0 ? (
          <p className="px-1 py-2 text-xs text-muted">Nothing here yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">{children}</ul>
        )}
        {footer}
      </div>
    </section>
  );
}
