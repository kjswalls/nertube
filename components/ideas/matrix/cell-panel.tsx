import Link from "next/link";

import type { CellTally, MatrixBucket } from "./tally";

/**
 * The videos behind one cell, listed under the grid.
 *
 * PLAN.md's M5 line asks a populated cell to *list or link to* its videos, and
 * this is the "list" half. It is a server-rendered panel keyed off `?cell=`
 * rather than a popover, for three reasons: the URL is shareable, the list is
 * the same read the count came from (so the two cannot disagree), and it costs
 * the grid no client JavaScript at all.
 *
 * The count in the cell and the number of rows here are the same number by
 * construction — `buildTally` puts each video into exactly one cell and this
 * renders that cell's array. That is the property `e2e/matrix.spec.ts` checks
 * against the database rather than against itself.
 */
export function CellPanel({
  channelSlug,
  vertical,
  horizontal,
  cell,
}: {
  channelSlug: string;
  vertical: MatrixBucket;
  horizontal: MatrixBucket;
  cell: CellTally;
}) {
  return (
    <section
      // The anchor the cell links to, so the panel is in view on arrival
      // without the page jumping — `scroll={false}` on the link plus a real id
      // is the pair that lets a person choose to go there.
      id="cell"
      data-testid="matrix-cell-panel"
      data-vertical={vertical.name}
      data-horizontal={horizontal.name}
      data-count={cell.count}
      aria-labelledby="cell-heading"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="cell-heading" className="font-display text-[16px] leading-tight font-semibold">
          {vertical.name} · {horizontal.name}
        </h2>
        <Link
          href={`/c/${channelSlug}/ideas?view=matrix`}
          scroll={false}
          className="rounded-button px-1 py-0.5 text-[12px] text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
        >
          Close
        </Link>
      </div>

      <p className="text-[12px] text-muted">
        <span className="font-mono">{cell.count}</span>{" "}
        {cell.count === 1 ? "video" : "videos"} at this intersection,{" "}
        <span className="font-mono">{cell.published}</span> published.
      </p>

      <ul data-testid="cell-videos" className="flex flex-col">
        {cell.videos.map((video) => (
          <li
            key={video.id}
            data-testid="cell-video"
            className="border-t border-border first:border-t-0"
          >
            <Link
              href={`/videos/${video.id}`}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-button px-1 py-2 outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="font-display text-[14px] leading-snug">
                {video.title === "" ? "Untitled" : video.title}
              </span>
              <span className="flex items-baseline gap-2 text-[11px] text-muted">
                {video.stageName ? <span>{video.stageName}</span> : null}
                {video.targetPublishDate ? (
                  <span className="font-mono">{video.targetPublishDate}</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
