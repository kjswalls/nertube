import { describe, expect, it } from "vitest";

import {
  AXIS_SHAPE,
  BUCKET_NAME_MAX,
  BucketNameSchema,
  MAX_QUOTA,
  QuotaSchema,
  axisCountSentence,
  axisStanding,
  bucketNameTaken,
  duplicateSentence,
  moveBucket,
  nextBucketPosition,
  parseQuotaInput,
  quotaText,
  sortBuckets,
  unfiledSentence,
} from "./bucket-settings";
import { SEED_BUCKETS } from "./defaults";

const FORMATS = SEED_BUCKETS.map((bucket) => ({
  id: bucket.name,
  name: bucket.name,
  position: bucket.position,
}));

describe("BucketNameSchema", () => {
  it("trims, and refuses blank and over-long names in words", () => {
    expect(BucketNameSchema.parse("  money  ")).toBe("money");
    const blank = BucketNameSchema.safeParse("   ");
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error.issues[0].message).toMatch(/needs a name/);
    const long = BucketNameSchema.safeParse("x".repeat(BUCKET_NAME_MAX + 1));
    expect(long.success).toBe(false);
  });
});

describe("bucketNameTaken", () => {
  it("is case- and whitespace-insensitive, because the matrix heading is", () => {
    expect(bucketNameTaken("Review", FORMATS)).toBe(true);
    expect(bucketNameTaken(" review ", FORMATS)).toBe(true);
    expect(bucketNameTaken("reviews", FORMATS)).toBe(false);
    expect(bucketNameTaken("review", [])).toBe(false);
  });

  it("names the axis in the sentence", () => {
    expect(duplicateSentence("horizontal", "review")).toMatch(/format called “review”/);
    expect(duplicateSentence("vertical", "money")).toMatch(/topic pillar called “money”/);
  });
});

describe("the quota", () => {
  it("refuses zero, negatives and fractions before the database's CHECK", () => {
    expect(QuotaSchema.safeParse(0).success).toBe(false);
    expect(QuotaSchema.safeParse(-2).success).toBe(false);
    expect(QuotaSchema.safeParse(1.5).success).toBe(false);
    expect(QuotaSchema.safeParse(MAX_QUOTA + 1).success).toBe(false);
    expect(QuotaSchema.safeParse(1).success).toBe(true);
    expect(QuotaSchema.safeParse(MAX_QUOTA).success).toBe(true);
  });

  it("reads an empty box as no quota, and says why zero is not that", () => {
    expect(parseQuotaInput("")).toEqual({ ok: true, value: null });
    expect(parseQuotaInput("   ")).toEqual({ ok: true, value: null });
    expect(parseQuotaInput(" 2 ")).toEqual({ ok: true, value: 2 });
    const zero = parseQuotaInput("0");
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toMatch(/zero is not a quota/);
    expect(parseQuotaInput("-1").ok).toBe(false);
    expect(parseQuotaInput("two").ok).toBe(false);
    expect(parseQuotaInput("2.5").ok).toBe(false);
  });

  it("prints null as nothing", () => {
    expect(quotaText(null)).toBe("");
    expect(quotaText(3)).toBe("3");
  });
});

describe("the shape of an axis", () => {
  it("stands a count against the brief's 3–5 and 8–12", () => {
    expect(AXIS_SHAPE.vertical).toEqual({ min: 3, max: 5 });
    expect(AXIS_SHAPE.horizontal).toEqual({ min: 8, max: 12 });
    expect(axisStanding("vertical", 0)).toBe("none");
    expect(axisStanding("vertical", 2)).toBe("under");
    expect(axisStanding("vertical", 3)).toBe("within");
    expect(axisStanding("vertical", 5)).toBe("within");
    expect(axisStanding("vertical", 6)).toBe("over");
    expect(axisStanding("horizontal", 8)).toBe("within");
    expect(axisStanding("horizontal", 13)).toBe("over");
  });

  it("says it in one sentence that changes with the count", () => {
    expect(axisCountSentence("vertical", 0)).toBe("No topic pillars yet — the brief suggests 3–5.");
    expect(axisCountSentence("vertical", 1)).toMatch(/^1 topic pillar — the brief suggests 3–5\./);
    expect(axisCountSentence("vertical", 4)).toMatch(/^4 topic pillars — within the 3–5/);
    expect(axisCountSentence("horizontal", 8)).toMatch(/^8 formats — within the 8–12/);
    expect(axisCountSentence("horizontal", 14)).toMatch(/more than the 8–12/);
  });
});

describe("unfiledSentence", () => {
  it("says what a removal does to the videos, with the count and the axis", () => {
    expect(unfiledSentence("vertical", "money", 0)).toMatch(/changes no video/);
    expect(unfiledSentence("vertical", "money", 1)).toMatch(
      /^One video is filed under “money”\. Removing it leaves it with no topic pillar/,
    );
    expect(unfiledSentence("horizontal", "vlog", 3)).toMatch(
      /^3 videos are filed under “vlog”\. Removing it leaves them with no format/,
    );
  });
});

describe("order", () => {
  it("sorts by position, then id, and appends after the last", () => {
    const shuffled = [FORMATS[3], FORMATS[0], FORMATS[7]];
    expect(sortBuckets(shuffled).map((b) => b.name)).toEqual(["tutorial", "self-experiment", "interview"]);
    expect(nextBucketPosition([])).toBe(1);
    expect(nextBucketPosition(FORMATS)).toBe(9);
    // A gap left by a removal is not filled: after the last, always.
    expect(nextBucketPosition([{ id: "a", position: 1 }, { id: "c", position: 4 }])).toBe(5);
  });

  it("moves one step and renumbers the whole axis 1..n", () => {
    const moved = moveBucket(FORMATS, "review", "up")!;
    expect(moved.map((b) => b.name).slice(0, 3)).toEqual(["tutorial", "review", "listicle"]);
    expect(moved.map((b) => b.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The input is untouched.
    expect(FORMATS[1].name).toBe("listicle");
  });

  it("is null at either end and for a bucket not on the axis", () => {
    expect(moveBucket(FORMATS, "tutorial", "up")).toBeNull();
    expect(moveBucket(FORMATS, "interview", "down")).toBeNull();
    expect(moveBucket(FORMATS, "money", "down")).toBeNull();
  });

  it("closes gaps on the way through, so a swap after a removal is still 1..n", () => {
    const gappy = [
      { id: "a", name: "a", position: 1 },
      { id: "c", name: "c", position: 4 },
      { id: "d", name: "d", position: 9 },
    ];
    const moved = moveBucket(gappy, "d", "up")!;
    expect(moved.map((b) => [b.id, b.position])).toEqual([["a", 1], ["d", 2], ["c", 3]]);
  });
});
