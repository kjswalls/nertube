import { describe, expect, it } from "vitest";

import { DEFAULT_EST_MINUTES, type ChecklistItem } from "./checklist";
import { SEED_STAGES } from "./defaults";
import {
  METRICS_DUE_AFTER_MS,
  NO_FILTERS,
  QUICK_MINUTES,
  bySection,
  channelExpectation,
  compareRows,
  formatPublishDate,
  matchesFilters,
  nextAction,
  nextStageAfter,
  rankNow,
  type NowChannel,
  type NowContext,
  type NowStage,
  type NowVideo,
} from "./next-action";

/**
 * `nextAction()` is the one piece of this product that is pure enough to be
 * proved rather than demonstrated, and PLAN.md's M3 review asks for exactly
 * that: *a `vitest` fixture for `nextAction()`: 8-video week, plus Repurposed
 * disabled + a video published 25h ago (must be Overdue), a bank of 30 ideas
 * (zero rows), a Scheduled video for next Tuesday (Waiting), a Packaging video
 * with everything filled (Move row succeeds)*.
 *
 * Every one of those is below, plus a case per rule, plus the three traps the
 * plan calls out in prose: ideas are skipped entirely, zero checklist items is
 * not "all checked", and a terminal stage emits no move.
 *
 * The clock is a constant. Nothing in this file reads `Date.now()`, which is
 * what makes "published 25 hours ago" an assertion rather than a race.
 */

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

/** Monday 15 September 2025, 09:00 UTC. Ten minutes before the coffee. */
const NOW = Date.parse("2025-09-15T09:00:00Z");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An ISO stamp `ms` before `NOW`. */
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

/**
 * The nine seeded stages of one channel, ids derived from the kind so a test
 * can name one without a lookup table. Built from `lib/defaults.ts` rather than
 * typed out, so a rename in the seed shows up here.
 */
function stagesOf(
  channelId: string,
  disabled: readonly string[] = [],
): NowStage[] {
  return SEED_STAGES.filter((stage) => !disabled.includes(stage.kind)).map(
    (stage) => ({
      id: `${channelId}-${stage.kind}`,
      name: stage.name,
      kind: stage.kind,
    }),
  );
}

function channel(over: Partial<NowChannel> = {}): NowChannel {
  const id = over.id ?? "ch1";
  return {
    id,
    name: "Personal",
    slug: "personal",
    expectedCtr: null,
    stages: stagesOf(id),
    ...over,
  };
}

function contextOf(...channels: NowChannel[]): NowContext {
  return { channels: new Map(channels.map((c) => [c.id, c])) };
}

let counter = 0;

function video(over: Partial<NowVideo> = {}): NowVideo {
  counter += 1;
  return {
    id: `v${counter}`,
    channelId: "ch1",
    title: "How I edit ten videos a week",
    stageId: "ch1-packaging",
    stageEnteredAt: ago(2 * DAY),
    thumbnailConcept: "Me, buried in timeline clips, one hand on the mouse",
    hooks: [{ id: "h1", text: "I edit ten videos a week. Here is how.", chosen: true }],
    packagingSkippedAt: null,
    waitingOn: null,
    waitingSince: null,
    targetPublishDate: null,
    publishedAt: null,
    youtubeUrl: null,
    first24Impressions: null,
    first24Ctr: null,
    metricsLoggedAt: null,
    swapDismissedAt: null,
    lastSwapAt: null,
    checklist: [],
    ...over,
  };
}

/**
 * A checklist, written as overrides. `estMinutes` defaults to 15 so that a row
 * only looks "quick" when a test says so, and `createdAt` is spread out so the
 * tiebreak in `compareItems` is exercised rather than accidental.
 */
function checklist(items: readonly Partial<ChecklistItem>[]): ChecklistItem[] {
  return items.map((item, index) => ({
    id: item.id ?? `i${index + 1}`,
    text: item.text ?? `Item ${index + 1}`,
    position: item.position ?? index + 1,
    estMinutes: item.estMinutes === undefined ? 15 : item.estMinutes,
    checkedAt: item.checkedAt ?? null,
    createdAt: item.createdAt ?? new Date(NOW - (100 - index) * 1000).toISOString(),
  }));
}

const ticked = ago(DAY);

/** Run one video through the ranking with a single default channel. */
function rowFor(over: Partial<NowVideo> = {}, ch: NowChannel = channel()) {
  return nextAction(video(over), contextOf(ch), NOW);
}

