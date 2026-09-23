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
  recommendedReason = "It beats the others because it names a cost.",
): SuggestionsPayload {
  return {
    suggestions: texts.map((text, index) => ({
      text,
      rationale: `Reason ${index}`,
    })),
    recommended_index: recommended,
    recommended_reason: recommendedReason,
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

  it("refuses a recommendation the answer's own verdict calls illegible", () => {
    /*
      The review found the panel drawing "WOULD SHIP" on a card that said
      "Does not read at tile size" directly beneath it, over a button that
      writes a real `swap_thumbnail`. Nothing had ever checked the
      recommendation against the verdict it names. It is dropped and counted,
      the same repair as a recommendation naming a variant nobody uploaded.
    */
    const clamped = clampCritique(
      {
        verdicts: [
          { ...verdict("wild_card"), reads_at_tile_size: false },
          verdict("safe"),
        ],
        recommended_role: "wild_card",
      },
      ["wild_card", "safe"],
    );

    expect(clamped.recommendedRole).toBeNull();
    expect(clamped.report.recommendationAdjusted).toBe(true);
    // The verdicts themselves survive: the judgement was fine, the pick was not.
    expect(clamped.verdicts).toHaveLength(2);
  });

  it("keeps a recommendation its own verdict stands behind", () => {
    const clamped = clampCritique(
      { verdicts: [verdict("wild_card"), verdict("safe")], recommended_role: "safe" },
      ["wild_card", "safe"],
    );

    expect(clamped.recommendedRole).toBe("safe");
    expect(clamped.report.recommendationAdjusted).toBe(false);
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

  it("carries the comparison for the pick, and drops it when the pick moves", () => {
    /*
      The panel labels a sentence "Why it picked this one:", and until this
      field existed the sentence it labelled was the picked item's *own*
      rationale — which says why that one works, not why it beats the rest.
      Nothing in the schema or the prompt had ever asked why. Now that it is
      asked, it is also thrown away the moment it stops being about the thing
      on screen: a reason for a proposal that was dropped is a reason about
      something nobody can see.
    */
    const kept = assemble(
      titlesRequest(),
      payload(numbered(3), 1, "Only this one names a number."),
      context,
    ) as SuggestionsResult;
    expect(kept.recommended).toBe(1);
    expect(kept.recommendedReason).toBe("Only this one names a number.");

    const moved = assemble(
      titlesRequest({ existing: ["Title 2"] }),
      payload(numbered(3), 1, "Only this one names a number."),
      context,
    ) as SuggestionsResult;
    expect(moved.meta.recommendationAdjusted).toBe(true);
    expect(moved.recommendedReason).toBeNull();

    const silent = assemble(
      titlesRequest(),
      payload(numbered(3), 0, "   "),
      context,
    ) as SuggestionsResult;
    expect(silent.recommendedReason).toBeNull();
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

  /*
    This used to assert the opposite — that an answer the clamp empties is a
    success with no proposals in it, on the grounds that nothing was wrong with
    the answer. The M8 review showed what that cost. The panel drew "0
    proposals" over an empty list with no failure and no retry, after a call
    somebody waited for and paid for; and because `app/actions/assist.ts`
    writes on the success path, the empty entry replaced whatever
    `videos.brainstorm_last` was keeping — and an empty entry reads back as
    absent, so the twenty titles that were kept were gone. It is reached by the
    ordinary route: "Add all as candidates", then "Ask again".
  */
  it("calls an answer the clamp empties empty, so nothing overwrites what was kept", () => {
    const request = titlesRequest({ existing: ["Title 1", "Title 2"] });
    expect(() =>
      assemble(request, payload(["Title 1", "Title 2"]), context),
    ).toThrowError(AssistError);

    try {
      assemble(request, payload(["Title 1", "Title 2"]), context);
    } catch (error) {
      const failure = error as AssistError;
      expect(failure.code).toBe("empty");
      // Retryable, so the panel offers the button it already has.
      expect(failure.retryable).toBe(true);
      // And the sentence says *why* it was empty, rather than reusing the
      // generic "nothing came back" for an answer that was full.
      expect(failure.message).toContain("already on this video");
      expect(failure.detail).toContain("duplicates");
    }
  });

  it("calls an answer that is entirely unusable empty, with its own sentence", () => {
    try {
      assemble(titlesRequest(), payload(["   ", "\u200b"]), context);
      throw new Error("expected assemble to throw");
    } catch (error) {
      const failure = error as AssistError;
      expect(failure.code).toBe("empty");
      expect(failure.message).toContain("blank or too long");
    }
  });
});
