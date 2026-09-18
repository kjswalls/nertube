import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  explainEmpty,
  matchesFilters,
  visibleIdeas,
  type FilterLabels,
} from "./filtering";
import { NO_IDEA_FILTERS, type Idea, type IdeaFilters } from "./types";

/*
  The three sentences `explainEmpty` has to tell apart are the reason this file
  exists; the matching itself is here because "filters combine" is an assertion
  about AND, and AND is exactly the thing a hand-written chain of `if`s gets
  wrong when the fourth one is added.
*/

const VERTICALS = [
  { id: "v-money", name: "Money" },
  { id: "v-craft", name: "Craft" },
];
const HORIZONTALS = [
  { id: "h-tutorial", name: "tutorial" },
  { id: "h-review", name: "review" },
];
const LABELS: FilterLabels = {
  verticals: VERTICALS,
  horizontals: HORIZONTALS,
};

function idea(over: Partial<Idea> & { id: string }): Idea {
  return {
    title: "An idea",
    oneLineHook: null,
    tags: [],
    verticalId: null,
    horizontalId: null,
    verticalName: null,
    horizontalName: null,
    ageLabel: "1 day",
    capturedLabel: "17 Sep 2026",
    archivedAt: null,
    capturedMs: 0,
    ...over,
  };
}

function filters(over: Partial<IdeaFilters> = {}): IdeaFilters {
  return { ...NO_IDEA_FILTERS, ...over };
}

const BANK: readonly Idea[] = [
  idea({
    id: "a",
    title: "Desk tour, but only what earns its place",
    oneLineHook: "Everything that survived a year of use",
    tags: ["gear", "desk"],
    verticalId: "v-craft",
    horizontalId: "h-review",
  }),
  idea({
    id: "b",
    title: "How I price a freelance day",
    oneLineHook: "The number, and how I got to it",
    tags: ["money"],
    verticalId: "v-money",
    horizontalId: "h-tutorial",
  }),
  idea({
    id: "c",
    title: "Reading a balance sheet in ten minutes",
    tags: ["money"],
    verticalId: "v-money",
    horizontalId: null,
  }),
  idea({
    id: "d",
    title: "The build log nobody asked for",
    archivedAt: "2026-09-01T00:00:00Z",
    tags: ["gear"],
  }),
];

const idsOf = (list: readonly Idea[]): string[] => list.map((one) => one.id);

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

describe("matchesFilters", () => {
  it("passes everything when nothing is switched on", () => {
    expect(BANK.every((one) => matchesFilters(one, filters()))).toBe(true);
    expect(activeFilterCount(filters())).toBe(0);
  });

  it("searches the title and the one-line hook, not the ids", () => {
    expect(idsOf(visibleIdeas(BANK, filters({ search: "desk" })))).toEqual([
      "a",
    ]);
    // The hook only — "survived" is in no title.
    expect(idsOf(visibleIdeas(BANK, filters({ search: "survived" })))).toEqual([
      "a",
    ]);
    // Case and surrounding space are not the user's problem.
    expect(
      idsOf(visibleIdeas(BANK, filters({ search: "  BALANCE " }))),
    ).toEqual(["c"]);
  });

  it("filters by tag, vertical and horizontal", () => {
    expect(idsOf(visibleIdeas(BANK, filters({ tag: "money" })))).toEqual([
      "b",
      "c",
    ]);
    expect(
      idsOf(visibleIdeas(BANK, filters({ verticalId: "v-money" }))),
    ).toEqual(["b", "c"]);
    expect(
      idsOf(visibleIdeas(BANK, filters({ horizontalId: "h-tutorial" }))),
    ).toEqual(["b"]);
  });

  it("combines them with AND", () => {
    expect(
      idsOf(
        visibleIdeas(
          BANK,
          filters({ tag: "money", verticalId: "v-money", search: "price" }),
        ),
      ),
    ).toEqual(["b"]);

    // Same three filters, one of them changed: the intersection is empty even
    // though each part still matches something.
    expect(
      visibleIdeas(
        BANK,
        filters({ tag: "money", horizontalId: "h-review" }),
      ),
    ).toEqual([]);
  });

  it("keeps archived ideas out of scope until they are asked for", () => {
    expect(idsOf(visibleIdeas(BANK, filters({ tag: "gear" })))).toEqual(["a"]);
    expect(
      idsOf(visibleIdeas(BANK, filters({ tag: "gear", includeArchived: true }))),
    ).toEqual(["a", "d"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The empty state                                                             */
/* -------------------------------------------------------------------------- */

describe("explainEmpty", () => {
  it("names the one filter that is empty on its own", () => {
    const active = filters({ tag: "nonexistent", verticalId: "v-money" });
    expect(visibleIdeas(BANK, active)).toEqual([]);
    expect(explainEmpty(BANK, active, LABELS)).toBe(
      'No idea in this bank is tagged “nonexistent”.',
    );
  });

  it("names every filter that is empty on its own", () => {
    const active = filters({ search: "kayak", tag: "nonexistent" });
    expect(explainEmpty(BANK, active, LABELS)).toBe(
      'No idea in this bank matches “kayak” or is tagged “nonexistent”.',
    );
  });

  it("says so when each filter works but the combination does not", () => {
    const active = filters({ tag: "money", horizontalId: "h-review" });
    expect(visibleIdeas(BANK, active)).toEqual([]);
    expect(explainEmpty(BANK, active, LABELS)).toBe(
      'Each filter finds something on its own, but no idea has the tag “money” and the horizontal “review” together.',
    );
  });

  it("points at the archived ones when that is where the match is", () => {
    const active = filters({ search: "build log" });
    expect(visibleIdeas(BANK, active)).toEqual([]);
    expect(explainEmpty(BANK, active, LABELS)).toBe(
      'No idea in this bank matches “build log”.' +
        ' 1 archived idea does — turn on "Show archived" to see it.',
    );
  });

  it("does not blame a filter for an empty bank", () => {
    expect(explainEmpty([], filters(), LABELS)).toBe(
      "This bank is empty. Press c to capture an idea — a title is enough.",
    );
    expect(explainEmpty([], filters({ tag: "gear" }), LABELS)).toBe(
      "This bank is empty, so no filter can find anything in it.",
    );
  });

  it("distinguishes an empty bank from an entirely archived one", () => {
    const archived = [idea({ id: "z", archivedAt: "2026-01-01T00:00:00Z" })];
    expect(explainEmpty(archived, filters(), LABELS)).toBe(
      "Every idea in this bank is archived.",
    );
  });

  it("counts a bucket that no longer exists without pretending to name it", () => {
    const active = filters({ verticalId: "v-gone" });
    expect(explainEmpty(BANK, active, LABELS)).toBe(
      'No idea in this bank is in the vertical “that bucket”.',
    );
  });
});
