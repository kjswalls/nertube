import { MatrixCell } from "./cell";
import { BucketCount, QuotaMeter } from "./quota-meter";
import { cellAt, type MatrixTally } from "./tally";

/**
 * The grid: pillars down, formats across.
 *
 * ## It is a real `<table>`
 *
 * Because it is really a table: every cell is identified by the row and the
 * column it is in, and that relationship is the whole meaning of the page. With
 * `<th scope="col">` and `<th scope="row">` a screen reader announces "money,
 * tutorial, 3 videos, 1 published" when it lands on a cell; a grid of `<div>`s
 * announces "3" and leaves the reader to remember which column they had
 * counted across to. `role="grid"` would be the other option and would then owe
 * a roving tabindex and arrow-key navigation — a table of links is already
 * navigable with Tab and already announces its headers.
 *
 * ## What each header carries
 *
 * The bucket's name, how many videos carry it at all, and — only if the bucket
 * has one — its monthly quota with a bar. The two numbers are different
 * questions ("how much of my work is this pillar" and "how much of this month
 * is") and the header answers both because the answer to either alone invites
 * the wrong conclusion.
 */
export function Matrix({
  channel,
  tally,
  openKey,
}: {
  channel: { id: string; name: string; slug: string };
  tally: MatrixTally;
  /** `vertical:horizontal` of the cell whose list is open, if one is. */
  openKey: string | null;
}) {
  return (
    // The strip scrolls sideways by itself rather than letting a wide grid
    // reach the viewport — the same containment the board's column strip uses.
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <table
        data-testid="matrix-grid"
        data-verticals={tally.verticals.length}
        data-horizontals={tally.horizontals.length}
        className="w-full border-separate border-spacing-1"
      >
        <caption className="sr-only">
          {channel.name}: topic pillars down the side, formats across the top.
          Each cell is how many videos sit at that intersection; an empty cell is
          an idea you have not had yet, and opens a capture box with both
          buckets already chosen.
        </caption>

        <thead>
          <tr>
            {/* The corner. Empty, and empty on purpose: it is the one cell in
                the table that is neither a heading nor a count. */}
            <td className="w-[172px] min-w-[150px]" />
            {tally.horizontals.map((column) => (
              <th
                key={column.bucket.id}
                scope="col"
                data-testid="matrix-column"
                data-bucket={column.bucket.name}
                className="min-w-[92px] rounded-card border border-border bg-sidebar px-2 py-1.5 text-left align-bottom"
              >
                <span className="block font-display text-[13px] leading-tight font-medium break-words">
                  {column.bucket.name}
                </span>
                <BucketCount total={column.total} />
                <QuotaMeter tally={column} monthLabel={tally.month.label} />
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {tally.verticals.map((row) => (
            <tr key={row.bucket.id}>
              <th
                scope="row"
                data-testid="matrix-row"
                data-bucket={row.bucket.name}
                className="rounded-card border border-border bg-sidebar px-2 py-1.5 text-left align-top"
              >
                <span className="block font-display text-[14px] leading-tight font-medium break-words">
                  {row.bucket.name}
                </span>
                <BucketCount total={row.total} />
                <QuotaMeter tally={row} monthLabel={tally.month.label} />
              </th>

              {tally.horizontals.map((column) => (
                <td key={column.bucket.id} className="h-px p-0 align-top">
                  <MatrixCell
                    channel={channel}
                    vertical={row.bucket}
                    horizontal={column.bucket}
                    cell={cellAt(tally, row.bucket.id, column.bucket.id)}
                    heaviest={tally.heaviest}
                    openKey={openKey}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the marks in the grid mean, in words.
 *
 * The three signals in a cell are a number, a length and a dot, and two of
 * those are conventions this page invented. A legend is the cheapest honest way
 * to make an invented convention readable — cheaper than making every cell
 * spell itself out, and it is also where the absence of a dot gets to be stated
 * as a signal rather than left to be noticed.
 */
export function MatrixLegend({ monthLabel }: { monthLabel: string }) {
  return (
    <ul
      data-testid="matrix-legend"
      className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted"
    >
      <li>
        <span className="font-mono text-foreground">3</span> — videos at that
        intersection; the bar under it is its weight against the busiest cell.
      </li>
      <li>
        <span className="font-mono text-foreground">●2</span> — two of them have
        been published. No dot means nothing here has ever gone live.
      </li>
      <li>A dashed cell is an idea you have not had yet. Click it to capture one.</li>
      <li>Quota bars count videos targeted at {monthLabel}.</li>
    </ul>
  );
}
