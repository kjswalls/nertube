import { describe, expect, it } from "vitest";

import { visibleIdeas } from "@/components/ideas/list/filtering";
import { ideaBankHref, readIdeaFilters } from "@/components/ideas/list/url";
import { NO_IDEA_FILTERS, type Idea } from "@/components/ideas/list/types";
import {
  buildTally,
  cellAt,
  monthWindow,
  type MatrixBucket,
  type MatrixVideo,
} from "@/components/ideas/matrix/tally";

/**
 * The one property M5's two halves owe each other.
 *
 * The idea bank filters by bucket; the matrix counts by bucket. They read
 * different queries (the bank is the Idea stage and includes archived rows
 * behind a toggle; the matrix is every stage and excludes archived rows
 * outright), they draw different things, and they were built by different
 * people at the same time. What they must never do is **disagree about which
 * videos are in a bucket** — a cell saying 3 above a list showing 2, with
 * nothing on either page to say which is lying.
 *
 * The defence is that both route through `bucketOn` in `lib/buckets.ts`. This
 * file is the proof: one fixture, run through `buildTally` and through
 * `visibleIdeas`, asserting the two name the same rows — including through the
 * link the matrix now offers, whose query string is parsed back into filters by
 * the same module that built it.
 *
 * It lives at `components/ideas/` rather than inside `list/` or `matrix/`
 * because it belongs to neither: it is the seam.
 */

/* -------------------------------------------------------------------------- */
/* One fixture, two shapes                                                     */
/* -------------------------------------------------------------------------- */

const MONEY = "11111111-1111-4111-8111-111111111111";
const GEAR = "22222222-2222-4222-8222-222222222222";
const TUTORIAL = "33333333-3333-4333-8333-333333333333";
const REVIEW = "44444444-4444-4444-8444-444444444444";

const VERTICALS: MatrixBucket[] = [
  { id: MONEY, name: "money", position: 1, monthlyQuota: 2 },
  { id: GEAR, name: "gear", position: 2, monthlyQuota: null },
];

const HORIZONTALS: MatrixBucket[] = [
  { id: TUTORIAL, name: "tutorial", position: 1, monthlyQuota: null },
  { id: REVIEW, name: "review", position: 2, monthlyQuota: null },
];

/**
 * One row of the fixture, in the terms both pages share.
 *
 * `stage` is what tells the two apart: the bank lists `"idea"` rows only, the
 * matrix counts every one of them. `archived` rows exist in the bank's input
 * (it reads them so the toggle costs no round trip) and never in the matrix's.
 */
interface Row {
  readonly id: string;
  readonly title: string;
  readonly verticalId: string | null;
  readonly horizontalId: string | null;
  readonly stage: "idea" | "packaging" | "published";
  readonly archived?: boolean;
}

const ROWS: readonly Row[] = [
  // The cell under test: money · tutorial.
  { id: "a", title: "index funds explained", verticalId: MONEY, horizontalId: TUTORIAL, stage: "idea" },
  { id: "b", title: "sinking funds", verticalId: MONEY, horizontalId: TUTORIAL, stage: "idea" },
  { id: "c", title: "budget spreadsheet", verticalId: MONEY, horizontalId: TUTORIAL, stage: "packaging" },
  { id: "d", title: "first pay cheque", verticalId: MONEY, horizontalId: TUTORIAL, stage: "published" },
  // Archived, and in the same cell: the bank reads it, the matrix never does.
  { id: "e", title: "shelved money tutorial", verticalId: MONEY, horizontalId: TUTORIAL, stage: "idea", archived: true },

  // Elsewhere on the grid, so a filter that leaked would show up.
  { id: "f", title: "money review", verticalId: MONEY, horizontalId: REVIEW, stage: "idea" },
  { id: "g", title: "gear tutorial", verticalId: GEAR, horizontalId: TUTORIAL, stage: "idea" },

  // Off the grid: one axis each, and neither.
  { id: "h", title: "unfiled money idea", verticalId: MONEY, horizontalId: null, stage: "idea" },
  { id: "i", title: "unfiled tutorial", verticalId: null, horizontalId: TUTORIAL, stage: "idea" },
  { id: "j", title: "unfiled entirely", verticalId: null, horizontalId: null, stage: "idea" },
];

function asIdea(row: Row): Idea {
  return {
    id: row.id,
    title: row.title,
    oneLineHook: null,
    tags: [],
    verticalId: row.verticalId,
    horizontalId: row.horizontalId,
    verticalName: null,
    horizontalName: null,
    ageLabel: null,
    capturedLabel: null,
    archivedAt: row.archived ? "2026-09-01T00:00:00Z" : null,
    capturedMs: 0,
  };
}

function asMatrixVideo(row: Row): MatrixVideo {
  return {
    id: row.id,
    title: row.title,
    verticalId: row.verticalId,
    horizontalId: row.horizontalId,
    targetPublishDate: null,
    publishedAt: row.stage === "published" ? "2026-08-01T00:00:00Z" : null,
    stageName: row.stage,
    inBank: row.stage === "idea",
  };
}

/** What `/c/[slug]/ideas` is handed: the Idea stage, archived rows included. */
const BANK: readonly Idea[] = ROWS.filter((row) => row.stage === "idea").map(asIdea);

/** What `?view=matrix` is handed: every stage, archived rows excluded. */
const GRID: readonly MatrixVideo[] = ROWS.filter((row) => !row.archived).map(
  asMatrixVideo,
);

const TALLY = buildTally({
  verticals: VERTICALS,
  horizontals: HORIZONTALS,
  videos: GRID,
  month: monthWindow(Date.UTC(2026, 8, 18), "UTC"),
});

