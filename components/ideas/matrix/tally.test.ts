import { describe, expect, it } from "vitest";

import {
  buildTally,
  cellAt,
  cellKey,
  inMonth,
  monthWindow,
  quotaPercent,
  weightPercent,
  type MatrixBucket,
  type MatrixVideo,
} from "@/components/ideas/matrix/tally";

/**
 * The matrix's arithmetic, tested where a browser would be a bad instrument.
 *
 * Two of these are about the calendar, and the calendar is the part of this
 * feature that cannot be checked by looking at it: a quota bar that quietly
 * counts December's videos in January looks exactly like a correct one until
 * the first week of January, and then only to the person who set the quota.
 */

function bucket(
  id: string,
  name: string,
  position: number,
  monthlyQuota: number | null = null,
): MatrixBucket {
  return { id, name, position, monthlyQuota };
}

function video(input: Partial<MatrixVideo> & { id: string }): MatrixVideo {
  return {
    title: input.id,
    verticalId: null,
    horizontalId: null,
    targetPublishDate: null,
    publishedAt: null,
    stageName: "Idea",
    inBank: true,
    ...input,
  };
}

describe("monthWindow", () => {
  it("is the calendar month the instant falls in, in UTC", () => {
    const month = monthWindow(Date.UTC(2026, 8, 18, 11, 30));
    expect(month.start).toBe("2026-09-01");
    expect(month.next).toBe("2026-10-01");
    expect(month.label).toBe("September 2026");
  });

  it("rolls the year over in December rather than producing month 13", () => {
    const month = monthWindow(Date.UTC(2026, 11, 31, 23, 59));
    expect(month.start).toBe("2026-12-01");
    expect(month.next).toBe("2027-01-01");
    expect(month.label).toBe("December 2026");
  });

  it("zero-pads, so the strings still sort as dates", () => {
    const month = monthWindow(Date.UTC(2026, 0, 5));
    expect(month.start).toBe("2026-01-01");
    expect(month.next).toBe("2026-02-01");
  });
});

describe("inMonth", () => {
  const month = monthWindow(Date.UTC(2026, 8, 18));

  it("includes both ends of the month", () => {
    expect(inMonth("2026-09-01", month)).toBe(true);
    expect(inMonth("2026-09-30", month)).toBe(true);
  });

  it("excludes the day either side", () => {
    expect(inMonth("2026-08-31", month)).toBe(false);
    expect(inMonth("2026-10-01", month)).toBe(false);
  });

  it("treats no target date as not this month, never as now", () => {
    expect(inMonth(null, month)).toBe(false);
  });
});

