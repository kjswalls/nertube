import { describe, expect, it } from "vitest";

import { EMPTY_STAGE_STATS, stageStats } from "./stage-stats";

/**
 * The weekly strip is three numbers, and the only one anybody would guess
 * wrong is the median. These are the cases that decide whether the strip can be
 * trusted to answer "where are videos piling up?" — an even column, a column of
 * one, a column of none, and a stamp nobody can parse.
 */

const NOW = Date.parse("2025-09-15T09:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("stageStats", () => {
  it("is all-null for an empty column, so nothing is drawn", () => {
    expect(stageStats([], NOW)).toEqual(EMPTY_STAGE_STATS);
  });

  it("counts, and finds the oldest", () => {
    const stats = stageStats([ago(1), ago(12), ago(3)], NOW);
    expect(stats.count).toBe(3);
    expect(stats.oldestDays).toBe(12);
  });

  it("takes the middle value of an odd column", () => {
    expect(stageStats([ago(1), ago(12), ago(3)], NOW).medianDays).toBe(3);
  });

  it("averages the two middles of an even column, then floors", () => {
    // 1, 3, 4, 12 → (3 + 4) / 2 = 3.5 days → 3.
    expect(stageStats([ago(1), ago(12), ago(3), ago(4)], NOW).medianDays).toBe(3);
  });

  it("reads one card as its own median", () => {
    expect(stageStats([ago(5)], NOW)).toEqual({
      count: 1,
      oldestDays: 5,
      medianDays: 5,
    });
  });

  it("floors part-days rather than rounding them up", () => {
    const stats = stageStats([new Date(NOW - 23 * 3_600_000).toISOString()], NOW);
    expect(stats.oldestDays).toBe(0);
  });

  it("counts a card whose stamp will not parse, and ages it at zero", () => {
    const stats = stageStats(["not a timestamp", ago(4)], NOW);
    expect(stats.count).toBe(2);
    expect(stats.oldestDays).toBe(4);
    expect(stats.medianDays).toBe(2); // (0 + 4) / 2
  });

  it("never reports a negative age from a clock that is slightly ahead", () => {
    const stats = stageStats([new Date(NOW + 5_000).toISOString()], NOW);
    expect(stats.oldestDays).toBe(0);
    expect(stats.medianDays).toBe(0);
  });
});
