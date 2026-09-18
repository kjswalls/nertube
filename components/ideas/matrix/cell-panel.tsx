import Link from "next/link";

import { ideaBankHref } from "@/components/ideas/list/url";

import { FocusPanel } from "./focus-panel";

import type { CellTally, MatrixBucket } from "./tally";

/**
 * How many of a cell's videos the panel lists before it starts counting.
 *
 * Ten, because that is what the board's Idea column shows before
 * "+{overflow} more in Ideas" (`components/board/board.tsx`), and two lists in
 * one product that cap at different numbers is a decision nobody made.
 */
const CELL_VIDEO_CAP = 10;

/**
 * The videos behind one cell, listed under the grid.
 *
 * PLAN.md's M5 line asks a populated cell to *list or link to* its videos, and
 * this is the "list" half. It is a server-rendered panel keyed off `?cell=`
 * rather than a popover, for three reasons: the URL is shareable, the list is
 * the same read the count came from (so the two cannot disagree), and it costs
 * the grid no client JavaScript at all.
 *
 * The count in the cell and the number of videos here are the same number by
 * construction — `buildTally` puts each video into exactly one cell and this
 * renders that cell's array. That is the property `e2e/matrix.spec.ts` checks
 * against the database rather than against itself. The *list* stops at ten and
 * counts the rest, the way the board's Idea column does; the count above it is
 * always the whole cell.
 *
 * ## The link back into the bank
 *
 * The matrix counts every stage and the bank lists the Idea stage, so a cell
 * reading 3 above a bank showing 1 is correct and looks like a bug. The panel
 * therefore says the bank's number itself — `cell.inBank`, counted in the same
 * pass as `cell.count` — and offers it as a link with both bucket filters
 * already on, built by `ideaBankHref` so the two pages cannot disagree about
 * what the parameters are called. When none of the cell's videos are still in
 * the bank the link is replaced by the sentence that says so, rather than
 * pointing at a list that would be empty.
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
  const shown = cell.videos.slice(0, CELL_VIDEO_CAP);
  const overflow = cell.videos.length - shown.length;

  return (
    <section
      /*
        The anchor the cell links to.

        The cell's href really does end in `#cell` now — until the M5 review it
        did not, and this id was inert while a comment here claimed it was the
        arrival point. The fragment is what scrolls the panel into view. Focus
        is the half that matters and Next's client router does not move it, so
        `FocusPanel` below does; `tabIndex={-1}` is what makes `focus()` take on
        a section. Without the pair, the newly revealed content was an entire
        grid away in the tab order — 24 tab stops on a three-pillar channel, and
        BRIEF.md allows five pillars by twelve formats.
      */
      id="cell"
      tabIndex={-1}
      data-testid="matrix-cell-panel"
      data-vertical={vertical.name}
      data-horizontal={horizontal.name}
      data-count={cell.count}
      aria-labelledby="cell-heading"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {/* The reading position, when a cell was just activated. See the file. */}
      <FocusPanel cellKey={`${vertical.id}:${horizontal.id}`} />

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
        <span className="font-mono">{cell.published}</span> published.{" "}
        {cell.inBank === 0 ? (
          <span data-testid="cell-bank-none">
            None of them are still in the idea bank.
          </span>
        ) : (
          <Link
            href={ideaBankHref(channelSlug, {
              verticalId: vertical.id,
              horizontalId: horizontal.id,
            })}
            data-testid="cell-bank-link"
            data-in-bank={cell.inBank}
            className="rounded-button underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="font-mono">{cell.inBank}</span>{" "}
            {cell.inBank === 1 ? "is" : "are"} still in the idea bank
          </Link>
        )}
      </p>

      <ul data-testid="cell-videos" className="flex flex-col">
        {shown.map((video) => (
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

      {/*
        The cap's way out, drawn the way the board's Idea column draws it.

        Every list in this product is capped on purpose — the board shows ten
        cards and links the rest — and this panel was the exception only because
        the read behind it was silently truncated at a thousand rows, which is
        not a cap, it is a bug (now fixed in `lib/paged.ts`). A cell can hold
        every video in a channel, and an intersection that holds four hundred is
        exactly the over-investment the matrix is for: it should say four
        hundred and show ten, not draw four hundred anchors under a grid.

        The link is the bank with both bucket filters on, which is the same
        address the sentence above offers and is built by the same function —
        and it is offered only when the bank actually holds some of them, since
        the bank lists the Idea stage and this panel counts every stage.
      */}
      {overflow > 0 ? (
        <p
          data-testid="cell-overflow"
          data-count={overflow}
          className="text-[12px] text-muted"
        >
          <span className="font-mono">+{overflow}</span> more at this
          intersection, not listed here.{" "}
          {cell.inBank > 0 ? (
            <Link
              href={ideaBankHref(channelSlug, {
                verticalId: vertical.id,
                horizontalId: horizontal.id,
              })}
              data-testid="cell-overflow-link"
              className="rounded-button underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
            >
              Open the ones still in the bank
            </Link>
          ) : (
            <>Open one from the board to see the rest.</>
          )}
        </p>
      ) : null}
    </section>
  );
}