/* -------------------------------------------------------------------------- */

describe("the bank and the matrix agree about bucket membership", () => {
  it("names the same videos in a cell as the bank does under both bucket filters", () => {
    const cell = cellAt(TALLY, MONEY, TUTORIAL);

    // What the bank shows for the same two buckets, at its own scope.
    const listed = visibleIdeas(BANK, {
      ...NO_IDEA_FILTERS,
      verticalId: MONEY,
      horizontalId: TUTORIAL,
    });

    // The cell's Idea-stage rows are exactly the bank's rows. Not "the same
    // count" — the same ids, so a coincidence of arithmetic cannot pass.
    const inBank = cell.videos.filter((video) => video.inBank).map((v) => v.id);
    expect(inBank.sort()).toEqual(listed.map((idea) => idea.id).sort());

    // And the number the drill-down panel prints is that set's size.
    expect(cell.inBank).toBe(listed.length);
  });

  it("keeps the cell's larger count honest rather than equal", () => {
    const cell = cellAt(TALLY, MONEY, TUTORIAL);

    // The whole reason the two numbers differ: the matrix counts every stage.
    expect(cell.count).toBe(4);
    expect(cell.inBank).toBe(2);
    expect(cell.published).toBe(1);

    // The archived one is in neither: excluded from the grid outright, and out
    // of the bank's default scope.
    expect(cell.videos.some((video) => video.id === "e")).toBe(false);
    expect(
      visibleIdeas(BANK, {
        ...NO_IDEA_FILTERS,
        verticalId: MONEY,
        horizontalId: TUTORIAL,
      }).some((idea) => idea.id === "e"),
    ).toBe(false);

    // Turning the scope on brings it back, and only it.
    expect(
      visibleIdeas(BANK, {
        ...NO_IDEA_FILTERS,
        verticalId: MONEY,
        horizontalId: TUTORIAL,
        includeArchived: true,
      }).map((idea) => idea.id),
    ).toEqual(["a", "b", "e"]);
  });

  it("agrees on every cell of the grid, not only the interesting one", () => {
    for (const vertical of VERTICALS) {
      for (const horizontal of HORIZONTALS) {
        const cell = cellAt(TALLY, vertical.id, horizontal.id);
        const listed = visibleIdeas(BANK, {
          ...NO_IDEA_FILTERS,
          verticalId: vertical.id,
          horizontalId: horizontal.id,
        });
        expect({
          cell: `${vertical.name}·${horizontal.name}`,
          ids: cell.videos.filter((v) => v.inBank).map((v) => v.id).sort(),
        }).toEqual({
          cell: `${vertical.name}·${horizontal.name}`,
          ids: listed.map((idea) => idea.id).sort(),
        });
      }
    }
  });

  it("counts a bucket's total over the whole axis, cells and off-grid alike", () => {
    // `money` carries a, b, c, d, f and h — the archived e is not counted, and
    // h is off the grid but still an investment in the pillar.
    const money = TALLY.verticals.find((entry) => entry.bucket.id === MONEY);
    expect(money?.total).toBe(6);

    // Which is deliberately not the sum of the row's cells.
    const rowCells =
      cellAt(TALLY, MONEY, TUTORIAL).count + cellAt(TALLY, MONEY, REVIEW).count;
    expect(rowCells).toBe(5);

    // h, i and j: one axis each, and neither.
    expect(TALLY.offGrid).toBe(3);
  });
});

describe("the link the matrix offers lands on the list it promised", () => {
  it("round-trips a cell's buckets through the query string", () => {
    const href = ideaBankHref("pennies", {
      verticalId: MONEY,
      horizontalId: TUTORIAL,
    });
    expect(href).toBe(
      `/c/pennies/ideas?vertical=${MONEY}&horizontal=${TUTORIAL}`,
    );

    // Parsed back by the route, against this channel's buckets.
    const params = new URLSearchParams(href.split("?")[1]);
    const filters = readIdeaFilters((key) => params.get(key), {
      verticals: VERTICALS,
      horizontals: HORIZONTALS,
    });
    expect(filters.verticalId).toBe(MONEY);
    expect(filters.horizontalId).toBe(TUTORIAL);

    // And the list it produces is the cell's bank rows, which is the whole
    // claim the link makes.
    expect(visibleIdeas(BANK, filters).map((idea) => idea.id)).toEqual([
      "a",
      "b",
    ]);
    expect(cellAt(TALLY, MONEY, TUTORIAL).inBank).toBe(2);
  });

  it("drops a bucket id this channel does not have rather than filtering by it", () => {
    const params = new URLSearchParams({
      vertical: "99999999-9999-4999-8999-999999999999",
      // A vertical id in the horizontal slot: the right shape, the wrong axis.
      horizontal: MONEY,
    });
    const filters = readIdeaFilters((key) => params.get(key), {
      verticals: VERTICALS,
      horizontals: HORIZONTALS,
    });
    expect(filters.verticalId).toBeNull();
    expect(filters.horizontalId).toBeNull();
    // So a stale link opens the bank, rather than an empty list explaining
    // itself as "the vertical “that bucket”".
    expect(visibleIdeas(BANK, filters)).toHaveLength(BANK.length - 1);
  });

  it("leaves the defaults out of the URL, so a filtered bank is visibly filtered", () => {
    expect(ideaBankHref("pennies", {})).toBe("/c/pennies/ideas");
    expect(ideaBankHref("pennies", { search: "  funds  " })).toBe(
      "/c/pennies/ideas?q=funds",
    );
    expect(ideaBankHref("pennies", { includeArchived: true })).toBe(
      "/c/pennies/ideas?archived=1",
    );
  });
});
