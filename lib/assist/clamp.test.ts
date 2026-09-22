import { describe, expect, it } from "vitest";

import { MAX_CANDIDATE_NOTE_LENGTH, MAX_TITLE_LENGTH } from "@/lib/packaging";
import { sameLabel } from "@/lib/text";

import {
  assemble,
  clampCritique,
  clampSuggestions,
  comparisonKey,
  wantedFor,
  TITLES_WANT,
} from "./clamp";
import { critiqueRequest, hooksRequest, titlesRequest } from "./test-fixtures";
import type { CritiquePayload, SuggestionsPayload } from "./schema";
import { AssistError, type SuggestionsResult } from "./types";

/**
 * The clamp is where PLAN.md's "a 21-title answer is CLAMPED, not discarded"
 * either happens or does not, so these are the tests that say what this module
 * is for: nothing good is thrown away over a number.
 */

function payload(
  texts: readonly string[],
  recommended = 0,
): SuggestionsPayload {
  return {
    suggestions: texts.map((text, index) => ({
      text,
      rationale: `Reason ${index}`,
    })),
    recommended_index: recommended,
  };
}

const numbered = (count: number, prefix = "Title") =>
  Array.from({ length: count }, (_unused, index) => `${prefix} ${index + 1}`);

describe("wantedFor", () => {
  it("asks for twenty titles, the top of BRIEF.md's 10–20 range", () => {
    expect(wantedFor(titlesRequest())).toBe(TITLES_WANT);
  });

  it("asks only for the hooks that are missing", () => {
    expect(wantedFor(hooksRequest({ existing: [] }))).toBe(3);
    expect(wantedFor(hooksRequest({ existing: ["one", "two"] }))).toBe(1);
  });

  it("never asks for none, even when the hooks list is already full", () => {
    expect(wantedFor(hooksRequest({ existing: ["a", "b", "c"] }))).toBe(1);
  });

  it("holds a caller's override to the same cap", () => {
    expect(wantedFor(titlesRequest({ want: 200 }))).toBe(TITLES_WANT);
    expect(wantedFor(titlesRequest({ want: 5 }))).toBe(5);
    expect(wantedFor(titlesRequest({ want: 0 }))).toBe(1);
  });

  it("asks for one critique per image", () => {
    expect(wantedFor(critiqueRequest(["wild_card", "safe"]))).toBe(2);
  });
});

describe("clampSuggestions", () => {
  it("keeps twenty of twenty-one and says that it did", () => {
    const clamped = clampSuggestions("titles", payload(numbered(21)));

    expect(clamped.suggestions).toHaveLength(20);
    expect(clamped.suggestions[0].text).toBe("Title 1");
    expect(clamped.suggestions[19].text).toBe("Title 20");
    expect(clamped.report.returned).toBe(21);
    expect(clamped.report.droppedOverflow).toBe(1);
    expect(clamped.report.droppedDuplicates).toBe(0);
    expect(clamped.report.droppedUnusable).toBe(0);
  });

  it("keeps everything when the answer arrives as asked for", () => {
    const clamped = clampSuggestions("titles", payload(numbered(20)));

    expect(clamped.suggestions).toHaveLength(20);
    expect(clamped.report.droppedOverflow).toBe(0);
    expect(clamped.report.recommendationAdjusted).toBe(false);
  });

  it("drops what cannot be stored, and only that", () => {
    const clamped = clampSuggestions(
      "titles",
      payload([
        "A real title",
        "   ",
        "​​",
        "x".repeat(MAX_TITLE_LENGTH + 1),
        "Another real title",
      ]),
    );

    expect(clamped.suggestions.map((s) => s.text)).toEqual([
      "A real title",
      "Another real title",
    ]);
    expect(clamped.report.droppedUnusable).toBe(3);
  });

  it("drops what the video already has", () => {
    const clamped = clampSuggestions(
      "titles",
      payload(["Already mine", "Brand new"]),
      ["  already   MINE "],
    );

    expect(clamped.suggestions.map((s) => s.text)).toEqual(["Brand new"]);
    expect(clamped.report.droppedDuplicates).toBe(1);
  });

  it("drops what the answer repeats to itself", () => {
    const clamped = clampSuggestions(
      "titles",
      payload(["Same thing", "same thing", "Different"]),
    );

    expect(clamped.suggestions).toHaveLength(2);
    expect(clamped.report.droppedDuplicates).toBe(1);
  });

  it("follows the recommendation when its title survives", () => {
    const clamped = clampSuggestions("titles", payload(numbered(21), 5));

    expect(clamped.recommended).toBe(5);
    expect(clamped.suggestions[clamped.recommended!].text).toBe("Title 6");
    expect(clamped.report.recommendationAdjusted).toBe(false);
  });

  it("re-points a recommendation whose title was dropped, and says so", () => {
    // Index 1 is the blank, which does not survive.
    const clamped = clampSuggestions(
      "titles",
      payload(["Kept", "  ", "Also kept"], 1),
    );

    expect(clamped.recommended).toBe(0);
    expect(clamped.report.recommendationAdjusted).toBe(true);
  });

  it("re-points a recommendation that was never in range", () => {
    for (const index of [25, -3, Number.NaN]) {
      const clamped = clampSuggestions("titles", payload(numbered(5), index));
      expect(clamped.recommended).toBe(0);
      expect(clamped.report.recommendationAdjusted).toBe(true);
    }
  });

  it("recommends nothing when nothing survived", () => {
    const clamped = clampSuggestions("titles", payload(["   ", ""]));

    expect(clamped.suggestions).toEqual([]);
    expect(clamped.recommended).toBeNull();
  });

  it("tidies rather than rejects: newlines and padding are not new titles", () => {
    const clamped = clampSuggestions(
      "titles",
      payload(["  A title\n   with a newline  "]),
    );

    expect(clamped.suggestions[0].text).toBe("A title with a newline");
  });

  it("cuts a rationale to the note column rather than losing the suggestion", () => {
    const long = "word ".repeat(200);
    const clamped = clampSuggestions("titles", {
      suggestions: [{ text: "A title", rationale: long }],
      recommended_index: 0,
    });

    expect(clamped.suggestions).toHaveLength(1);
    expect(clamped.suggestions[0].rationale.length).toBeLessThanOrEqual(
      MAX_CANDIDATE_NOTE_LENGTH,
    );
    expect(clamped.suggestions[0].rationale.endsWith("…")).toBe(true);
  });

  it("holds hooks to the three the column can store", () => {
    const clamped = clampSuggestions("hooks", payload(numbered(5, "Hook")));

    expect(clamped.suggestions).toHaveLength(3);
    expect(clamped.report.droppedOverflow).toBe(2);
  });
});

