import { describe, expect, it } from "vitest";

import {
  LogMetricsSchema,
  MAX_NEW_VIEWERS_NOTE,
  NewViewersNoteSchema,
  PAIR_REQUIRED,
  formatCtr,
  formatImpressions,
  metricsRefusal,
  swapVerdict,
} from "./metrics";

const VIDEO = "11111111-1111-4111-8111-111111111111";

/**
 * The pair rule, asserted at the level a reviewer will attack it.
 *
 * The browser refuses a half-filled pair before sending, the action refuses it
 * before writing, and the CHECK refuses it in the row. This file is the middle
 * one, and it is the one that has a type: there is no parse of
 * `LogMetricsSchema` that produces a CTR without impressions, so a caller
 * cannot construct the write even by accident.
 */
describe("the impressions/CTR pair", () => {
  it("refuses a click-through with no impressions", () => {
    const parsed = LogMetricsSchema.safeParse({
      videoId: VIDEO,
      ctr: 4.2,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses impressions with no click-through", () => {
    const parsed = LogMetricsSchema.safeParse({
      videoId: VIDEO,
      impressions: 12_400,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts the pair, with views and the note optional", () => {
    const bare = LogMetricsSchema.safeParse({
      videoId: VIDEO,
      impressions: 12_400,
      ctr: 4.2,
    });
    expect(bare.success).toBe(true);
    if (bare.success) {
      expect(bare.data.views).toBeUndefined();
      expect(bare.data.newViewersNote).toBeUndefined();
    }

    const full = LogMetricsSchema.safeParse({
      videoId: VIDEO,
      impressions: 12_400,
      ctr: 4.2,
      views: 520,
      newViewersNote: "  about half were not subscribed  ",
    });
    expect(full.success).toBe(true);
    if (full.success) {
      expect(full.data.views).toBe(520);
      expect(full.data.newViewersNote).toBe("about half were not subscribed");
    }
  });

  it("keeps the CTR a percentage, rounded to what the column stores", () => {
    expect(
      LogMetricsSchema.safeParse({ videoId: VIDEO, impressions: 1, ctr: 101 })
        .success,
    ).toBe(false);
    expect(
      LogMetricsSchema.safeParse({ videoId: VIDEO, impressions: 1, ctr: -0.1 })
        .success,
    ).toBe(false);

    const rounded = LogMetricsSchema.safeParse({
      videoId: VIDEO,
      impressions: 1,
      ctr: 4.2349,
    });
    expect(rounded.success && rounded.data.ctr).toBe(4.23);
  });

  it("refuses a fractional impressions count and a negative one", () => {
    expect(
      LogMetricsSchema.safeParse({ videoId: VIDEO, impressions: 1.5, ctr: 4 })
        .success,
    ).toBe(false);
    expect(
      LogMetricsSchema.safeParse({ videoId: VIDEO, impressions: -1, ctr: 4 })
        .success,
    ).toBe(false);
  });
});

describe("the new-viewers note", () => {
  it("treats blank as nothing rather than as an empty string", () => {
    expect(NewViewersNoteSchema.parse("   ")).toBeNull();
    expect(NewViewersNoteSchema.parse(null)).toBeNull();
  });

  it("is a sentence, not a report", () => {
    const tooLong = "x".repeat(MAX_NEW_VIEWERS_NOTE + 1);
    expect(NewViewersNoteSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe("what the database's refusals say", () => {
  it("turns the paired CHECK into the sentence the form uses", () => {
    expect(
      metricsRefusal(
        'new row for relation "videos" violates check constraint "videos_ctr_needs_impressions"',
      ),
    ).toBe(PAIR_REQUIRED);
  });

  it("passes anything else through rather than guessing", () => {
    expect(metricsRefusal("connection reset")).toContain("connection reset");
  });
});

describe("the swap verdict", () => {
  it("has no verdict when there is no expectation", () => {
    expect(swapVerdict(4.2, null).kind).toBe("unknown");
    expect(swapVerdict(null, 5).kind).toBe("unknown");
  });

  it("is urgent strictly below, and met at the line", () => {
    expect(swapVerdict(4.2, 5).kind).toBe("below");
    // The same `<` comparison rule 3 makes, so the /now row and the page's
    // prompt cannot disagree about one video.
    expect(swapVerdict(5, 5).kind).toBe("met");
    expect(swapVerdict(6.1, 5).kind).toBe("met");
  });

  it("reports the shortfall in points, rounded the way a CTR is", () => {
    const verdict = swapVerdict(4.2, 5);
    expect(verdict.kind === "below" && verdict.shortfall).toBe(0.8);
  });
});

describe("how a measured number reads", () => {
  it("groups impressions and trims a CTR's trailing zeros", () => {
    expect(formatImpressions(12400)).toBe("12,400");
    expect(formatCtr(4.2)).toBe("4.2");
    expect(formatCtr(4.0)).toBe("4");
    expect(formatCtr(4.239)).toBe("4.24");
  });
});
