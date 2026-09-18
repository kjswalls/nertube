"use client";

import type { StageStats } from "@/lib/stage-stats";

/**
 * The weekly-review strip.
 *
 * BRIEF.md principle 5 is a *question*, asked once a week: **where are videos
 * piling up?** The column counts answer half of it — five in Editing is a
 * number — and the other half is how long they have been there, because five
 * videos that arrived yesterday and five that have sat for a fortnight are the
 * same count and completely different weeks.
 *
 * So each cell is three numbers, all from `stage_entered_at` (PLAN.md's board
 * section, and review item 27, which dropped the `stage_events` table in favour
 * of exactly this): **count**, the **oldest** card's days in stage, and the
 * **median**. The median is the one that matters and the one nobody has: one
 * ancient card in a healthy column is a stuck video, and a high median is a
 * stuck *stage*. Reading them side by side is the difference.
 *
 * ## Only the columns that hold something
 *
 * An empty column contributes nothing and is not drawn. That is the same rule
 * as the colour system — *a column with nothing wrong with it gets no colour at
 * all* — applied to space: a strip with nine cells, six of them "0", is a
 * strip nobody reads, and the whole job here is to be readable in the four
 * seconds somebody spends on it.
 *
 * ## It is not aligned to the columns, on purpose
 *
 * The obvious design is a cell above each column. It is also wrong here: the
 * board scrolls horizontally and the page does not, so the strip would either
 * need a second synchronised scroller or would drift out of alignment the
 * moment anybody scrolled — and a header that lies about which column it
 * describes is worse than one that names them. Each cell names its stage.
 */
export interface StripColumn {
  readonly stageId: string;
  readonly name: string;
  readonly stats: StageStats;
  /** Over the channel's WIP threshold — the column header is already red. */
  readonly overWip: boolean;
}

export function WeeklyStrip({
  columns,
  staleDays,
}: {
  columns: readonly StripColumn[];
  /** `channels.stale_days`: beyond this, a card is flagged on the board. */
  staleDays: number;
}) {
  const occupied = columns.filter((column) => column.stats.count > 0);

  if (occupied.length === 0) return null;

  return (
    <section
      data-testid="weekly-strip"
      aria-label="Weekly review: time in stage"
      className="flex flex-wrap items-stretch gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-3 py-2"
    >
      {occupied.map((column) => {
        // The column is a bottleneck when its *median* card has been sitting
        // longer than the channel's own staleness threshold. The median rather
        // than the oldest: one forgotten video is a video, several slow ones
        // are a stage.
        const piling =
          column.stats.medianDays !== null && column.stats.medianDays > staleDays;

        return (
          <div
            key={column.stageId}
            data-testid="strip-cell"
            data-stage-name={column.name}
            data-piling-up={piling ? "true" : "false"}
            className="flex min-w-0 items-baseline gap-1.5"
          >
            <span className="truncate text-[12px] text-muted" title={column.name}>
              {column.name}
            </span>
            <span
              data-testid="strip-count"
              className={[
                "font-mono text-[12px]",
                column.overWip ? "font-semibold text-over-limit" : "text-foreground",
              ].join(" ")}
            >
              {column.stats.count}
            </span>
            <span
              data-testid="strip-ages"
              // The one place the two numbers are spelled out. The cell itself
              // is terse because there are up to nine of them.
              title={`Oldest card: ${column.stats.oldestDays} days in ${column.name}. Median: ${column.stats.medianDays} days.`}
              className={[
                "font-mono text-[11px] whitespace-nowrap",
                piling ? "text-attention" : "text-muted",
              ].join(" ")}
            >
              <span className="sr-only">
                {`oldest ${column.stats.oldestDays} days, median ${column.stats.medianDays} days`}
              </span>
              <span aria-hidden="true">
                {column.stats.oldestDays}d / {column.stats.medianDays}d
              </span>
            </span>
          </div>
        );
      })}

      <p className="ml-auto self-center text-[11px] text-muted">
        count · oldest / median days in stage
      </p>
    </section>
  );
}