describe("comparisonKey", () => {
  it("agrees with lib/text's sameLabel, which is the app's one rule", () => {
    const pairs: [string, string][] = [
      ["Money", "  money  "],
      ["Money", "Mone​y"],
      ["Money", "Monkey"],
      ["", "   "],
    ];

    for (const [a, b] of pairs) {
      expect(comparisonKey(a) === comparisonKey(b)).toBe(sameLabel(a, b));
    }
  });
});

describe("clampCritique", () => {
  const verdict = (role: string, note = "Fine.") => ({
    role,
    reads_at_tile_size: true,
    complements_title: true,
    note,
  });

  it("drops verdicts about images nobody uploaded", () => {
    const payloadIn: CritiquePayload = {
      verdicts: [verdict("wild_card"), verdict("chaotic"), verdict("safe")],
      recommended_role: "safe",
    };

    const clamped = clampCritique(payloadIn, ["wild_card", "safe"]);

    expect(clamped.verdicts.map((v) => v.role)).toEqual(["wild_card", "safe"]);
    expect(clamped.report.droppedUnusable).toBe(1);
    expect(clamped.recommendedRole).toBe("safe");
  });

  it("orders verdicts the way the section shows the variants", () => {
    const payloadIn: CritiquePayload = {
      verdicts: [verdict("safe"), verdict("wild_card"), verdict("moderate")],
      recommended_role: "",
    };

    const clamped = clampCritique(payloadIn, ["wild_card", "moderate", "safe"]);

    expect(clamped.verdicts.map((v) => v.role)).toEqual([
      "wild_card",
      "moderate",
      "safe",
    ]);
  });

  it("refuses to recommend a role it did not judge, and says the pick moved", () => {
    const payloadIn: CritiquePayload = {
      verdicts: [verdict("safe")],
      recommended_role: "wild_card",
    };

    const clamped = clampCritique(payloadIn, ["safe"]);

    expect(clamped.recommendedRole).toBeNull();
    expect(clamped.report.recommendationAdjusted).toBe(true);
  });
});

describe("assemble", () => {
  const context = {
    provider: "fake" as const,
    model: "fixtures",
    elapsedMs: 1_000,
    servedByFallback: false,
  };

  it("carries the counts into the metadata the panel reads", () => {
    const result = assemble(
      titlesRequest(),
      payload(numbered(21)),
      context,
    ) as SuggestionsResult;

    expect(result.kind).toBe("titles");
    expect(result.meta.requested).toBe(20);
    expect(result.meta.returned).toBe(21);
    expect(result.meta.droppedOverflow).toBe(1);
    expect(result.meta.provider).toBe("fake");
    expect(result.meta.elapsedMs).toBe(1_000);
  });

  it("calls an answer with nothing in it empty rather than a success", () => {
    expect(() => assemble(titlesRequest(), payload([]), context)).toThrowError(
      AssistError,
    );
    try {
      assemble(titlesRequest(), payload([]), context);
    } catch (error) {
      expect((error as AssistError).code).toBe("empty");
    }
  });

  it("does not call a fully de-duplicated answer empty — nothing was wrong with it", () => {
    const result = assemble(
      titlesRequest({ existing: ["Title 1"] }),
      payload(["Title 1"]),
      context,
    ) as SuggestionsResult;

    expect(result.suggestions).toEqual([]);
    expect(result.meta.droppedDuplicates).toBe(1);
    expect(result.recommended).toBeNull();
  });
});
