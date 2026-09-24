import { describe, expect, it } from "vitest";

import {
  createPastedProvider,
  MAX_REPLY_LENGTH,
  parseCritiqueReply,
  parseSuggestionsReply,
} from "./reply";
import { critiqueRequest, hooksRequest, titlesRequest } from "./test-fixtures";
import { AssistError, MANUAL_PROVIDER, type SuggestionsResult } from "./types";

/**
 * The reader for a reply the person pasted back from claude.ai (M11).
 *
 * The prompt asks for `1. text || why` and `PICK: n || why`. What these hold
 * it to is the forgiving half: what people and models actually send back —
 * fenced, bolded, numbered differently, wrapped in chatter — still reads, and
 * what is not an answer at all is refused with a sentence rather than thrown.
 */

const WELL_FORMED = `1. The ten-year-old laptop that still edits my videos || Sells the result and the surprise in one line.
2. I stopped upgrading and my edits got faster || A reversal the viewer wants explained.
3. Proxy files saved this MacBook || Concrete and specific, names the trick.
PICK: 2 || It is the only one that makes a claim the viewer can doubt.`;

function texts(reply: string) {
  return parseSuggestionsReply("titles", reply).payload.suggestions.map((s) => s.text);
}

describe("a well-formed reply", () => {
  it("reads every line, its reason and the pick", () => {
    const { payload, picked } = parseSuggestionsReply("titles", WELL_FORMED);

    expect(payload.suggestions).toHaveLength(3);
    expect(payload.suggestions[0]).toEqual({
      text: "The ten-year-old laptop that still edits my videos",
      rationale: "Sells the result and the surprise in one line.",
    });
    expect(payload.recommended_index).toBe(1);
    expect(payload.recommended_reason).toBe(
      "It is the only one that makes a claim the viewer can doubt.",
    );
    expect(picked).toBe(true);
  });

  it("reads the lines without numbers, too", () => {
    expect(texts("First title || one\nSecond title || two")).toEqual([
      "First title",
      "Second title",
    ]);
  });

  it("resolves a pick by the number a line was given, not only its position", () => {
    const { payload } = parseSuggestionsReply(
      "titles",
      "1. One || a\n2. Two || b\n4. Four || d\nPICK: 4 || the best",
    );
    expect(payload.recommended_index).toBe(2);
  });

  it("resolves a pick written as the text rather than a number", () => {
    const { payload } = parseSuggestionsReply(
      "titles",
      "1. One || a\n2. Two || b\nPick: Two",
    );
    expect(payload.recommended_index).toBe(1);
  });
});

