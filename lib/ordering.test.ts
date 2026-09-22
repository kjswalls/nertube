import { describe, expect, it } from "vitest";

import { moveBucket, nextBucketPosition, sortBuckets } from "./bucket-settings";
import { moveTemplate, sortTemplates, type TemplateItem } from "./checklist-templates";
import {
  isPermutationOf,
  moved,
  movedByPosition,
  nameTaken,
  nextPosition,
  renumber,
  sortByPosition,
} from "./ordering";
import { moved as stageMoved, nameTaken as stageNameTaken } from "./stage-settings";

/**
 * One module behind three editors. The bucket and template suites still pin
 * their own names; this pins that those names are the same functions, so the
 * arithmetic cannot drift apart again.
 */

const ROWS = [
  { id: "c", position: 3 },
  { id: "a", position: 1 },
  { id: "b", position: 2 },
];

describe("lib/ordering", () => {
  it("sorts by position then id, appends after the last, renumbers 1..n", () => {
    expect(sortByPosition(ROWS).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(nextPosition(ROWS)).toBe(4);
    expect(nextPosition([])).toBe(1);
    expect(renumber([{ position: 9 }, { position: 4 }]).map((r) => r.position)).toEqual([1, 2]);
  });

  it("moves one step by index, and by id with a renumber", () => {
    expect(moved(["x", "y", "z"], 1, "up")).toEqual(["y", "x", "z"]);
    expect(moved(["x", "y", "z"], 0, "up")).toBeNull();
    const byId = movedByPosition(ROWS, "c", "up")!;
    expect(byId.map((r) => [r.id, r.position])).toEqual([["a", 1], ["c", 2], ["b", 3]]);
    expect(movedByPosition(ROWS, "a", "up")).toBeNull();
    expect(movedByPosition(ROWS, "nope", "down")).toBeNull();
  });

  it("is the one implementation the three settings libs export", () => {
    expect(stageMoved).toBe(moved);
    expect(stageNameTaken).toBe(nameTaken);
    expect(nextBucketPosition).toBe(nextPosition);
    expect(sortBuckets(ROWS)).toEqual(sortByPosition(ROWS));
    expect(moveBucket(ROWS, "c", "up")).toEqual(movedByPosition(ROWS, "c", "up"));
    const items: TemplateItem[] = ROWS.map((r) => ({ ...r, stageId: "s", text: r.id, estMinutes: 5 }));
    expect(sortTemplates(items)).toEqual(sortByPosition(items));
    expect(moveTemplate(items, "c", "up")).toEqual(movedByPosition(items, "c", "up"));
  });

  it("accepts only an exact permutation", () => {
    expect(isPermutationOf(["a", "b", "c"], ROWS)).toBe(true);
    expect(isPermutationOf(["a", "b"], ROWS)).toBe(false);
    expect(isPermutationOf(["a", "a", "c"], ROWS)).toBe(false);
  });
});
