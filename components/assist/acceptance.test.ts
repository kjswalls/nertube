import { describe, expect, it } from "vitest";

import { capacityLine, describeAcceptance, describeMeta } from "./acceptance";
import { MAX_CANDIDATES, MAX_HOOKS } from "@/lib/packaging";

describe("capacityLine", () => {
  it("says nothing while both lists have plenty of room", () => {
    expect(capacityLine(40, 3)).toBeNull();
  });

  it("warns before the last few candidates rather than after", () => {
    expect(capacityLine(2, 3)).toMatch(/Room for 2 more candidates/);
    expect(capacityLine(1, 3)).toMatch(/Room for 1 more candidate\b/);
  });

  it("names the ceiling that is full, and what still works", () => {
    expect(capacityLine(0, 2)).toContain(String(MAX_CANDIDATES));
    expect(capacityLine(0, 2)).toMatch(/Use as hook. still works/);
    expect(capacityLine(10, 0)).toContain(String(MAX_HOOKS));
    expect(capacityLine(10, 0)).toMatch(/candidates are unaffected/i);
    expect(capacityLine(0, 0)).toMatch(/Both lists are full/);
  });
});

describe("describeAcceptance", () => {
  it("counts what landed", () => {
    expect(describeAcceptance({ added: 6, duplicates: 0, noRoom: 0 }, 6)).toBe(
      "Added 6 candidates to your list.",
    );
    expect(describeAcceptance({ added: 1, duplicates: 0, noRoom: 0 }, 1)).toBe(
      "Added 1 candidate to your list.",
    );
  });

  it("never drops a suggestion silently", () => {
    const line = describeAcceptance({ added: 4, duplicates: 2, noRoom: 3 }, 9);
    expect(line).toMatch(/Added 4 candidates/);
    expect(line).toMatch(/2 were already there/);
    expect(line).toMatch(/3 did not fit/);
  });

  it("explains an add that did nothing at all", () => {
    expect(describeAcceptance({ added: 0, duplicates: 1, noRoom: 0 }, 1)).toMatch(
      /already in your candidate list/,
    );
    expect(describeAcceptance({ added: 0, duplicates: 0, noRoom: 5 }, 5)).toMatch(
      new RegExp(`full at ${MAX_CANDIDATES}`),
    );
    expect(describeAcceptance({ added: 0, duplicates: 2, noRoom: 3 }, 5)).toMatch(
      /2 were already in your list and there was no room for 3/,
    );
  });
});

describe("describeMeta", () => {
  const meta = {
    provider: "fake" as const,
    model: "fixtures",
    requested: 20,
    returned: 20,
    droppedOverflow: 0,
    droppedDuplicates: 0,
    droppedUnusable: 0,
    recommendationAdjusted: false,
    servedByFallback: false,
    elapsedMs: 900,
  };

  it("says nothing when the answer arrived as asked for", () => {
    expect(describeMeta(meta)).toBeNull();
    expect(describeMeta(null)).toBeNull();
  });

  it("says what was clamped rather than hiding it", () => {
    const line = describeMeta({
      ...meta,
      droppedOverflow: 1,
      droppedDuplicates: 2,
      droppedUnusable: 1,
    });
    expect(line).toMatch(/1 past the 20 asked for/);
    expect(line).toMatch(/2 that repeated something/);
    expect(line).toMatch(/1 that could not be stored/);
  });

  it("says when the pick moved, and when a fallback model answered", () => {
    expect(describeMeta({ ...meta, recommendationAdjusted: true })).toMatch(
      /the first is marked instead/,
    );
    expect(describeMeta({ ...meta, servedByFallback: true })).toMatch(
      /fallback model/,
    );
  });
});

describe("describeAcceptance with nothing to accept", () => {
  it("never renders a sentence made of zeros", () => {
    /*
      "Add all as candidates" was disabled only on a full list, so with zero
      proposals on screen it dispatched an empty batch and the catch-all below
      produced "Nothing added — 0 were already in your list and there was no
      room for 0" — in the file whose doc comment promises "always a full
      sentence". The panel disables the button now; this is the rule behind it.
    */
    const sentence = describeAcceptance(
      { added: 0, duplicates: 0, noRoom: 0 },
      0,
    );

    expect(sentence).toBe("There was nothing to add.");
    expect(sentence).not.toContain("0");
  });
});