describe("a markdown-wrapped reply", () => {
  it("reads through a code fence", () => {
    expect(texts("```\n1. Alpha || a\n2. Beta || b\nPICK: 1 || x\n```")).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("drops bold, quotation marks and blockquotes around the proposals", () => {
    const reply = `> 1. **“Alpha”** || why *alpha*
> 2. "Beta" || why beta
**PICK: 2** || **because**`;
    const { payload } = parseSuggestionsReply("titles", reply);
    expect(payload.suggestions.map((s) => s.text)).toEqual(["Alpha", "Beta"]);
    expect(payload.recommended_index).toBe(1);
    expect(payload.recommended_reason).toBe("because");
  });

  it("ignores headings", () => {
    expect(texts("## Titles\n\n1. Alpha || a\n\n## Pick\nPICK: 1 || x")).toEqual(["Alpha"]);
  });

  it("reads a markdown table when that is what came back", () => {
    const reply = `| # | Title | Why |
|---|---|---|
| 1 | Alpha | because a |
| 2 | Beta | because b |`;
    const { payload } = parseSuggestionsReply("titles", reply);
    expect(payload.suggestions).toEqual([
      { text: "Alpha", rationale: "because a" },
      { text: "Beta", rationale: "because b" },
    ]);
  });
});

describe("numbered lists that ignored the separator", () => {
  it("splits on a dash or a bar when there is no ||", () => {
    expect(
      parseSuggestionsReply(
        "titles",
        "1. Alpha — the reason\n2) Beta | another reason\n3. Gamma - a third",
      ).payload.suggestions,
    ).toEqual([
      { text: "Alpha", rationale: "the reason" },
      { text: "Beta", rationale: "another reason" },
      { text: "Gamma", rationale: "a third" },
    ]);
  });

  it("takes the reason from the line underneath", () => {
    const reply = `1. **Alpha**
   Why: it sells the result.

2. **Beta**
   Reason — a reversal.`;
    expect(parseSuggestionsReply("titles", reply).payload.suggestions).toEqual([
      { text: "Alpha", rationale: "it sells the result." },
      { text: "Beta", rationale: "a reversal." },
    ]);
  });

  it("keeps a proposal with no reason at all rather than refusing the list", () => {
    expect(parseSuggestionsReply("titles", "- Alpha\n- Beta").payload.suggestions).toEqual([
      { text: "Alpha", rationale: "" },
      { text: "Beta", rationale: "" },
    ]);
  });

  it("does not mistake a number inside a title for a list marker", () => {
    expect(texts("1. 3.5 hours of sleep || a")).toEqual(["3.5 hours of sleep"]);
  });
});

describe("chatter before and after", () => {
  it("is ignored", () => {
    const reply = `Sure! Here are twenty titles in your voice, based on the guide you shared.

${WELL_FORMED}

Want me to try a version that leans harder on the number?`;
    const { payload } = parseSuggestionsReply("titles", reply);
    expect(payload.suggestions).toHaveLength(3);
    expect(payload.recommended_index).toBe(1);
  });
});

describe("no pick", () => {
  it("is recorded as no pick, not as a dropped one", () => {
    const { payload, picked } = parseSuggestionsReply("titles", "1. Alpha || a\n2. Beta || b");
    expect(picked).toBe(false);
    expect(payload.recommended_index).toBe(-1);
    expect(payload.recommended_reason).toBeUndefined();
  });
});

describe("what is not an answer", () => {
  it("refuses an empty paste with a sentence, as an AssistError", () => {
    for (const blank of ["", "   \n\t ", "​⁠"]) {
      expect(() => parseSuggestionsReply("titles", blank)).toThrow(AssistError);
      try {
        parseSuggestionsReply("titles", blank);
      } catch (error) {
        expect((error as AssistError).code).toBe("empty");
        expect((error as AssistError).message).toContain("Paste Claude’s whole reply");
      }
    }
  });

  it("refuses garbage by saying what it expected", () => {
    const garbage = "I'm sorry, I can't help with that.\nlorem ipsum dolor sit amet";
    try {
      parseSuggestionsReply("titles", garbage);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssistError);
      expect((error as AssistError).code).toBe("wrong_shape");
      expect((error as AssistError).message).toContain("1. The title || why it works");
      expect((error as AssistError).message).toContain("PICK");
    }
  });

  it("names the kind it was reading in the refusal", () => {
    try {
      parseSuggestionsReply("hooks", "nothing here");
      expect.unreachable();
    } catch (error) {
      expect((error as AssistError).message).toContain("hooks");
    }
  });

  it("refuses something far longer than any answer", () => {
    try {
      parseSuggestionsReply("titles", `1. A || b\n${"x".repeat(MAX_REPLY_LENGTH)}`);
      expect.unreachable();
    } catch (error) {
      expect((error as AssistError).code).toBe("rejected");
    }
  });

  it("never throws anything but an AssistError, whatever it is handed", () => {
    const odd = ["||", "| | |", "PICK: 9", "```", "1.", "-", "\u0000\u0001", "💥".repeat(50)];
    for (const input of odd) {
      try {
        parseSuggestionsReply("titles", input);
      } catch (error) {
        expect(error).toBeInstanceOf(AssistError);
      }
      try {
        parseCritiqueReply(input);
      } catch (error) {
        expect(error).toBeInstanceOf(AssistError);
      }
    }
  });
});

describe("the critique", () => {
  const CRITIQUE = `WILD CARD || reads: no || adds: yes || The face is lost at this size; crop tighter.
MODERATE || reads: yes || adds: yes || Strong. The prop reads first.
SAFE || reads: yes || adds: no || It repeats the title word for word.
SHIP: moderate`;

  it("reads one verdict per role and the one to ship", () => {
    const payload = parseCritiqueReply(CRITIQUE);
    expect(payload.verdicts).toEqual([
      {
        role: "wild_card",
        reads_at_tile_size: false,
        complements_title: true,
        note: "The face is lost at this size; crop tighter.",
      },
      {
        role: "moderate",
        reads_at_tile_size: true,
        complements_title: true,
        note: "Strong. The prop reads first.",
      },
      {
        role: "safe",
        reads_at_tile_size: true,
        complements_title: false,
        note: "It repeats the title word for word.",
      },
    ]);
    expect(payload.recommended_role).toBe("moderate");
  });

  it("reads bare yes/no in order, headings with bullets, and SHIP: none", () => {
    const payload = parseCritiqueReply(`Here is my take.

### Wild card
- Reads at tile size: yes
- Adds to the title: no
- Note: Too busy behind you.

**Safe** | yes | yes | Clean and legible.

SHIP: none — neither is ready`);
    expect(payload.verdicts.map((v) => [v.role, v.reads_at_tile_size, v.complements_title])).toEqual([
      ["wild_card", true, false],
      ["safe", true, true],
    ]);
    expect(payload.verdicts[0].note).toBe("Too busy behind you.");
    expect(payload.recommended_role).toBe("");
  });

  it("reads a table", () => {
    const payload = parseCritiqueReply(`| Image | Reads | Adds | Note |
|---|---|---|---|
| Wild card | no | no | Muddy. |
| Moderate | yes | yes | Good. |

I would ship: Moderate.`);
    expect(payload.verdicts).toHaveLength(2);
    expect(payload.recommended_role).toBe("moderate");
  });

  it("refuses a role line that leaves either question unanswered", () => {
    try {
      parseCritiqueReply("Safe to say these are all fine.\nMODERATE || looks nice");
      expect.unreachable();
    } catch (error) {
      expect((error as AssistError).code).toBe("wrong_shape");
      expect((error as AssistError).message).toContain("WILD CARD || reads: yes");
    }
  });
});

describe("createPastedProvider", () => {
  it("runs the paste through the same clamp as a model's answer", async () => {
    const provider = createPastedProvider(
      `1. Already mine || dup\n2.   Fresh   one  || new\n3. ${"x".repeat(400)} || too long\nPICK: 2 || best`,
    );
    const result = (await provider.run(
      titlesRequest({ existing: ["already MINE"] }),
    )) as SuggestionsResult;

    expect(provider.name).toBe(MANUAL_PROVIDER);
    expect(result.suggestions.map((s) => s.text)).toEqual(["Fresh one"]);
    expect(result.recommended).toBe(0);
    expect(result.recommendedReason).toBe("best");
    expect(result.meta).toMatchObject({
      provider: MANUAL_PROVIDER,
      model: "claude.ai",
      returned: 3,
      droppedDuplicates: 1,
      droppedUnusable: 1,
      recommendationAdjusted: false,
    });
  });

  it("caps twenty-three titles at twenty, and says so in the meta", async () => {
    const reply = Array.from({ length: 23 }, (_u, i) => `${i + 1}. Title number ${i + 1} || r`).join(
      "\n",
    );
    const result = (await createPastedProvider(reply).run(titlesRequest())) as SuggestionsResult;
    expect(result.suggestions).toHaveLength(20);
    expect(result.meta.droppedOverflow).toBe(3);
  });

  it("marks nothing when the reply named no pick", async () => {
    const result = (await createPastedProvider("1. A || a\n2. B || b").run(
      hooksRequest(),
    )) as SuggestionsResult;
    expect(result.recommended).toBeNull();
    expect(result.recommendedReason).toBeNull();
    expect(result.meta.recommendationAdjusted).toBe(false);
  });

  it("refuses a paste that is entirely repeats, as the API path does", async () => {
    await expect(
      createPastedProvider("1. Mine || a").run(titlesRequest({ existing: ["Mine"] })),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("holds a critique to the images that exist", async () => {
    const result = await createPastedProvider(
      "WILD CARD || reads: yes || adds: yes || a\nSAFE || reads: yes || adds: no || b\nSHIP: safe",
    ).run(critiqueRequest(["wild_card", "moderate"]));
    expect(result.kind).toBe("thumbnail_critique");
    if (result.kind !== "thumbnail_critique") return;
    expect(result.verdicts.map((v) => v.role)).toEqual(["wild_card"]);
    expect(result.recommendedRole).toBeNull();
    expect(result.meta.droppedUnusable).toBe(1);
  });
});