describe("buildTally", () => {
  const verticals = [bucket("v1", "money", 1), bucket("v2", "focus", 2)];
  const horizontals = [
    bucket("h1", "tutorial", 1),
    bucket("h2", "review", 2, 2),
  ];
  const month = monthWindow(Date.UTC(2026, 8, 18));

  it("counts a cell, and says how many of it have been published", () => {
    const tally = buildTally({
      verticals,
      horizontals,
      month,
      videos: [
        video({ id: "a", verticalId: "v1", horizontalId: "h1" }),
        video({
          id: "b",
          verticalId: "v1",
          horizontalId: "h1",
          publishedAt: "2026-05-01T00:00:00Z",
        }),
        video({ id: "c", verticalId: "v2", horizontalId: "h2" }),
      ],
    });

    const filled = cellAt(tally, "v1", "h1");
    expect(filled.count).toBe(2);
    expect(filled.published).toBe(1);
    expect(filled.videos.map((v) => v.id)).toEqual(["a", "b"]);

    // Never published here: the count is 1, the published count is 0, and the
    // grid has to be able to tell those apart.
    expect(cellAt(tally, "v2", "h2").published).toBe(0);

    // An intersection nothing sits at is a real zero cell, not undefined.
    const empty = cellAt(tally, "v2", "h1");
    expect(empty.count).toBe(0);
    expect(empty.videos).toEqual([]);
    expect(tally.cells.has(cellKey("v2", "h1"))).toBe(false);
  });

  it("puts a video with only one axis in no cell, and says so", () => {
    const tally = buildTally({
      verticals,
      horizontals,
      month,
      videos: [
        video({ id: "a", verticalId: "v1", horizontalId: "h1" }),
        video({ id: "b", verticalId: "v1" }),
        video({ id: "c", horizontalId: "h1" }),
        video({ id: "d" }),
      ],
    });

    expect(tally.onGrid).toBe(1);
    expect(tally.offGrid).toBe(3);

    // The pillar still owns the pillar-only video: the bucket total is an
    // investment count, not a sum of the row's cells.
    expect(tally.verticals[0].total).toBe(2);
    expect(cellAt(tally, "v1", "h1").count).toBe(1);
  });

  it("ignores an id neither axis was given, rather than inventing a cell", () => {
    const tally = buildTally({
      verticals,
      horizontals,
      month,
      videos: [video({ id: "a", verticalId: "ghost", horizontalId: "h1" })],
    });

    expect(tally.onGrid).toBe(0);
    expect(tally.offGrid).toBe(1);
    expect(tally.horizontals[0].total).toBe(1);
    expect(tally.cells.size).toBe(0);
  });

  it("counts a bucket's month from target_publish_date and nothing else", () => {
    const tally = buildTally({
      verticals,
      horizontals,
      month,
      videos: [
        // In the month, on the first and last day.
        video({ id: "a", horizontalId: "h2", targetPublishDate: "2026-09-01" }),
        video({ id: "b", horizontalId: "h2", targetPublishDate: "2026-09-30" }),
        // Last month and next month.
        video({ id: "c", horizontalId: "h2", targetPublishDate: "2026-08-31" }),
        video({ id: "d", horizontalId: "h2", targetPublishDate: "2026-10-01" }),
        // No date at all: in the bucket, not in the month.
        video({ id: "e", horizontalId: "h2" }),
        // Published last month but scheduled into this one: the date decides,
        // not the publication.
        video({
          id: "f",
          horizontalId: "h2",
          targetPublishDate: "2026-09-12",
          publishedAt: "2026-08-20T00:00:00Z",
        }),
      ],
    });

    expect(tally.horizontals[1].bucket.monthlyQuota).toBe(2);
    expect(tally.horizontals[1].thisMonth).toBe(3);
    expect(tally.horizontals[1].total).toBe(6);
  });

  it("gives a bucket with no quota a count and no target", () => {
    const tally = buildTally({
      verticals,
      horizontals,
      month,
      videos: [video({ id: "a", horizontalId: "h1", targetPublishDate: "2026-09-04" })],
    });

    expect(tally.horizontals[0].bucket.monthlyQuota).toBeNull();
    expect(tally.horizontals[0].thisMonth).toBe(1);
  });

  it("reports the heaviest cell, which is what the weight bars scale to", () => {
    const tally = buildTally({
      verticals,
      horizontals,
      month,
      videos: [
        video({ id: "a", verticalId: "v1", horizontalId: "h1" }),
        video({ id: "b", verticalId: "v1", horizontalId: "h1" }),
        video({ id: "c", verticalId: "v1", horizontalId: "h1" }),
        video({ id: "d", verticalId: "v2", horizontalId: "h2" }),
      ],
    });

    expect(tally.heaviest).toBe(3);
  });

  it("is all zeroes when there is nothing to count", () => {
    const tally = buildTally({ verticals, horizontals, month, videos: [] });
    expect(tally.heaviest).toBe(0);
    expect(tally.onGrid).toBe(0);
    expect(tally.offGrid).toBe(0);
    expect(tally.verticals.every((row) => row.total === 0)).toBe(true);
  });
});

describe("the two bar widths", () => {
  it("never draws a present cell as an absent one", () => {
    expect(weightPercent(1, 8)).toBeGreaterThanOrEqual(12);
    expect(weightPercent(8, 8)).toBe(100);
    expect(weightPercent(0, 8)).toBe(0);
    // Nothing anywhere: no bar, and no division by zero.
    expect(weightPercent(3, 0)).toBe(0);
  });

  it("fills a quota bar at the quota and clamps above it", () => {
    expect(quotaPercent(1, 2)).toBe(50);
    expect(quotaPercent(2, 2)).toBe(100);
    expect(quotaPercent(5, 2)).toBe(100);
    expect(quotaPercent(0, 2)).toBe(0);
  });
});
