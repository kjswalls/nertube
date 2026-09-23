import { describe, expect, it } from "vitest";

import {
  GATE_WORDING,
  HookListSchema,
  HookSchema,
  MAX_CANDIDATES,
  MAX_HOOKS,
  MIN_SKIP_REASON_LENGTH,
  PG_BOOLEAN_STRINGS,
  SkipReasonSchema,
  TitleCandidateListSchema,
  describeGate,
  newId,
  packagingGate,
  readHooks,
  readTitleCandidates,
  type PackagingSnapshot,
} from "./packaging";

/**
 * The packaging schema is the only thing between the editor and two jsonb
 * columns that the database cannot fully constrain, and the gate predicate is
 * the only thing making the page's indicator agree with `move_video`. Both are
 * pure functions, so both are testable here — which is the point of putting
 * them in `lib/` rather than inside a component.
 *
 * The adversarial cases are the reason this file exists: two chosen hooks, a
 * fourth hook, blank text that is not empty, duplicate ids, and a gate field
 * that was filled and then cleared again.
 */

const candidate = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  text: "How I edit ten videos a week",
  chosen: false,
  source: "manual",
  ...over,
});

const hook = (over: Record<string, unknown> = {}) => ({
  id: "h1",
  text: "Most people give up in week three.",
  chosen: false,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

describe("HookListSchema", () => {
  it("accepts up to three hooks with exactly one chosen", () => {
    const parsed = HookListSchema.parse([
      hook({ id: "h1", chosen: true }),
      hook({ id: "h2", text: "Second" }),
      hook({ id: "h3", text: "Third" }),
    ]);
    expect(parsed).toHaveLength(MAX_HOOKS);
    expect(parsed.filter((h) => h.chosen)).toHaveLength(1);
  });

  it("refuses a fourth hook, the way the database CHECK would", () => {
    const result = HookListSchema.safeParse([
      hook({ id: "h1" }),
      hook({ id: "h2" }),
      hook({ id: "h3" }),
      hook({ id: "h4" }),
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/Three hooks is the limit/);
  });

  it("makes two chosen hooks impossible to save", () => {
    const result = HookListSchema.safeParse([
      hook({ id: "h1", chosen: true }),
      hook({ id: "h2", chosen: true }),
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toMatch(
      /Only one hook can be the chosen one/,
    );
  });

  it("refuses three chosen hooks and says how many are ticked", () => {
    const result = HookListSchema.safeParse([
      hook({ id: "h1", chosen: true }),
      hook({ id: "h2", chosen: true }),
      hook({ id: "h3", chosen: true }),
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/3 are ticked/);
  });

  it("refuses blank hook text, including text that is only whitespace", () => {
    expect(HookListSchema.safeParse([hook({ text: "" })]).success).toBe(false);
    expect(HookListSchema.safeParse([hook({ text: "   \n\t " })]).success).toBe(false);
  });

  it("trims hook text rather than storing the whitespace", () => {
    const [parsed] = HookListSchema.parse([hook({ text: "  Try this instead.  " })]);
    expect(parsed.text).toBe("Try this instead.");
  });

  it("refuses two hooks sharing one id", () => {
    const result = HookListSchema.safeParse([hook({ id: "h1" }), hook({ id: "h1", text: "Other" })]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/share the id/);
  });

  it("refuses a blank id and an id that is not a shape this app generates", () => {
    expect(HookListSchema.safeParse([hook({ id: "" })]).success).toBe(false);
    expect(HookListSchema.safeParse([hook({ id: "has space" })]).success).toBe(false);
    expect(HookListSchema.safeParse([hook({ id: "-leading-dash" })]).success).toBe(false);
  });

  it("accepts the ids the app actually generates", () => {
    expect(HookListSchema.safeParse([hook({ id: newId() })]).success).toBe(true);
  });

  it("defaults `chosen` rather than requiring it", () => {
    const parsed = HookSchema.parse({ id: "h1", text: "A hook" });
    expect(parsed.chosen).toBe(false);
  });

  it("drops keys the shape does not have", () => {
    const parsed = HookSchema.parse({
      id: "h1",
      text: "A hook",
      chosen: true,
      source: "ai",
      __proto__: { polluted: true },
      note: "not a hook field",
    });
    expect(Object.keys(parsed).sort()).toEqual(["chosen", "id", "text"]);
  });

  it("refuses anything that is not an array of objects", () => {
    expect(HookListSchema.safeParse({}).success).toBe(false);
    expect(HookListSchema.safeParse("[]").success).toBe(false);
    expect(HookListSchema.safeParse([null]).success).toBe(false);
    expect(HookListSchema.safeParse(["a hook"]).success).toBe(false);
  });

  it("accepts an empty list — no hooks yet is a normal state", () => {
    expect(HookListSchema.parse([])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Title candidates                                                            */
/* -------------------------------------------------------------------------- */

describe("TitleCandidateListSchema", () => {
  it("accepts the 10–20 the brief asks for", () => {
    const many = Array.from({ length: 20 }, (_, n) =>
      candidate({ id: `c${n}`, text: `Candidate ${n}` }),
    );
    expect(TitleCandidateListSchema.parse(many)).toHaveLength(20);
  });

  it("makes two chosen candidates impossible to save", () => {
    const result = TitleCandidateListSchema.safeParse([
      candidate({ id: "c1", chosen: true }),
      candidate({ id: "c2", text: "Another", chosen: true }),
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/Only one candidate can be the chosen one/);
  });

  it("refuses blank candidate text", () => {
    expect(TitleCandidateListSchema.safeParse([candidate({ text: "  " })]).success).toBe(false);
  });

  it("refuses duplicate ids", () => {
    const result = TitleCandidateListSchema.safeParse([
      candidate({ id: "same" }),
      candidate({ id: "same", text: "Other" }),
    ]);
    expect(result.success).toBe(false);
  });

  it("treats an empty note as no note at all", () => {
    const [parsed] = TitleCandidateListSchema.parse([candidate({ note: "   " })]);
    expect(parsed.note).toBeUndefined();
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty("note");
  });

  it("keeps and trims a real note", () => {
    const [parsed] = TitleCandidateListSchema.parse([candidate({ note: "  curiosity gap  " })]);
    expect(parsed.note).toBe("curiosity gap");
  });

  it("defaults the source to manual and keeps an AI one", () => {
    expect(TitleCandidateListSchema.parse([{ id: "c1", text: "A title" }])[0].source).toBe("manual");
    expect(
      TitleCandidateListSchema.parse([candidate({ source: "ai" })])[0].source,
    ).toBe("ai");
  });

  it("refuses a source it does not know", () => {
    expect(TitleCandidateListSchema.safeParse([candidate({ source: "scraped" })]).success).toBe(
      false,
    );
  });

  it(`refuses more than ${MAX_CANDIDATES} candidates`, () => {
    const tooMany = Array.from({ length: MAX_CANDIDATES + 1 }, (_, n) =>
      candidate({ id: `c${n}`, text: `Candidate ${n}` }),
    );
    expect(TitleCandidateListSchema.safeParse(tooMany).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The skip reason                                                             */
/* -------------------------------------------------------------------------- */

describe("SkipReasonSchema", () => {
  it("refuses an empty reason and a whitespace-only one", () => {
    expect(SkipReasonSchema.safeParse("").success).toBe(false);
    expect(SkipReasonSchema.safeParse("     ").success).toBe(false);
  });

  it("trims what it accepts, so the CHECK never sees a blank", () => {
    expect(SkipReasonSchema.parse("  sponsor deadline  ")).toBe("sponsor deadline");
  });

  it("refuses a reason that is not one", () => {
    // `packaging_skip_reason <> ''` is all the database can say, and a review
    // used it to skip the gate in four clicks and one keystroke by typing `x`.
    // The app's floor is higher on purpose: the asymmetry BRIEF.md principle 1
    // asks for only exists while a reason costs more than a keypress.
    expect(SkipReasonSchema.safeParse("x").success).toBe(false);
    expect(SkipReasonSchema.safeParse("no time").success).toBe(false);
    const refusal = SkipReasonSchema.safeParse("x");
    expect(refusal.success ? "" : refusal.error.issues[0].message).toContain(
      "not a reason yet",
    );
  });

  it("accepts a reason of MIN_SKIP_REASON_LENGTH characters, measured after trimming", () => {
    const shortest = "a".repeat(MIN_SKIP_REASON_LENGTH);
    expect(SkipReasonSchema.parse(`   ${shortest}   `)).toBe(shortest);
    expect(SkipReasonSchema.safeParse("a".repeat(MIN_SKIP_REASON_LENGTH - 1)).success).toBe(
      false,
    );
  });

  it("says the two mistakes apart", () => {
    const empty = SkipReasonSchema.safeParse("   ");
    expect(empty.success ? "" : empty.error.issues[0].message).toContain(
      "A reason is required",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("asChosen, through readHooks", () => {
  /*
    `move_video` reads this column with `(h ->> 'chosen')::boolean`, so the set
    of strings the browser calls "chosen" has to be the set Postgres calls true.
    The first version of the reader stopped at true/t/yes/on/1 and missed `y`,
    which meant a row holding `{"chosen":"y"}` read as *not* chosen in the
    indicator ("none is chosen yet") while the gate counted it and let the video
    straight past Packaging.

    These two lists are the output of, on PostgreSQL 16:
      select ('y')::boolean, ('ye')::boolean, ('tr')::boolean, ('fals')::boolean,
             ('n')::boolean, ('no')::boolean, ('off')::boolean, ('On')::boolean;
      -> t | t | t | f | f | f | f | t
  */
  it("accepts exactly what Postgres' boolean input accepts as true", () => {
    for (const text of PG_BOOLEAN_STRINGS.true) {
      expect(readHooks([{ id: "h", text: "x", chosen: text }])[0].chosen).toBe(true);
      expect(
        readHooks([{ id: "h", text: "x", chosen: text.toUpperCase() }])[0].chosen,
      ).toBe(true);
      expect(readHooks([{ id: "h", text: "x", chosen: `  ${text} ` }])[0].chosen).toBe(
        true,
      );
    }
  });

  it("reads everything Postgres calls false as false", () => {
    for (const text of PG_BOOLEAN_STRINGS.false) {
      expect(readHooks([{ id: "h", text: "x", chosen: text }])[0].chosen).toBe(false);
    }
  });

  it("covers the whole accepted set, including the prefixes", () => {
    expect(PG_BOOLEAN_STRINGS.true).toEqual([
      "t",
      "tr",
      "tru",
      "true",
      "y",
      "ye",
      "yes",
      "on",
      "1",
    ]);
    expect(PG_BOOLEAN_STRINGS.false).toEqual([
      "f",
      "fa",
      "fal",
      "fals",
      "false",
      "n",
      "no",
      "off",
      "0",
    ]);
  });

  it("reads a value Postgres cannot cast as not chosen", () => {
    // `('maybe')::boolean` raises, so `move_video` errors rather than counting
    // it. A renderer cannot raise; not-chosen is the closest it can get.
    expect(readHooks([{ id: "h", text: "x", chosen: "maybe" }])[0].chosen).toBe(false);
    expect(readHooks([{ id: "h", text: "x", chosen: 7 }])[0].chosen).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Lenient reading                                                             */
/* -------------------------------------------------------------------------- */

describe("readHooks / readTitleCandidates", () => {
  it("returns an empty list for anything that is not an array", () => {
    expect(readHooks(null)).toEqual([]);
    expect(readHooks(undefined)).toEqual([]);
    expect(readHooks({ hooks: [] })).toEqual([]);
    expect(readTitleCandidates("[]")).toEqual([]);
  });

  it("skips entries that are not objects", () => {
    expect(readHooks([null, "text", 3, ["a"], { id: "h1", text: "kept" }])).toEqual([
      { id: "h1", text: "kept", chosen: false },
    ]);
  });

  it("does NOT repair two chosen hooks — the indicator has to agree with move_video", () => {
    const hooks = readHooks([
      { id: "h1", text: "one", chosen: true },
      { id: "h2", text: "two", chosen: true },
    ]);
    expect(hooks.filter((h) => h.chosen)).toHaveLength(2);
    expect(
      packagingGate({
        title: "A title",
        thumbnailConcept: "A concept",
        hooks,
        packagingSkippedAt: null,
      }).missing,
    ).toBe("hook");
  });

  it("reads `chosen` the way `(h ->> 'chosen')::boolean` would", () => {
    expect(readHooks([{ id: "a", text: "x", chosen: "true" }])[0].chosen).toBe(true);
    expect(readHooks([{ id: "b", text: "x", chosen: "t" }])[0].chosen).toBe(true);
    expect(readHooks([{ id: "c", text: "x", chosen: 1 }])[0].chosen).toBe(true);
    expect(readHooks([{ id: "d", text: "x", chosen: "false" }])[0].chosen).toBe(false);
    expect(readHooks([{ id: "e", text: "x" }])[0].chosen).toBe(false);
  });

  it("replaces a missing or duplicated id so rows stay addressable", () => {
    const hooks = readHooks([
      { text: "no id" },
      { id: "dup", text: "first" },
      { id: "dup", text: "second" },
    ]);
    expect(new Set(hooks.map((h) => h.id)).size).toBe(3);
    expect(hooks.map((h) => h.text)).toEqual(["no id", "first", "second"]);
  });

  it("repairs ids deterministically, so SSR and hydration agree", () => {
    // The repaired id lands in a rendered `id` attribute. A random replacement
    // would differ between the server render and the hydration of the same
    // markup, which React reports as a mismatch.
    const raw = [{ text: "no id" }, { id: "dup", text: "a" }, { id: "dup", text: "b" }];
    expect(readHooks(raw).map((h) => h.id)).toEqual(readHooks(raw).map((h) => h.id));
  });

  it("does not let a repaired id collide with a real one further down", () => {
    const hooks = readHooks([{ text: "no id" }, { id: "auto-0", text: "taken" }]);
    expect(hooks[0].id).not.toBe("auto-0");
    expect(hooks[1].id).toBe("auto-0");
    expect(new Set(hooks.map((h) => h.id)).size).toBe(2);
  });

  it("round-trips a list this app wrote", () => {
    const written = TitleCandidateListSchema.parse([
      candidate({ id: "c1", chosen: true, note: "the one" }),
      candidate({ id: "c2", text: "Runner up" }),
    ]);
    expect(readTitleCandidates(JSON.parse(JSON.stringify(written)))).toEqual(written);
  });
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

describe("packagingGate", () => {
  const ready: PackagingSnapshot = {
    title: "How I edit ten videos a week",
    thumbnailConcept: "Face left, three props on the desk",
    hooks: [{ chosen: true }, { chosen: false }],
    packagingSkippedAt: null,
  };

  it("is ready when all three fields are there", () => {
    const status = packagingGate(ready);
    expect(status.ready).toBe(true);
    expect(status.missing).toBeNull();
    expect(describeGate(status)).toBe("Packaging: ready");
  });

  it("names the title first, the way the elsif chain does", () => {
    const status = packagingGate({ ...ready, title: "" });
    expect(status.missing).toBe("title");
    expect(describeGate(status)).toBe(`Packaging: needs ${GATE_WORDING.title}`);
  });

  it("lists every missing field in the sentence, so nobody is refused twice", () => {
    // M9 review: a video missing the concept and the hook was told about the
    // concept, fixed it, and only then learned about the hook.
    const status = packagingGate({ ...ready, title: "", thumbnailConcept: null, hooks: [] });
    expect(status.missing).toBe("title");
    expect(status.ready ? [] : status.allMissing).toEqual(["title", "thumbnail_concept", "hook"]);
    expect(describeGate(status)).toBe(
      `Packaging: needs ${GATE_WORDING.title}, ${GATE_WORDING.thumbnail_concept} and ${GATE_WORDING.hook} — none is chosen yet`,
    );
    expect(
      describeGate(packagingGate({ ...ready, thumbnailConcept: "", hooks: [] })),
    ).toBe(
      `Packaging: needs ${GATE_WORDING.thumbnail_concept} and ${GATE_WORDING.hook} — none is chosen yet`,
    );
  });

  it("treats a null title as missing, like coalesce(title, '')", () => {
    expect(packagingGate({ ...ready, title: null }).missing).toBe("title");
  });

  it("does not trim — it judges the value as stored, exactly as the SQL does", () => {
    // A title of one space satisfies `coalesce(title,'') <> ''` in plpgsql, so
    // it satisfies this too. The editor trims before saving, so this state is
    // only reachable for a row written outside this app — and when it is
    // reachable, the indicator has to say what the gate will actually do.
    expect(packagingGate({ ...ready, title: " " }).ready).toBe(true);
  });

  it("names the concept second, and means the written one", () => {
    const status = packagingGate({ ...ready, thumbnailConcept: "" });
    expect(status.missing).toBe("thumbnail_concept");
    expect(describeGate(status)).toMatch(/the sketch is not it/);
  });

  it("names the hook last, and says none is chosen", () => {
    const status = packagingGate({ ...ready, hooks: [{ chosen: false }, { chosen: false }] });
    expect(status.missing).toBe("hook");
    expect(describeGate(status)).toMatch(/none is chosen yet/);
  });

  it("refuses two chosen hooks and says how many", () => {
    const status = packagingGate({ ...ready, hooks: [{ chosen: true }, { chosen: true }] });
    expect(status.missing).toBe("hook");
    expect(status.chosenHooks).toBe(2);
    expect(describeGate(status)).toMatch(/2 are chosen/);
  });

  it("goes back to not-ready when a filled field is cleared again", () => {
    expect(packagingGate(ready).ready).toBe(true);
    const cleared = packagingGate({ ...ready, title: "" });
    expect(cleared.ready).toBe(false);
    expect(cleared.missing).toBe("title");
  });

  it("passes a skipped video with every field empty, and says it was skipped", () => {
    const status = packagingGate({
      title: "",
      thumbnailConcept: null,
      hooks: [],
      packagingSkippedAt: "2026-09-17T10:00:00Z",
    });
    expect(status.ready).toBe(true);
    expect(status.skipped).toBe(true);
    expect(describeGate(status)).toBe("Packaging: skipped");
  });

  it("checks the skip before the fields, as move_video does", () => {
    // `packaging_skipped_at is null` is part of the `if` that guards the whole
    // block, so a skipped video is never asked about its title at all.
    const status = packagingGate({
      title: null,
      thumbnailConcept: null,
      hooks: [{ chosen: true }, { chosen: true }],
      packagingSkippedAt: "2026-09-17T10:00:00Z",
    });
    expect(status.missing).toBeNull();
  });

  it("is ready again after un-skipping, once the fields are filled", () => {
    expect(packagingGate({ ...ready, packagingSkippedAt: null }).skipped).toBe(false);
    expect(packagingGate({ ...ready, packagingSkippedAt: null }).ready).toBe(true);
  });
});
