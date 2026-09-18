import Link from "next/link";

import { CaptureCell } from "./capture-cell";
import { cellKey, weightPercent, type CellTally, type MatrixBucket } from "./tally";

/**
 * One intersection of a pillar and a format.
 *
 * Two quite different things, and the difference is the feature:
 *
 * - **Populated** — a count, a weight bar, and a mark saying how many of them
 *   ever went live. It links to the list of exactly those videos.
 * - **Empty** — an invitation (`capture-cell.tsx`), which opens capture with
 *   both buckets already chosen.
 *
 * ## Why the number is never the only signal
 *
 * BRIEF.md's reading-at-a-glance question is *where am I over-invested, and
 * where have I never published*. Eight columns of digits answer neither
 * quickly: the eye has to compare numerals. So a cell carries three marks, and
 * only one of them is a number:
 *
 * 1. the **count**, in the mono face this app reserves for measured things;
 * 2. a **bar** whose length is that count against the heaviest cell in the
 *    grid — length, not hue, so it survives a greyscale print and a
 *    colour-blind reader;
 * 3. a **published mark**, `● n`, present only when something here has gone
 *    live. Its absence on a cell that holds four videos is the "never
 *    published" signal, and the legend under the grid says so in words.
 */
export function MatrixCell({
  channel,
  vertical,
  horizontal,
  cell,
  heaviest,
  openKey,
}: {
  channel: { id: string; name: string; slug: string };
  vertical: MatrixBucket;
  horizontal: MatrixBucket;
  cell: CellTally;
  /** The heaviest cell in the grid, which the bar is drawn against. */
  heaviest: number;
  /** The cell the drill-down panel is currently showing, if any. */
  openKey: string | null;
}) {
  if (cell.count === 0) {
    return (
      <CaptureCell
        channel={channel}
        vertical={{ id: vertical.id, name: vertical.name }}
        horizontal={{ id: horizontal.id, name: horizontal.name }}
        href={captureHref(channel.slug, vertical.id, horizontal.id)}
      />
    );
  }

  const key = cellKey(vertical.id, horizontal.id);
  const open = openKey === key;
  const percent = weightPercent(cell.count, heaviest);

  return (
    <Link
      href={`/c/${channel.slug}/ideas?view=matrix&cell=${encodeURIComponent(key)}`}
      scroll={false}
      data-testid="matrix-cell"
      data-empty="false"
      data-vertical={vertical.name}
      data-horizontal={horizontal.name}
      data-count={cell.count}
      data-published={cell.published}
      aria-current={open ? "true" : undefined}
      title={describe(cell, vertical, horizontal)}
      className={[
        "flex h-full min-h-[58px] w-full flex-col justify-between rounded-card border bg-surface px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
        open
          ? "border-accent ring-1 ring-accent"
          : "border-border hover:border-accent/60",
      ].join(" ")}
    >
      <span className="flex items-baseline justify-between gap-1">
        <span className="font-mono text-[15px] leading-none text-foreground">
          {cell.count}
        </span>
        {cell.published > 0 ? (
          <span
            aria-hidden="true"
            className="font-mono text-[10px] leading-none text-muted"
          >
            ●{cell.published}
          </span>
        ) : null}
      </span>

      {/* The weight bar. `aria-hidden` because it is the count again, in a
          second form, for the eye rather than for the reader. */}
      <span aria-hidden="true" className="mt-1.5 block h-[3px] w-full rounded-full bg-border">
        <span
          className="block h-full rounded-full bg-muted"
          style={{ width: `${percent}%` }}
        />
      </span>

      <span className="sr-only">{describe(cell, vertical, horizontal)}</span>
    </Link>
  );
}

/** The sentence both the tooltip and the screen reader get. */
function describe(
  cell: CellTally,
  vertical: MatrixBucket,
  horizontal: MatrixBucket,
): string {
  const videos = `${cell.count} ${cell.count === 1 ? "video" : "videos"}`;
  const published =
    cell.published === 0
      ? "none published yet"
      : `${cell.published} published`;
  return `${vertical.name} · ${horizontal.name}: ${videos}, ${published}.`;
}

/**
 * Where an empty cell points when JavaScript is not running — and the exact
 * query `/capture` reads back. One builder, so the page and the link cannot
 * disagree about the parameter names.
 */
export function captureHref(
  slug: string,
  verticalId: string,
  horizontalId: string,
): string {
  const params = new URLSearchParams({
    c: slug,
    vertical: verticalId,
    horizontal: horizontalId,
  });
  return `/capture?${params.toString()}`;
}
