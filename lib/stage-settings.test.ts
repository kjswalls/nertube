import { describe, expect, it } from "vitest";

import { SEED_STAGES } from "./defaults";
import {
  StageNameSchema,
  canMove,
  coreOrderHolds,
  moved,
  nameTaken,
  occupiedHref,
  occupiedSentence,
  readCoreOrderRefusal,
  readOccupied,
  type OrderedStage,
} from "./stage-settings";

/** The nine seeded stages as the settings screen sees them. */
const CORE: OrderedStage[] = SEED_STAGES.map((stage) => ({
  id: stage.kind,
  name: stage.name,
  kind: stage.kind,
}));

const INERT: OrderedStage = { id: "sponsor", name: "Sponsor review", kind: null };

function at(stages: readonly OrderedStage[], id: string): number {
  return stages.findIndex((stage) => stage.id === id);
}

describe("coreOrderHolds", () => {
  it("holds for the seed order, with or without inert stages between", () => {
    expect(coreOrderHolds(CORE)).toBe(true);
    const withInert = [...CORE.slice(0, 4), INERT, ...CORE.slice(4)];
    expect(coreOrderHolds(withInert)).toBe(true);
    expect(coreOrderHolds([INERT, ...CORE])).toBe(true);
    expect(coreOrderHolds([...CORE, INERT])).toBe(true);
  });

  it("fails the moment two core stages are swapped", () => {
    const swapped = moved(CORE, at(CORE, "filming"), "down")!;
    expect(coreOrderHolds(swapped)).toBe(false);
  });

  it("is true of an empty list and a list of only inert stages", () => {
    expect(coreOrderHolds([])).toBe(true);
    expect(coreOrderHolds([INERT, { ...INERT, id: "legal" }])).toBe(true);
  });
});

describe("moved", () => {
  it("swaps with the neighbour and leaves the input alone", () => {
    const next = moved(CORE, 1, "up")!;
    expect(next.map((s) => s.id).slice(0, 3)).toEqual(["packaging", "idea", "scripting"]);
    expect(CORE[0].id).toBe("idea");
  });

  it("is null at either end and out of range", () => {
    expect(moved(CORE, 0, "up")).toBeNull();
    expect(moved(CORE, CORE.length - 1, "down")).toBeNull();
    expect(moved(CORE, -1, "down")).toBeNull();
    expect(moved(CORE, 99, "up")).toBeNull();
  });
});

describe("canMove", () => {
  it("never offers a core stage a step across another core stage", () => {
    for (let index = 0; index < CORE.length; index += 1) {
      const up = canMove(CORE, index, "up");
      const down = canMove(CORE, index, "down");
      expect(up.ok).toBe(false);
      expect(down.ok).toBe(false);
    }
  });

  it("names the pair in the order they keep", () => {
    const verdict = canMove(CORE, at(CORE, "editing"), "up");
    expect(verdict).toEqual({
      ok: false,
      reason: "Core stages keep their order: Filming stays before Editing.",
    });
    // Same pair, asked from the other side: same sentence.
    expect(canMove(CORE, at(CORE, "filming"), "down")).toEqual(verdict);
  });

  it("says first/last rather than inventing a crossing at the ends", () => {
    expect(canMove(CORE, 0, "up")).toEqual({ ok: false, reason: "Idea is already first." });
    expect(canMove(CORE, CORE.length - 1, "down")).toEqual({
      ok: false,
      reason: "Repurposed is already last.",
    });
  });

  it("lets an inert stage move freely between core stages", () => {
    let stages = [...CORE, INERT];
    // Walk it from the end to the front, one step at a time.
    for (let index = stages.length - 1; index > 0; index -= 1) {
      expect(canMove(stages, index, "up")).toEqual({ ok: true });
      stages = moved(stages, index, "up")!;
    }
    expect(stages[0].id).toBe("sponsor");
    expect(coreOrderHolds(stages)).toBe(true);
  });

  it("lets a core stage step over an inert one — the core order is unchanged", () => {
    const stages = [...CORE.slice(0, 4), INERT, ...CORE.slice(4)];
    expect(canMove(stages, at(stages, "filming"), "down")).toEqual({ ok: true });
    expect(canMove(stages, at(stages, "editing"), "up")).toEqual({ ok: true });
    // ...but not over the inert one AND the core one beyond it: one step only.
    const after = moved(stages, at(stages, "editing"), "up")!;
    expect(canMove(after, at(after, "editing"), "up").ok).toBe(false);
  });

  it("judges the result, so a broken order can be repaired one step at a time", () => {
    // Editing before Filming: a state settings never offers but a hand-edited
    // database can hold. The step that fixes it is allowed; the step that
    // makes it worse is not.
    const broken = moved(CORE, at(CORE, "filming"), "down")!;
    expect(coreOrderHolds(broken)).toBe(false);
    expect(canMove(broken, at(broken, "filming"), "up")).toEqual({ ok: true });
    expect(canMove(broken, at(broken, "filming"), "down").ok).toBe(false);
  });

  it("refuses an index that is not in the list", () => {
    expect(canMove(CORE, 42, "up").ok).toBe(false);
  });
});

describe("the name", () => {
  it("trims, and refuses blank or over-long names", () => {
    expect(StageNameSchema.parse("  Packaging & hook ")).toBe("Packaging & hook");
    expect(StageNameSchema.safeParse("   ").success).toBe(false);
    expect(StageNameSchema.safeParse("x".repeat(41)).success).toBe(false);
    expect(StageNameSchema.safeParse("x".repeat(40)).success).toBe(true);
  });

  it("treats a name as taken whatever its case or padding", () => {
    expect(nameTaken("editing", CORE)).toBe(true);
    expect(nameTaken(" EDITING ", CORE)).toBe(true);
    expect(nameTaken("Sponsor review", CORE)).toBe(false);
  });
});

describe("the refusals", () => {
  it("reads the count out of the function's message, and nothing out of anything else", () => {
    expect(readOccupied("occupied:3")).toBe(3);
    expect(readOccupied("P0001: occupied:12")).toBe(12);
    expect(readOccupied("stage x not found for this user")).toBeNull();
  });

  it("turns the order refusal into the same sentence the screen uses", () => {
    expect(readCoreOrderRefusal("core order: Filming cannot come before Editing")).toBe(
      "Core stages keep their order: Filming cannot come before Editing.",
    );
    expect(readCoreOrderRefusal("order:incomplete: 9 ids for 10 stages")).toBeNull();
  });

  it("counts in words and points at the right view", () => {
    expect(occupiedSentence("Scripting", 1)).toMatch(/^Scripting still holds a video\. Move it on/);
    expect(occupiedSentence("Scripting", 4)).toMatch(/^Scripting still holds 4 videos\. Move them on/);
    expect(occupiedHref("idea", "personal")).toBe("/c/personal/ideas");
    expect(occupiedHref("filming", "personal")).toBe("/c/personal/board");
    expect(occupiedHref(null, "personal")).toBe("/c/personal/board");
  });
});
