import { describe, expect, it } from "vitest";

import { parseModelText, payloadSchemaFor, SuggestionsPayload } from "./schema";
import { AssistError } from "./types";

/**
 * The schema's job is to answer one question — *is this the right shape* — and
 * to refuse to answer any other. These tests are as much about what it does
 * not reject as about what it does.
 */

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof AssistError ? error.code : `not-an-AssistError`;
  }
  return "no-error";
}

const suggestion = (text: string) => ({ text, rationale: "Because." });

describe("structural validation", () => {
  it("accepts more suggestions than were asked for — the count is not its business", () => {
    const twentyOne = {
      suggestions: Array.from({ length: 21 }, (_u, i) => suggestion(`T${i}`)),
      recommended_index: 0,
    };

    expect(SuggestionsPayload.safeParse(twentyOne).success).toBe(true);
  });

  it("accepts an out-of-range recommendation — the clamp repairs that", () => {
    expect(
      SuggestionsPayload.safeParse({
        suggestions: [suggestion("One")],
        recommended_index: 99,
      }).success,
    ).toBe(true);
  });

  it("accepts an empty list — `assemble` is what calls that empty", () => {
    expect(
      SuggestionsPayload.safeParse({ suggestions: [], recommended_index: 0 })
        .success,
    ).toBe(true);
  });

  it("rejects a missing field, a renamed field and the wrong container", () => {
    const wrong: unknown[] = [
      { suggestions: [{ text: "No reason given" }], recommended_index: 0 },
      {
        suggestions: [{ title: "Renamed", rationale: "x" }],
        recommended_index: 0,
      },
      { suggestions: [suggestion("One")] },
      [suggestion("A bare array")],
      "a string",
      null,
    ];

    for (const value of wrong) {
      expect(SuggestionsPayload.safeParse(value).success).toBe(false);
    }
  });

  it("gives the critique its own schema", () => {
    expect(payloadSchemaFor("thumbnail_critique")).not.toBe(
      payloadSchemaFor("titles"),
    );
    expect(payloadSchemaFor("hooks")).toBe(payloadSchemaFor("concepts"));
  });
});

describe("parseModelText", () => {
  it("reads a well-formed answer", () => {
    const parsed = parseModelText(
      "titles",
      JSON.stringify({
        suggestions: [suggestion("A title")],
        recommended_index: 0,
      }),
    );

    expect("suggestions" in parsed && parsed.suggestions[0].text).toBe(
      "A title",
    );
  });

  it("calls a body that is not JSON malformed", () => {
    expect(codeOf(() => parseModelText("titles", "I'm sorry, but I can't."))).toBe(
      "malformed",
    );
    // A markdown fence is the most common version of this in practice.
    expect(
      codeOf(() => parseModelText("titles", '```json\n{"suggestions": []}\n```')),
    ).toBe("malformed");
  });

  it("calls JSON of the wrong shape wrong_shape, which is a different bug", () => {
    expect(
      codeOf(() =>
        parseModelText("titles", JSON.stringify({ titles: ["One", "Two"] })),
      ),
    ).toBe("wrong_shape");
  });

  it("keeps an excerpt of what was actually said, for the log", () => {
    try {
      parseModelText("titles", "Not JSON at all");
    } catch (error) {
      expect((error as AssistError).detail).toContain("Not JSON at all");
    }
  });

  it("never lets the excerpt grow without bound", () => {
    try {
      parseModelText("titles", "x".repeat(10_000));
    } catch (error) {
      expect((error as AssistError).detail!.length).toBeLessThan(400);
    }
  });

  it("validates a critique against the critique schema", () => {
    expect(
      codeOf(() =>
        parseModelText(
          "thumbnail_critique",
          JSON.stringify({
            suggestions: [suggestion("wrong shape for this kind")],
            recommended_index: 0,
          }),
        ),
      ),
    ).toBe("wrong_shape");

    const ok = parseModelText(
      "thumbnail_critique",
      JSON.stringify({
        verdicts: [
          {
            role: "safe",
            reads_at_tile_size: true,
            complements_title: false,
            note: "Fine.",
          },
        ],
        recommended_role: "safe",
      }),
    );
    expect("verdicts" in ok && ok.verdicts).toHaveLength(1);
  });

  it("accepts a role it has never heard of — the clamp drops that verdict", () => {
    const parsed = parseModelText(
      "thumbnail_critique",
      JSON.stringify({
        verdicts: [
          {
            role: "chaotic_good",
            reads_at_tile_size: false,
            complements_title: false,
            note: "Invented role.",
          },
        ],
        recommended_role: "",
      }),
    );

    expect("verdicts" in parsed && parsed.verdicts[0].role).toBe("chaotic_good");
  });
});
