import { describe, expect, it } from "vitest";

import { buildManualPrompt } from "./manual";
import {
  createPastedProvider,
  MAX_REPLY_LENGTH,
  parseCritiqueReply,
  parseSuggestionsReply,
  PROMPT_PASTED,
} from "./reply";
import {
  conceptsRequest,
  critiqueRequest,
  hooksRequest,
  titlesRequest,
} from "./test-fixtures";
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

/* -------------------------------------------------------------------------- */
/* M11's adversarial review                                                    */
/* -------------------------------------------------------------------------- */

describe("the prompt pasted back instead of the reply (review, finding 4)", () => {
  const requests = {
    titles: () => titlesRequest(),
    concepts: () => conceptsRequest(),
    hooks: () => hooksRequest(),
    thumbnail_critique: () => critiqueRequest(),
  } as const;

  for (const [kind, make] of Object.entries(requests)) {
    it(`is refused for ${kind}, saying it is the prompt, and nothing is read`, async () => {
      const request = make();
      const error = await createPastedProvider(buildManualPrompt(request))
        .run(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AssistError);
      expect((error as AssistError).code).toBe("wrong_shape");
      expect((error as AssistError).message).toBe(PROMPT_PASTED);
    });
  }

  it("never reads the prompt's example lines as proposals, even cut out of it", () => {
    expect(() =>
      parseSuggestionsReply(
        "titles",
        "```\n1. <the title> || <one sentence: why it works>\n2. <the title> || <one sentence: why it works>\nPICK: <the number of the strongest> || <one sentence: why it beats the others>\n```",
      ),
    ).toThrow(AssistError);
  });

  it("never reads 'yes or no' as a verdict", () => {
    expect(() =>
      parseCritiqueReply("WILD CARD — reads: yes or no, adds: yes or no. <one or two sentences to act on>"),
    ).toThrow(AssistError);
  });
});

describe("titles that start like a pick (review, findings 7 and 21)", () => {
  it("keeps 'Best:', 'Winner —' and 'Choice:' titles, and reads the real PICK", () => {
    const { payload } = parseSuggestionsReply(
      "titles",
      "1. Best: The $5 Tent vs the $500 Tent || Contrast.\n2. Winner — My Ten Year Old Laptop || Ironic.\n3. Six Edits on a 2015 MacBook || Concrete number.\n4. Choice: Film It or Skip It || A dilemma.\nPICK: 3 || Most concrete.",
    );
    expect(payload.suggestions.map((s) => s.text)).toEqual([
      "Best: The $5 Tent vs the $500 Tent",
      "Winner — My Ten Year Old Laptop",
      "Six Edits on a 2015 MacBook",
      "Choice: Film It or Skip It",
    ]);
    expect(payload.recommended_index).toBe(2);
    expect(payload.recommended_reason).toBe("Most concrete.");
  });

  it("keeps a listed 'Pick:' title and the unlisted PICK line wins", () => {
    const { payload } = parseSuggestionsReply(
      "titles",
      "1. Winner: the $50 mic beat my $400 one || contrast\n2. Best - budget mic of 2026 || search term\n3. Plain title || fine\nPICK: 3 || simplest",
    );
    expect(payload.suggestions).toHaveLength(3);
    expect(payload.recommended_index).toBe(2);
    expect(payload.recommended_reason).toBe("simplest");
  });

  it("prefers the last pick-shaped line", () => {
    const { payload } = parseSuggestionsReply(
      "titles",
      "My pick: see the end.\n1. One || a\n2. Two || b\nPICK: 2 || the one",
    );
    expect(payload.recommended_index).toBe(1);
  });
});

describe("hooks across more than one line (review, finding 10)", () => {
  it("joins a quoted hook written over two lines", () => {
    const { payload } = parseSuggestionsReply(
      "hooks",
      '1. "I edited six videos on a laptop from 2015.\nThe machine was fine. I wasn\'t." || Concrete.\n2. Forty-minute renders. One setting fixed it. || Number.',
    );
    expect(payload.suggestions.map((s) => s.text)).toEqual([
      "I edited six videos on a laptop from 2015. The machine was fine. I wasn't.",
      "Forty-minute renders. One setting fixed it.",
    ]);
    expect(payload.suggestions[0].rationale).toBe("Concrete.");
  });

  it("joins a reason that wrapped onto the next line", () => {
    const { payload } = parseSuggestionsReply(
      "hooks",
      "1. I edited six videos on a laptop from 2015. The machine was fine.\n   || Concrete.\n2. Forty-minute renders. One setting fixed it. || Number.",
    );
    expect(payload.suggestions.map((s) => s.text)).toEqual([
      "I edited six videos on a laptop from 2015. The machine was fine.",
      "Forty-minute renders. One setting fixed it.",
    ]);
  });
});

describe("prose around the list that mentions the separator (review, finding 11)", () => {
  it("does not read a preamble quoting the format", () => {
    expect(
      texts(
        "Here are 20 titles in the format you asked for (`1. title || why`):\n\n1. The Laptop Was Never the Problem || Reversal.\n2. Proxy Files Saved My MacBook || Names the trick.",
      ),
    ).toEqual(["The Laptop Was Never the Problem", "Proxy Files Saved My MacBook"]);
  });

  it("reads only numbered lines when the answer is numbered", () => {
    expect(
      texts(
        "1. The Laptop Was Never the Problem || Reversal.\n2. Proxy Files Saved My MacBook || Names the trick.\n\n- I kept them under 55 characters || mostly",
      ),
    ).toEqual(["The Laptop Was Never the Problem", "Proxy Files Saved My MacBook"]);
  });
});

describe("claude.ai's italic reason label (review, finding 12)", () => {
  it("is not kept in the rationale", () => {
    const { payload } = parseSuggestionsReply(
      "hooks",
      '**1.** "I edited six videos on a laptop from 2015."\n*Why it works:* Concrete and self-deprecating.\n\n**2.** "Forty-minute renders."\n_Why it works:_ Leads with a number.',
    );
    expect(payload.suggestions.map((s) => s.rationale)).toEqual([
      "Concrete and self-deprecating.",
      "Leads with a number.",
    ]);
  });
});

describe("reasons nested as bullets under each item (review, finding 20)", () => {
  it("attaches the bullet to the item above it", () => {
    const { payload } = parseSuggestionsReply(
      "titles",
      "1. I Tried Every Budget Mic\n   - Why: curiosity gap\n2. The $50 Mic That Won\n   - Why: price anchor\n\nPICK: 2 || it has a number",
    );
    expect(payload.suggestions).toEqual([
      { text: "I Tried Every Budget Mic", rationale: "curiosity gap" },
      { text: "The $50 Mic That Won", rationale: "price anchor" },
    ]);
    expect(payload.recommended_index).toBe(1);
  });

  it("still reads a plain bulleted list as proposals", () => {
    expect(texts("- One title - a\n- Another title - b")).toEqual(["One title", "Another title"]);
  });
});