/* -------------------------------------------------------------------------- */
/* Rule 0 — ideas and other non-rows                                           */
/* -------------------------------------------------------------------------- */

describe("what produces no row at all", () => {
  it("skips kind idea entirely, however stale and however empty", () => {
    expect(
      rowFor({
        stageId: "ch1-idea",
        title: "",
        thumbnailConcept: null,
        hooks: [],
        stageEnteredAt: ago(400 * DAY),
      }),
    ).toBeNull();
  });

  it("gives a bank of 30 ideas zero rows", () => {
    const ch = channel();
    const bank = Array.from({ length: 30 }, (_, index) =>
      video({
        id: `idea-${index}`,
        stageId: "ch1-idea",
        title: `Idea ${index}`,
        stageEnteredAt: ago((index + 1) * DAY),
      }),
    );

    expect(rankNow(bank, contextOf(ch), NOW)).toEqual([]);
  });

  it("treats zero checklist items as nothing to do, not as all checked", () => {
    // Everything the gate wants is present and the stage is past packaging, so
    // rules 1-5 and 7 are all out. Rule 6 needs an unchecked item and rule 8
    // needs total > 0; an empty list satisfies neither.
    expect(rowFor({ stageId: "ch1-scripting", checklist: [] })).toBeNull();
  });

  it("drops a video whose stage is not enabled", () => {
    const ch = channel({ stages: stagesOf("ch1", ["repurposed"]) });
    expect(rowFor({ stageId: "ch1-repurposed" }, ch)).toBeNull();
  });

  it("drops a video whose channel is not in the context", () => {
    expect(nextAction(video({ channelId: "gone" }), contextOf(channel()), NOW)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 1 — the gate was walked past                                           */
/* -------------------------------------------------------------------------- */

describe("rule 1 — complete packaging", () => {
  it("is Overdue past packaging with no title, and names the field", () => {
    const row = rowFor({ stageId: "ch1-scripting", title: "" });

    expect(row).toMatchObject({
      rule: 1,
      section: "overdue",
      input: "text",
      label: "Complete packaging: a working title",
    });
    expect(row?.payload).toMatchObject({ input: "text", field: "title" });
  });

  it("names the written concept, not the sketch", () => {
    const row = rowFor({ stageId: "ch1-editing", thumbnailConcept: "" });
    expect(row?.label).toBe(
      "Complete packaging: a thumbnail concept written down (the sketch is not it)",
    );
  });

  it("asks for a hook with a choice control when none is chosen", () => {
    const row = rowFor({
      stageId: "ch1-filming",
      hooks: [
        { id: "h1", text: "One", chosen: false },
        { id: "h2", text: "Two", chosen: false },
      ],
    });

    expect(row).toMatchObject({ rule: 1, input: "choice", section: "overdue" });
    expect(row?.payload).toMatchObject({ input: "choice" });
  });

  it("stops at the FIRST missing field, exactly as move_video does", () => {
    const row = rowFor({ stageId: "ch1-scripting", title: "", thumbnailConcept: "" });
    expect(row?.label).toBe("Complete packaging: a working title");
  });

  it("still nags a video that was moved past the gate with a skip", () => {
    // PLAN.md's gate section: skipping "puts 'Complete packaging' at the top of
    // /now for that video until gate_ok holds". A skip buys the move, not the
    // work, so the field predicate here ignores packaging_skipped_at.
    const row = rowFor({
      stageId: "ch1-scripting",
      title: "",
      packagingSkippedAt: ago(DAY),
    });

    expect(row).toMatchObject({ rule: 1, section: "overdue" });
  });

  it("does not fire inside Packaging itself — that is rule 7's job", () => {
    const row = rowFor({
      stageId: "ch1-packaging",
      title: "",
      checklist: checklist([{ checkedAt: ticked }]),
    });
    expect(row?.rule).toBe(7);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 2 — the 24h metrics                                                    */
/* -------------------------------------------------------------------------- */

describe("rule 2 — log 24h impressions and CTR", () => {
  const published = (over: Partial<NowVideo> = {}) =>
    rowFor({
      stageId: "ch1-published",
      publishedAt: ago(25 * HOUR),
      checklist: checklist([{ checkedAt: ticked }]),
      ...over,
    });

  it("is Overdue for a video published 25 hours ago with no metrics", () => {
    const row = published();

    expect(row).toMatchObject({
      rule: 2,
      section: "overdue",
      input: "metrics_pair",
      label: "Log 24h impressions + CTR",
    });
  });

  it("is Overdue even when the Repurposed lane is switched off", () => {
    // PLAN.md's M3 review case, word for word. Turning the lane off must not
    // turn the post-publish loop off with it.
    const ch = channel({ stages: stagesOf("ch1", ["repurposed"]) });
    const row = nextAction(
      video({
        stageId: "ch1-published",
        publishedAt: ago(25 * HOUR),
        checklist: checklist([{ checkedAt: ticked }]),
      }),
      contextOf(ch),
      NOW,
    );

    expect(row).toMatchObject({ rule: 2, section: "overdue" });
  });

  it("stays quiet for the first 24 hours", () => {
    const row = published({ publishedAt: ago(23 * HOUR) });
    expect(row?.rule).not.toBe(2);
  });

  it("fires the moment the window closes, not a minute later", () => {
    expect(published({ publishedAt: ago(METRICS_DUE_AFTER_MS) })?.rule).toBe(2);
    expect(published({ publishedAt: ago(METRICS_DUE_AFTER_MS - 1) })?.rule).not.toBe(2);
  });

  it("carries both halves of the pair, even when both are empty", () => {
    expect(published()?.payload).toEqual({
      input: "metrics_pair",
      impressions: null,
      ctr: null,
    });
  });

  it("does not fire once the metrics are logged", () => {
    const row = published({
      metricsLoggedAt: ago(HOUR),
      first24Impressions: 12_400,
      first24Ctr: 5.2,
    });
    expect(row?.rule).not.toBe(2);
  });

  it("does not fire on a published row with no published_at", () => {
    expect(published({ publishedAt: null })?.rule).not.toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 3 — the swap prompt                                                    */
/* -------------------------------------------------------------------------- */

describe("rule 3 — swap thumbnail?", () => {
  const underperforming = (
    over: Partial<NowVideo> = {},
    ch: NowChannel = channel({ expectedCtr: 5 }),
  ) =>
    rowFor(
      {
        stageId: "ch1-published",
        publishedAt: ago(3 * DAY),
        metricsLoggedAt: ago(2 * DAY),
        first24Impressions: 12_400,
        first24Ctr: 3.1,
        checklist: checklist([{ checkedAt: ticked }]),
        ...over,
      },
      ch,
    );

  it("is Overdue, and says both numbers in the label", () => {
    const row = underperforming();

    expect(row).toMatchObject({ rule: 3, section: "overdue", input: "swap" });
    expect(row?.label).toBe("Swap thumbnail? (12,400 impr / 3.1% CTR)");
  });

  it("is skipped entirely when the channel has no expectation", () => {
    const row = underperforming({}, channel({ expectedCtr: null }));
    expect(row?.rule).not.toBe(3);
  });

  it("is quiet at or above the expectation", () => {
    expect(underperforming({ first24Ctr: 5 })?.rule).not.toBe(3);
    expect(underperforming({ first24Ctr: 5.1 })?.rule).not.toBe(3);
    expect(underperforming({ first24Ctr: 4.99 })?.rule).toBe(3);
  });

  it("is quiet once a swap has been logged since the metrics were", () => {
    expect(underperforming({ lastSwapAt: ago(DAY) })?.rule).not.toBe(3);
    // A swap from *before* the metrics is a different decision about a
    // different reading, so it does not silence this one.
    expect(underperforming({ lastSwapAt: ago(2 * DAY + HOUR) })?.rule).toBe(3);
  });

  it("is quiet once 'keep it' has been pressed", () => {
    expect(underperforming({ swapDismissedAt: ago(HOUR) })?.rule).not.toBe(3);
  });
});

describe("channelExpectation", () => {
  it("prefers the channel's configured CTR", () => {
    expect(channelExpectation(4.5, [9, 9, 9])).toBe(4.5);
  });

  it("falls back to the median of the recent CTRs", () => {
    expect(channelExpectation(null, [2, 6, 4])).toBe(4);
  });

  it("averages the two middles of an even sample", () => {
    expect(channelExpectation(null, [2, 4, 6, 8])).toBe(5);
  });

  it("looks at ten at most", () => {
    const eleven = [100, ...Array.from({ length: 10 }, () => 2)];
    expect(channelExpectation(null, eleven)).toBe(2);
  });

  it("is null when there is nothing to go on", () => {
    expect(channelExpectation(null, [])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 4 — waiting                                                            */
/* -------------------------------------------------------------------------- */

describe("rule 4 — waiting on somebody", () => {
  it("lands in Waiting with the clear control and the since stamp", () => {
    const since = ago(6 * DAY);
    const row = rowFor({
      stageId: "ch1-editing",
      waitingOn: "the editor's second pass",
      waitingSince: since,
      checklist: checklist([{}]),
    });

    expect(row).toMatchObject({
      rule: 4,
      section: "waiting",
      input: "clear_waiting",
      label: "Waiting on the editor's second pass",
    });
    expect(row?.payload).toMatchObject({ waitingSince: since });
  });

  it("loses to the three Overdue rules", () => {
    const row = rowFor({
      stageId: "ch1-published",
      publishedAt: ago(25 * HOUR),
      waitingOn: "YouTube processing",
      waitingSince: ago(HOUR),
      checklist: checklist([{ checkedAt: ticked }]),
    });

    expect(row?.rule).toBe(2);
  });

  it("beats the checklist", () => {
    const row = rowFor({
      stageId: "ch1-editing",
      waitingOn: "the editor",
      waitingSince: ago(HOUR),
      checklist: checklist([{ text: "Dead stretches cut" }]),
    });

    expect(row?.rule).toBe(4);
  });

  it("ignores a blank waiting_on", () => {
    const row = rowFor({
      stageId: "ch1-editing",
      waitingOn: "   ",
      waitingSince: ago(HOUR),
      checklist: checklist([{ text: "Dead stretches cut" }]),
    });

    expect(row?.rule).toBe(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 5 — scheduled                                                          */
/* -------------------------------------------------------------------------- */

describe("rule 5 — scheduled", () => {
  const scheduled = (targetPublishDate: string | null) =>
    rowFor({ stageId: "ch1-scheduled", targetPublishDate });

  it("waits while the go-live date is still ahead", () => {
    // Next Tuesday, from PLAN.md's review list.
    const row = scheduled("2025-09-23");

    expect(row).toMatchObject({
      rule: 5,
      section: "waiting",
      input: "url",
      label: "Goes live 23 Sept",
    });
    expect(row?.payload).toMatchObject({ due: false });
  });

  it("is Ready on the day itself", () => {
    const row = scheduled("2025-09-15");

    expect(row).toMatchObject({
      rule: 5,
      section: "ready",
      input: "url",
      label: "Confirm live + record URL",
    });
    expect(row?.payload).toMatchObject({
      due: true,
      publishedStageId: "ch1-published",
      targetPublishDate: "2025-09-15",
    });
  });

  it("is Ready after the day", () => {
    expect(scheduled("2025-09-10")).toMatchObject({ section: "ready" });
  });

  it("falls through when there is no date to go by", () => {
    expect(scheduled(null)).toBeNull();
  });

  it("falls through when the channel has no Published stage enabled", () => {
    const ch = channel({ stages: stagesOf("ch1", ["published", "repurposed"]) });
    const row = nextAction(
      video({ stageId: "ch1-scheduled", targetPublishDate: "2025-09-23" }),
      contextOf(ch),
      NOW,
    );
    expect(row).toBeNull();
  });
});

describe("formatPublishDate", () => {
  it("is fixed-locale and fixed-zone, so the server and the browser agree", () => {
    expect(formatPublishDate("2025-01-05")).toBe("5 Jan");
    expect(formatPublishDate("2025-12-31")).toBe("31 Dec");
  });

  it("hands back nonsense unchanged rather than printing 'Invalid Date'", () => {
    expect(formatPublishDate("not a date")).toBe("not a date");
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 6 — the checklist                                                      */
/* -------------------------------------------------------------------------- */

describe("rule 6 — the next unticked box", () => {
  it("offers the first unchecked item by position, with its estimate", () => {
    const row = rowFor({
      stageId: "ch1-scripting",
      checklist: checklist([
        { position: 1, text: "Hook scripted word-for-word", checkedAt: ticked },
        { position: 2, text: "No welcome-back preamble", estMinutes: 5 },
        { position: 3, text: "Structure picked", estMinutes: 20 },
      ]),
    });

    expect(row).toMatchObject({
      rule: 6,
      section: "ready",
      input: "tick",
      label: "No welcome-back preamble",
      estMinutes: 5,
    });
  });

  it("reads a null estimate as ten minutes", () => {
    const row = rowFor({
      stageId: "ch1-scripting",
      checklist: checklist([{ estMinutes: null }]),
    });
    expect(row?.estMinutes).toBe(DEFAULT_EST_MINUTES);
  });

  it("picks up an item added at the top, which is the point of adding one", () => {
    const row = rowFor({
      stageId: "ch1-scripting",
      checklist: checklist([
        { position: 1, text: "Hook scripted word-for-word" },
        { position: 0, text: "Ask Sam about the b-roll" },
      ]),
    });

    expect(row?.label).toBe("Ask Sam about the b-roll");
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 7 — the packaging fields, after the checklist                          */
/* -------------------------------------------------------------------------- */

describe("rule 7 — the gate fields, once the checklist is done", () => {
  const packaging = (over: Partial<NowVideo>) =>
    rowFor({
      stageId: "ch1-packaging",
      checklist: checklist([
        { checkedAt: ticked },
        { checkedAt: ticked },
      ]),
      ...over,
    });

  it("asks for a title", () => {
    expect(packaging({ title: "" })).toMatchObject({
      rule: 7,
      section: "ready",
      input: "text",
      label: "Pick a working title",
    });
  });

  it("asks for the concept", () => {
    expect(packaging({ thumbnailConcept: null })).toMatchObject({
      rule: 7,
      label: "Write the thumbnail concept",
      input: "text",
    });
  });

  it("asks for a hook, as a choice", () => {
    expect(
      packaging({ hooks: [{ id: "h1", text: "One", chosen: false }] }),
    ).toMatchObject({ rule: 7, label: "Choose a hook", input: "choice" });
  });

  it("comes AFTER the checklist, so candidates are generated first", () => {
    const row = packaging({
      title: "",
      checklist: checklist([
        { position: 1, text: "Generated 10–20 title candidates, not 3" },
      ]),
    });

    expect(row).toMatchObject({ rule: 6, label: "Generated 10–20 title candidates, not 3" });
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 8 — the move                                                           */
/* -------------------------------------------------------------------------- */

describe("rule 8 — move to the next stage", () => {
  it("offers the move on a Packaging video with everything filled", () => {
    // PLAN.md's M3 review case: "a Packaging video with everything filled
    // (Move row succeeds)".
    const row = rowFor({
      stageId: "ch1-packaging",
      checklist: checklist([{ checkedAt: ticked }, { checkedAt: ticked }]),
    });

    expect(row).toMatchObject({
      rule: 8,
      section: "ready",
      input: "move",
      label: "Move to Scripting",
    });
    expect(row?.payload).toMatchObject({ toStageId: "ch1-scripting" });
  });

  it("steps over a disabled stage, exactly as the board's ] does", () => {
    const ch = channel({ stages: stagesOf("ch1", ["scheduled"]) });
    const row = nextAction(
      video({
        stageId: "ch1-publish_prep",
        checklist: checklist([{ checkedAt: ticked }]),
      }),
      contextOf(ch),
      NOW,
    );

    expect(row?.payload).toMatchObject({ toStageId: "ch1-published" });
  });

  it("emits nothing from a terminal stage", () => {
    const row = rowFor({
      stageId: "ch1-repurposed",
      checklist: checklist([{ checkedAt: ticked }]),
    });
    expect(row).toBeNull();
  });

  /*
    The entrance to the terminal stage, which is the half the suite was missing.

    BRIEF.md principle 8: *check first-24h performance, swap thumbnail if
    needed, then repurpose*. Repurposed is terminal, so a move taken before the
    metrics exist ends the post-publish loop permanently — rules 2 and 3 are
    keyed on `kind === "published"` and can never fire again.
  */
  it("does not offer the move out of Published while the first 24 hours are unlogged", () => {
    const row = rowFor({
      stageId: "ch1-published",
      // 23 hours: rule 2 has not come due yet either, so this is the exact
      // window in which the old code offered the one-way door.
      publishedAt: ago(23 * HOUR),
      stageEnteredAt: ago(23 * HOUR),
      metricsLoggedAt: null,
      checklist: checklist([{ checkedAt: ticked }, { checkedAt: ticked }]),
    });

    expect(row).toBeNull();
  });

  it("offers it again the moment the metrics are logged", () => {
    const row = rowFor({
      stageId: "ch1-published",
      publishedAt: ago(30 * HOUR),
      stageEnteredAt: ago(30 * HOUR),
      metricsLoggedAt: ago(HOUR),
      first24Impressions: 12_400,
      first24Ctr: 6.1,
      checklist: checklist([{ checkedAt: ticked }]),
    });

    expect(row?.rule).toBe(8);
    expect(row?.payload).toMatchObject({ toStageId: "ch1-repurposed" });
  });

  it("still offers a move out of a non-published stage with no metrics", () => {
    // The guard is about the post-publish loop, not about `published_at` being
    // null everywhere else in the app.
    const row = rowFor({
      stageId: "ch1-scheduled",
      targetPublishDate: null,
      checklist: checklist([{ checkedAt: ticked }]),
    });

    expect(row?.rule).toBe(8);
  });

  it("emits nothing from Published when the Repurposed lane is off", () => {
    const ch = channel({ stages: stagesOf("ch1", ["repurposed"]) });
    const row = nextAction(
      video({
        stageId: "ch1-published",
        publishedAt: ago(3 * DAY),
        metricsLoggedAt: ago(2 * DAY),
        first24Impressions: 9_000,
        first24Ctr: 6,
        checklist: checklist([{ checkedAt: ticked }]),
      }),
      contextOf(ch),
      NOW,
    );

    expect(row).toBeNull();
  });

  it("never offers a move move_video would refuse", () => {
    // Nothing should be able to reach rule 8 with the gate open, but the check
    // is there and this is what it is for: a row that promised a move and then
    // produced a refusal toast would be the worst row in the list.
    const ch = channel();
    const row = nextAction(
      {
        ...video({
          stageId: "ch1-packaging",
          checklist: checklist([{ checkedAt: ticked }]),
        }),
        // A row that reaches rule 8 with an empty title is only reachable by
        // constructing one, because rule 7 would have caught it.
        title: "",
        packagingSkippedAt: null,
      },
      contextOf(ch),
      NOW,
    );

    expect(row?.rule).toBe(7);
  });

  it("does offer the move when packaging was skipped with a reason", () => {
    const row = rowFor({
      stageId: "ch1-packaging",
      title: "Placeholder",
      thumbnailConcept: "A concept",
      hooks: [{ id: "h1", text: "A hook", chosen: true }],
      packagingSkippedAt: ago(DAY),
      checklist: checklist([{ checkedAt: ticked }]),
    });

    expect(row).toMatchObject({ rule: 8, label: "Move to Scripting" });
  });
});

describe("nextStageAfter", () => {
  const stages = stagesOf("ch1");

  it("goes by CORE_KIND_ORDER, not by the order of the array", () => {
    expect(nextStageAfter([...stages].reverse(), "filming")?.kind).toBe("editing");
  });

  it("is null at the end", () => {
    expect(nextStageAfter(stages, "repurposed")).toBeNull();
  });

  it("is null for an inert stage, and never returns one", () => {
    const withInert: NowStage[] = [
      ...stages,
      { id: "ch1-inert", name: "Sponsor review", kind: null },
    ];
    expect(nextStageAfter(withInert, null)).toBeNull();
    expect(nextStageAfter(withInert, "published")?.kind).toBe("repurposed");
  });
});

/* -------------------------------------------------------------------------- */
/* The sort, and the week                                                      */
/* -------------------------------------------------------------------------- */

describe("the ordering", () => {
  it("is Overdue, then Ready, then Waiting, longest in stage first", () => {
    const ch = channel({ expectedCtr: 5 });
    const rows = rankNow(
      [
        video({
          id: "ready-fresh",
          stageId: "ch1-scripting",
          stageEnteredAt: ago(1 * DAY),
          checklist: checklist([{ text: "Structure picked" }]),
        }),
        video({
          id: "waiting-ancient",
          stageId: "ch1-editing",
          stageEnteredAt: ago(30 * DAY),
          waitingOn: "the editor",
          waitingSince: ago(30 * DAY),
        }),
        video({
          id: "ready-stale",
          stageId: "ch1-scripting",
          stageEnteredAt: ago(9 * DAY),
          checklist: checklist([{ text: "Scanned for repetition" }]),
        }),
        video({
          id: "overdue",
          stageId: "ch1-published",
          stageEnteredAt: ago(2 * DAY),
          publishedAt: ago(2 * DAY),
          checklist: checklist([{ checkedAt: ticked }]),
        }),
      ],
      contextOf(ch),
      NOW,
    );

    expect(rows.map((row) => row.videoId)).toEqual([
      "overdue",
      "ready-stale",
      "ready-fresh",
      "waiting-ancient",
    ]);
  });

  it("is a total order — two identical ages never swap places", () => {
    const a = { ...video({ id: "aaa" }), stageEnteredAt: ago(DAY) };
    const b = { ...video({ id: "bbb" }), stageEnteredAt: ago(DAY) };
    const ch = channel();
    const withChecklist = (v: NowVideo) => ({
      ...v,
      stageId: "ch1-scripting",
      checklist: checklist([{ text: "Structure picked" }]),
    });

    const forwards = rankNow([withChecklist(a), withChecklist(b)], contextOf(ch), NOW);
    const backwards = rankNow([withChecklist(b), withChecklist(a)], contextOf(ch), NOW);

    expect(forwards.map((r) => r.videoId)).toEqual(["aaa", "bbb"]);
    expect(backwards.map((r) => r.videoId)).toEqual(["aaa", "bbb"]);
  });

  it("groups into the three sections in order, empties included", () => {
    const grouped = bySection([]);
    expect(grouped.map((group) => group.section)).toEqual([
      "overdue",
      "ready",
      "waiting",
    ]);
  });

  it("sorts one video's row against itself consistently", () => {
    const row = rowFor({
      stageId: "ch1-scripting",
      checklist: checklist([{ text: "Structure picked" }]),
    });
    expect(row && compareRows(row, row)).toBe(0);
  });
});

describe("the eight-video week", () => {
  /**
   * PLAN.md's fixture, across two channels: one row per moving video, none for
   * the bank, and every section represented. This is the shape of the page the
   * Monday scenario walks.
   */
  const personal = channel({ id: "ch1", expectedCtr: 5 });
  const softworks = channel({
    id: "ch2",
    name: "Sunday Softworks",
    slug: "sunday-softworks",
    expectedCtr: null,
    stages: stagesOf("ch2"),
  });

  const week: NowVideo[] = [
    // 1. an idea — no row
    video({ id: "w1", stageId: "ch1-idea", stageEnteredAt: ago(40 * DAY) }),
    // 2. packaging, checklist half done
    video({
      id: "w2",
      stageId: "ch1-packaging",
      stageEnteredAt: ago(5 * DAY),
      checklist: checklist([
        { position: 1, checkedAt: ticked },
        { position: 2, text: "Title under 55 characters", estMinutes: 5 },
      ]),
    }),
    // 3. packaging, checklist done, no hook chosen
    video({
      id: "w3",
      stageId: "ch1-packaging",
      stageEnteredAt: ago(3 * DAY),
      hooks: [{ id: "h1", text: "One", chosen: false }],
      checklist: checklist([{ checkedAt: ticked }]),
    }),
    // 4. scripting, but the title was cleared afterwards — Overdue
    video({
      id: "w4",
      stageId: "ch1-scripting",
      stageEnteredAt: ago(11 * DAY),
      title: "",
      checklist: checklist([{ checkedAt: ticked }]),
    }),
    // 5. filming, waiting on the weather
    video({
      id: "w5",
      stageId: "ch2-filming",
      channelId: "ch2",
      stageEnteredAt: ago(8 * DAY),
      waitingOn: "a dry Saturday",
      waitingSince: ago(8 * DAY),
    }),
    // 6. editing, a 45-minute item
    video({
      id: "w6",
      stageId: "ch2-editing",
      channelId: "ch2",
      stageEnteredAt: ago(2 * DAY),
      checklist: checklist([{ text: "Dead stretches cut", estMinutes: 45 }]),
    }),
    // 7. scheduled for next Tuesday
    video({
      id: "w7",
      stageId: "ch1-scheduled",
      stageEnteredAt: ago(DAY),
      targetPublishDate: "2025-09-23",
    }),
    // 8. published 25 hours ago, no metrics
    video({
      id: "w8",
      stageId: "ch1-published",
      stageEnteredAt: ago(25 * HOUR),
      publishedAt: ago(25 * HOUR),
      checklist: checklist([{ checkedAt: ticked }]),
    }),
  ];

  const rows = rankNow(week, contextOf(personal, softworks), NOW);

  it("produces one row per moving video and none for the idea", () => {
    expect(rows.map((row) => row.videoId)).toEqual([
      "w4", // overdue — the title was cleared after the move, 11 days in stage
      "w8", // overdue — published 25 hours ago, no metrics
      "w2", // ready   — next checklist item, 5 days
      "w3", // ready   — checklist done, no hook chosen, 3 days
      "w6", // ready   — an editing item, 2 days
      "w5", // waiting — a dry Saturday, 8 days
      "w7", // waiting — goes live next Tuesday
    ]);

    expect(rows).toHaveLength(7);
    expect(rows.some((row) => row.videoId === "w1")).toBe(false);
  });

  it("puts the two Overdue rows first, oldest first", () => {
    expect(rows.slice(0, 2).map((row) => row.videoId)).toEqual(["w4", "w8"]);
    expect(rows.slice(0, 2).every((row) => row.section === "overdue")).toBe(true);
  });

  it("ends with the two Waiting rows", () => {
    const tail = rows.slice(-2);
    expect(tail.every((row) => row.section === "waiting")).toBe(true);
    expect(tail.map((row) => row.videoId)).toEqual(["w5", "w7"]);
  });

  it("leaves four actionable rows under the ten-minute filter", () => {
    const quick = rows.filter((row) =>
      matchesFilters(row, { channelIds: [], quickOnly: true }),
    );

    // w6 is a 45-minute Editing item; w5 and w7 are Waiting, and "Unblocked"
    // is not ten minutes of work because it is not work. What is left is four
    // rows that can actually be finished: two Overdue, two Ready.
    expect(quick.map((row) => row.videoId).sort()).toEqual([
      "w2",
      "w3",
      "w4",
      "w8",
    ]);

    // And every one of them has a control that does something.
    expect(quick.every((row) => row.section !== "waiting")).toBe(true);
  });

  it("keeps a one-line Overdue typing task whatever column it is sitting in", () => {
    // The regression this is guarding: `needsABlock` used to be computed from
    // the stage kind for *every* rule, so w4's "Complete packaging: a working
    // title" — a single-line text box — was hidden by the quick filter the
    // moment the video happened to be in Filming or Editing.
    const inFilming = rankNow(
      [
        video({
          id: "wF",
          channelId: "ch2",
          stageId: "ch2-filming",
          title: "",
          checklist: checklist([{ checkedAt: ticked }]),
        }),
      ],
      contextOf(personal, softworks),
      NOW,
    );

    expect(inFilming[0].rule).toBe(1);
    expect(inFilming[0].needsABlock).toBe(false);
    expect(
      matchesFilters(inFilming[0], { channelIds: [], quickOnly: true }),
    ).toBe(true);
  });

  it("narrows to one channel with the chips", () => {
    const only = rows.filter((row) =>
      matchesFilters(row, { channelIds: ["ch2"], quickOnly: false }),
    );
    expect(only.map((row) => row.videoId).sort()).toEqual(["w5", "w6"]);
  });

  it("keeps everything with no filters at all", () => {
    expect(rows.every((row) => matchesFilters(row, NO_FILTERS))).toBe(true);
  });
});

describe("the quick filter", () => {
  const ch = channel();
  const rowOf = (over: Partial<NowVideo>) => {
    const row = nextAction(video(over), contextOf(ch), NOW);
    if (!row) throw new Error("expected a row");
    return row;
  };

  it("keeps a ten-minute item and drops an eleven-minute one", () => {
    const quick = rowOf({
      stageId: "ch1-scripting",
      checklist: checklist([{ estMinutes: QUICK_MINUTES }]),
    });
    const slow = rowOf({
      stageId: "ch1-scripting",
      checklist: checklist([{ estMinutes: QUICK_MINUTES + 1 }]),
    });

    expect(matchesFilters(quick, { channelIds: [], quickOnly: true })).toBe(true);
    expect(matchesFilters(slow, { channelIds: [], quickOnly: true })).toBe(false);
  });

  it("hides Filming and Editing however short the item claims to be", () => {
    for (const stageId of ["ch1-filming", "ch1-editing"]) {
      const row = rowOf({
        stageId,
        checklist: checklist([{ estMinutes: 1 }]),
      });
      expect(row.needsABlock).toBe(true);
      expect(matchesFilters(row, { channelIds: [], quickOnly: true })).toBe(false);
    }
  });

  it("does not hide them when the filter is off", () => {
    const row = rowOf({
      stageId: "ch1-filming",
      checklist: checklist([{ estMinutes: 60 }]),
    });
    expect(matchesFilters(row, NO_FILTERS)).toBe(true);
  });
});
