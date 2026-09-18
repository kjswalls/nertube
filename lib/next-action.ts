import {
  compareDateColumns,
  formatDateColumn,
  isDateColumn,
  todayColumn,
} from "./calendar-dates";
import {
  DEFAULT_EST_MINUTES,
  estMinutesOf,
  nextItem,
  type ChecklistItem,
} from "./checklist";
import { kindOrder, type StageKind } from "./defaults";
import {
  formatCtr,
  formatImpressions,
  type ExpectationSource,
} from "./metrics";
import { GATE_WORDING, packagingGate, type GateField } from "./packaging";

/**
 * "I have ten minutes — what can I move right now?"
 *
 * BRIEF.md calls this half the product (principle 3: *the app is NOT a
 * single-video wizard; its most important job is answering that question*), and
 * PLAN.md answers it with a **derived** list rather than a stored
 * `next_action` column — open question 3, decided that way because the answer
 * depends on the clock (24h due, go-live date, staleness) and so could never be
 * fully stored anyway, while a stored column would be a cache with five
 * invalidation paths for a list of eight to twenty rows.
 *
 * This file is that derivation, and it is deliberately the *whole* of it:
 *
 * - **Pure.** No clock, no database, no React. `now` arrives as an argument, so
 *   every claim this file makes ("that was published more than 24 hours ago")
 *   is a claim about arithmetic that a test can assert. The page reads the
 *   clock once, on the server, and passes it in — the same discipline the board
 *   uses for days-in-stage, and for the same reason: a value computed during
 *   render on both sides of hydration is a mismatch waiting to happen.
 * - **One decision per video.** `nextAction()` returns at most one row. The
 *   rules are ordered and the first match wins, so a video that is both blocked
 *   and overdue for its metrics appears once, under the more urgent of the two.
 *   That is what makes the list finishable.
 *
 * ## The rules, verbatim from PLAN.md
 *
 * > Kind `idea` is skipped entirely (promotion is a deliberate act from the
 * > board or ideas list). Rules, first match wins:
 * >
 * > 1. kind order > packaging and not `gate_ok` → "Complete packaging: <missing field>" (Overdue)
 * > 2. kind `published`, `published_at + 24h` passed, `metrics_logged_at` null → "Log 24h impressions + CTR" (Overdue)
 * > 3. kind `published`, metrics logged, `first24_ctr < expectation`, no swap after `metrics_logged_at`, `swap_dismissed_at` null → "Swap thumbnail? (X impr / Y% CTR)" (Overdue)
 * > 4. `waiting_on` set → Waiting, with age, `clear_waiting`
 * > 5. kind `scheduled`: `target_publish_date` in the future → Waiting "Goes live <date>"; on/after → "Confirm live + record URL" (Ready)
 * > 6. first unchecked checklist item → its text + `est_minutes` (Ready). Zero items is *not* "all checked".
 * > 7. kind `packaging`, checklist done, gate field missing → "Pick a working title" / "Write the thumbnail concept" / "Choose a hook" (Ready)
 * > 8. checklist done (total > 0), a later enabled stage exists, gate passes → "Move to <next stage>" (Ready); terminal kinds emit nothing
 *
 * One guard is added to rule 8 that PLAN.md's line does not spell out, because
 * BRIEF.md principle 8 does: *check first-24h performance, swap thumbnail if
 * needed, **then** repurpose*. A published video with no metrics logged is not
 * offered the move out. The reasoning is at the rule itself.
 *
 * ## Two words that mean two different things
 *
 * `gate_ok` in rule 1 is **the field predicate only** — title, written concept,
 * exactly one chosen hook — and it deliberately ignores `packaging_skipped_at`.
 * That is not an oversight; it is the other half of the skip mechanic, spelled
 * out in PLAN.md's gate section: *skipping … puts "Complete packaging" at the
 * top of `/now` for that video until `gate_ok` holds*. A skip buys the move,
 * not the work. Rule 7 reads the same predicate for the same reason.
 *
 * Rule 8's "gate passes" is the **other** gate: the one `move_video` will
 * actually apply, which a skip does satisfy. A row that offered a move the
 * database would then refuse would be the one unforgivable row in this list,
 * so the check here is the same predicate the function runs, skip included.
 * Both come from `packagingGate()` in `lib/packaging.ts`; neither is re-typed.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three sections, in the order they are shown. Overdue is a promise broken
 * (a gate walked past, a metric never logged); Ready is work available now;
 * Waiting is somebody else's turn.
 */
export const SECTION_ORDER = ["overdue", "ready", "waiting"] as const;

export type NowSection = (typeof SECTION_ORDER)[number];

/**
 * Which control the row renders. PLAN.md's own list — the discriminator that
 * lets every row be completed in place instead of being a link to a page.
 */
export type NowInput =
  | "tick"
  | "text"
  | "choice"
  | "metrics_pair"
  | "url"
  | "clear_waiting"
  | "swap"
  | "move";

/** The "≤ 10 min" filter's threshold. */
export const QUICK_MINUTES = 10;

/**
 * The two kinds that need a real time block rather than a spare ten minutes
 * (BRIEF.md principle 4: filming is the step that needs a big block). Their
 * rows are tagged and hidden by the quick filter however short the checklist
 * item claims to be — "outline visible while filming" is five minutes of work
 * that costs you an afternoon of setting up.
 */
export const NEEDS_A_BLOCK: readonly StageKind[] = ["filming", "editing"];

/** Rule 2's window: metrics are due 24 hours after publishing. */
export const METRICS_DUE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Rule 3's fallback expectation looks at this many recent published videos. */
export const EXPECTATION_SAMPLE = 10;

/**
 * How many logged videos the median fallback needs before it is an expectation
 * at all.
 *
 * The sample deliberately includes the video being judged — `lib/now-data.ts`
 * computes the fallback from the same rows the rules are about, and
 * `lib/expectation.ts` matches it on purpose. That is fine at a real sample
 * size and arithmetically dishonest at a small one:
 *
 * - **n = 1** is the video compared with itself.
 * - **n = 2** is worse than it looks. The median of two numbers is their mean,
 *   so the *worse* of any two videos is strictly below "expectation" and the
 *   better one is at or above it — guaranteed, whatever the numbers are. A red
 *   swap prompt and an **Overdue** `/now` row would then be manufactured out of
 *   a single comparison, in the one place the product tells the user to act
 *   fast.
 * - **n = 3** is the first size that survives the subject. The median is the
 *   middle value: if the judged video is the worst it is not the median, and if
 *   it *is* the median then `ctr < expectation` is false and nothing fires.
 *
 * Below this, both surfaces return "no expectation" and say so — the prompt
 * renders its *unknown* state and rule 3 never fires. One constant, imported by
 * `lib/expectation.ts`, so the page and `/now` cannot draw the line in two
 * different places.
 */
export const MIN_MEDIAN_SAMPLE = 3;

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/** One enabled stage of a channel. */
export interface NowStage {
  readonly id: string;
  readonly name: string;
  /** Null for a user-added, inert stage — no order, no gate, no move. */
  readonly kind: StageKind | null;
}

/**
 * A channel, with everything a rule needs to know about it.
 *
 * `expectedCtr` is the **resolved** expectation, not the raw column: see
 * `channelExpectation()`. `stages` holds only the enabled ones, which is what
 * makes "a later enabled stage exists" a lookup rather than a join.
 */
export interface NowChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly expectedCtr: number | null;
  /**
   * Where `expectedCtr` came from, and over how many videos.
   *
   * The number alone is not the claim. "the 5% this channel expects" and "the
   * 5.2% median of its last three logged videos" are different sentences, and
   * the video page's swap prompt has always said which one it means. `/now`
   * printed the bare number, so the same video read with two different amounts
   * of honesty depending on the screen — which is the drift this milestone
   * exists to prevent. Both are null / 0 when there is no expectation.
   */
  readonly expectedCtrSource: ExpectationSource | null;
  /** How many past videos the median was taken over. 0 when it was not one. */
  readonly expectedCtrSample: number;
  readonly stages: readonly NowStage[];
}

/** A non-archived video in an enabled stage, with its current-stage checklist. */
export interface NowVideo {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
  readonly stageId: string;
  readonly stageEnteredAt: string;

  /* packaging — exactly the four columns the gate reads */
  readonly thumbnailConcept: string | null;
  readonly hooks: readonly { readonly id: string; readonly text: string; readonly chosen: boolean }[];
  readonly packagingSkippedAt: string | null;

  /* flow */
  readonly waitingOn: string | null;
  readonly waitingSince: string | null;
  readonly targetPublishDate: string | null;

  /* publish and post-publish */
  readonly publishedAt: string | null;
  readonly youtubeUrl: string | null;
  readonly first24Impressions: number | null;
  readonly first24Ctr: number | null;
  readonly metricsLoggedAt: string | null;
  readonly swapDismissedAt: string | null;
  /** The most recent `thumbnail_swaps.swapped_at` for this video, or null. */
  readonly lastSwapAt: string | null;

  /** `checklist_items` for `stageId` only. Order does not matter; see rule 6. */
  readonly checklist: readonly ChecklistItem[];
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What each control needs, discriminated by the same `input` the row carries.
 *
 * Everything here is already resolved: a `move` row knows the stage id it would
 * move to, so completing it is one call and not a second derivation in the
 * component. A row is a complete instruction.
 */
export type NowPayload =
  | {
      readonly input: "tick";
      readonly itemId: string;
      readonly itemText: string;
      readonly estMinutes: number;
    }
  | {
      readonly input: "text";
      /** Which column the single-line box writes. */
      readonly field: Extract<GateField, "title" | "thumbnail_concept">;
      readonly value: string;
    }
  | {
      readonly input: "choice";
      readonly hooks: readonly { readonly id: string; readonly text: string; readonly chosen: boolean }[];
    }
  | {
      readonly input: "metrics_pair";
      /** Both halves, always together — never one without the other. */
      readonly impressions: number | null;
      readonly ctr: number | null;
    }
  | {
      readonly input: "url";
      readonly value: string;
      /** The stage `confirmLive` moves into. */
      readonly publishedStageId: string;
      readonly publishedStageName: string;
      /** `published_at` is stamped with the target date, per PLAN.md rule 5. */
      readonly targetPublishDate: string | null;
      /** False while the go-live date is still in the future. */
      readonly due: boolean;
    }
  | {
      readonly input: "clear_waiting";
      readonly waitingOn: string;
      /** ISO. The page turns it into an age; this file does not format ages. */
      readonly waitingSince: string | null;
    }
  | {
      readonly input: "swap";
      readonly impressions: number;
      readonly ctr: number;
      readonly expectation: number;
      /** Where that number came from — the row prints "(median of 3)". */
      readonly expectationSource: ExpectationSource | null;
      readonly expectationSample: number;
    }
  | {
      readonly input: "move";
      readonly toStageId: string;
      readonly toStageName: string;
    };

/** One line of `/now`. */
export interface NowRow {
  readonly videoId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelSlug: string;
  /** `videos.title`, or a placeholder — a captured idea may have none. */
  readonly videoTitle: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly stageKind: StageKind | null;
  /** Which of the eight rules produced this row. Diagnostics and tests. */
  readonly rule: number;
  readonly label: string;
  readonly section: NowSection;
  readonly input: NowInput;
  readonly payload: NowPayload;
  /** What the "≤ 10 min" filter compares. Non-checklist rows cost the default. */
  readonly estMinutes: number;
  /** Filming and Editing: needs a block, so the quick filter hides it. */
  readonly needsABlock: boolean;
  readonly stageEnteredAt: string;
  /** `now - stage_entered_at`, in ms. The sort key inside a section. */
  readonly ageMs: number;
  /** Whole days in the current stage, floored — what the row shows. */
  readonly daysInStage: number;
}

/* -------------------------------------------------------------------------- */
/* The expectation (rule 3)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * PLAN.md: *`expectation = coalesce(channel.expected_ctr, median first24_ctr of
 * the channel's last 10 published)`; none → rule skipped*.
 *
 * `recentCtrs` is the channel's most recent logged CTRs, newest first, already
 * limited by the caller. Too short a list with no configured expectation
 * returns null, and rule 3 then does not fire at all — which is the right
 * answer for a new channel: "below expectation" is meaningless when there is no
 * expectation, and inventing one (say, 4%) would nag about a video nobody can
 * judge yet.
 */
export function channelExpectation(
  expectedCtr: number | null,
  recentCtrs: readonly number[],
): number | null {
  if (expectedCtr !== null && Number.isFinite(expectedCtr)) return expectedCtr;

  const sample = recentCtrs
    .filter((ctr) => Number.isFinite(ctr))
    .slice(0, EXPECTATION_SAMPLE)
    .sort((a, b) => a - b);

  if (sample.length < MIN_MEDIAN_SAMPLE) return null;

  const middle = sample.length >> 1;
  return sample.length % 2 === 1
    ? sample[middle]
    : (sample[middle - 1] + sample[middle]) / 2;
}

/* -------------------------------------------------------------------------- */
/* Small shared derivations                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The next enabled stage by `CORE_KIND_ORDER` — never by `position`, which is
 * display order only. Same rule as the board's `[` / `]`, so the move offered
 * here and the move those keys make are the same move.
 *
 * Inert stages (`kind = null`) have no order, so they are not "next" for
 * anybody and nothing is next for them. Returning null is what PLAN.md's
 * *terminal kinds emit nothing* means in practice: Repurposed always has
 * nothing after it, and Published has nothing after it on a channel whose
 * Repurposed lane is switched off.
 */
export function nextStageAfter(
  stages: readonly NowStage[],
  kind: StageKind | null,
): NowStage | null {
  if (kind === null) return null;
  const from = kindOrder(kind);

  let best: NowStage | null = null;
  let bestOrder = Number.POSITIVE_INFINITY;
  for (const stage of stages) {
    if (stage.kind === null) continue;
    const order = kindOrder(stage.kind);
    if (order <= from) continue;
    if (order < bestOrder) {
      best = stage;
      bestOrder = order;
    }
  }
  return best;
}

/**
 * A `YYYY-MM-DD` calendar date in words: `3 Mar`.
 *
 * M6 review note: this used to parse `${value}T00:00:00Z` and construct its own
 * `Intl.DateTimeFormat` per call — a fifth interpretation of a `date` column,
 * with options byte-identical to `FORMATS.short` in `lib/calendar-dates.ts`.
 * The integration folded four others in and missed this one, and it was the one
 * that diverged: `Date.parse("2026-02-30T00:00:00Z")` rolls forward, so it
 * printed `2 Mar` for a day that does not exist. The helper refuses it, and a
 * refusal falls back to the stored string rather than to a wrong date.
 *
 * Kept as a named export rather than replaced at the three call sites because
 * "the words `/now` and `/videos/[id]` print a target date in" is a decision
 * this module already owns, and one line is cheaper than three imports.
 */
export function formatPublishDate(value: string): string {
  return formatDateColumn(value, "short") ?? value;
}

/*
  Impressions and CTR are formatted by `lib/metrics.ts`, imported above rather
  than re-typed here: rule 3's label and the Publish section's prompt describe
  the same two numbers about the same video, and "12,400 impr / 4.2% CTR" in one
  place and "12400 impr / 4.20%" in the other is the kind of difference that
  makes a reader check whether they are looking at the same row.
*/

/**
 * The gate as a *field* predicate, ignoring the skip — rule 1 and rule 7.
 *
 * Built by handing `packagingGate` a snapshot with the skip cleared, rather
 * than by re-implementing the `elsif` chain: the chain stops at the first
 * missing field, and a second copy of it here would eventually name a different
 * field than the refusal the board shows for the same row.
 */
function missingGateField(video: NowVideo): GateField | null {
  const status = packagingGate({
    title: video.title,
    thumbnailConcept: video.thumbnailConcept,
    hooks: video.hooks,
    packagingSkippedAt: null,
  });
  return status.ready ? null : status.missing;
}

/** The gate as `move_video` will apply it — the skip counts. Rule 8. */
function movePasses(video: NowVideo, to: NowStage): boolean {
  if (to.kind === null) return true; // an inert stage has no order and no gate
  if (kindOrder(to.kind) <= kindOrder("packaging")) return true;
  return packagingGate({
    title: video.title,
    thumbnailConcept: video.thumbnailConcept,
    hooks: video.hooks,
    packagingSkippedAt: video.packagingSkippedAt,
  }).ready;
}

/** "Pick a working title" and friends — rule 7's wording, per field. */
const RULE_7_LABEL: Record<GateField, string> = {
  title: "Pick a working title",
  thumbnail_concept: "Write the thumbnail concept",
  hook: "Choose a hook",
};

/* -------------------------------------------------------------------------- */
/* The ranking                                                                 */
/* -------------------------------------------------------------------------- */

/** Everything the rules need that is not on the video itself. */
export interface NowContext {
  /** Every channel that owns one of the videos, by id. */
  readonly channels: ReadonlyMap<string, NowChannel>;
}

/**
 * The one decision for one video, or null when the video has nothing to offer.
 *
 * Null is a real and common answer, and the three ways to reach it are all
 * deliberate:
 *
 * - **Kind `idea`.** Skipped before any rule runs. Promotion is a decision, not
 *   a chore, and a bank of thirty ideas would otherwise bury the eight videos
 *   that are actually moving.
 * - **Zero checklist items.** Rule 6 only fires on an *unchecked item*, and
 *   rule 8 requires `total > 0`. "Nothing to tick" is not "everything is done"
 *   (PLAN.md says so twice), so a stage with no template and no items stays
 *   quiet rather than offering a move nobody has earned.
 * - **Nothing after this stage.** Rule 8 needs somewhere to go.
 */
export function nextAction(
  video: NowVideo,
  context: NowContext,
  now: number,
): NowRow | null {
  const channel = context.channels.get(video.channelId);
  if (!channel) return null;

  const stage = channel.stages.find((candidate) => candidate.id === video.stageId);
  if (!stage) return null; // a disabled stage has no column and no row

  const kind = stage.kind;

  // Before every rule: the idea bank is not a to-do list.
  if (kind === "idea") return null;

  const ageMs = ageOf(video.stageEnteredAt, now);

  const build = (
    rule: number,
    label: string,
    section: NowSection,
    payload: NowPayload,
    estMinutes = DEFAULT_EST_MINUTES,
  ): NowRow => ({
    videoId: video.id,
    channelId: channel.id,
    channelName: channel.name,
    channelSlug: channel.slug,
    videoTitle: video.title.trim() === "" ? "Untitled" : video.title,
    stageId: stage.id,
    stageName: stage.name,
    stageKind: kind,
    rule,
    label,
    section,
    input: payload.input,
    payload,
    estMinutes,
    /*
      A property of the *row*, not of the column the video is parked in.

      Only rule 6 is work done *inside* the stage, so only rule 6 inherits the
      stage's cost. "Complete packaging: a working title" is a single-line text
      box whose whole cost is typing a title, and it was being hidden by the
      quick filter for the sole reason that the video happened to be sitting in
      Filming — the filter answering "what can I do in ten minutes" by removing
      the one row that was ten minutes of work.
    */
    needsABlock: rule === 6 && kind !== null && NEEDS_A_BLOCK.includes(kind),
    stageEnteredAt: video.stageEnteredAt,
    ageMs,
    daysInStage: Math.floor(ageMs / 86_400_000),
  });

  /* -- 1. the gate was walked past ---------------------------------------- */

  if (kind !== null && kindOrder(kind) > kindOrder("packaging")) {
    const missing = missingGateField(video);
    if (missing !== null) {
      return build(
        1,
        `Complete packaging: ${GATE_WORDING[missing]}`,
        "overdue",
        missing === "hook"
          ? { input: "choice", hooks: video.hooks }
          : {
              input: "text",
              field: missing,
              value:
                (missing === "title" ? video.title : video.thumbnailConcept) ?? "",
            },
      );
    }
  }

  /* -- 2. the first 24 hours are up and nothing was written down ----------- */

  if (
    kind === "published" &&
    video.metricsLoggedAt === null &&
    video.publishedAt !== null
  ) {
    const published = Date.parse(video.publishedAt);
    if (!Number.isNaN(published) && now - published >= METRICS_DUE_AFTER_MS) {
      return build(2, "Log 24h impressions + CTR", "overdue", {
        input: "metrics_pair",
        // Both halves travel together even when both are empty: the component
        // that renders them is one component (BRIEF.md: *always display
        // impressions and CTR together, never CTR alone*).
        impressions: video.first24Impressions,
        ctr: video.first24Ctr,
      });
    }
  }

  /* -- 3. it is underperforming and nobody has decided anything ------------ */

  if (
    kind === "published" &&
    video.metricsLoggedAt !== null &&
    video.swapDismissedAt === null &&
    video.first24Ctr !== null &&
    video.first24Impressions !== null &&
    channel.expectedCtr !== null &&
    video.first24Ctr < channel.expectedCtr &&
    !swappedSince(video.lastSwapAt, video.metricsLoggedAt)
  ) {
    return build(
      3,
      `Swap thumbnail? (${formatImpressions(video.first24Impressions)} impr / ${formatCtr(video.first24Ctr)}% CTR)`,
      "overdue",
      {
        input: "swap",
        impressions: video.first24Impressions,
        ctr: video.first24Ctr,
        expectation: channel.expectedCtr,
        expectationSource: channel.expectedCtrSource,
        expectationSample: channel.expectedCtrSample,
      },
    );
  }

  /* -- 4. somebody else's turn -------------------------------------------- */

  if (video.waitingOn !== null && video.waitingOn.trim() !== "") {
    return build(4, `Waiting on ${video.waitingOn}`, "waiting", {
      input: "clear_waiting",
      waitingOn: video.waitingOn,
      waitingSince: video.waitingSince,
    });
  }

  /* -- 5. scheduled: before the date, or on it ---------------------------- */

  if (kind === "scheduled") {
    const published = channel.stages.find((s) => s.kind === "published");
    // With no Published stage enabled there is nowhere to confirm *into*, so
    // the rule cannot fire and the video falls through to its checklist.
    if (published && video.targetPublishDate !== null) {
      const due = !isFuture(video.targetPublishDate, now);
      return build(
        5,
        due
          ? "Confirm live + record URL"
          : `Goes live ${formatPublishDate(video.targetPublishDate)}`,
        due ? "ready" : "waiting",
        {
          input: "url",
          value: video.youtubeUrl ?? "",
          publishedStageId: published.id,
          publishedStageName: published.name,
          targetPublishDate: video.targetPublishDate,
          due,
        },
      );
    }
  }

  /* -- 6. the next unticked box ------------------------------------------- */

  const item = nextItem(video.checklist);
  if (item) {
    return build(
      6,
      item.text,
      "ready",
      {
        input: "tick",
        itemId: item.id,
        itemText: item.text,
        estMinutes: estMinutesOf(item),
      },
      estMinutesOf(item),
    );
  }

  /* -- 7. the checklist is done but the packaging is not ------------------- */

  if (kind === "packaging") {
    const missing = missingGateField(video);
    if (missing !== null) {
      return build(
        7,
        RULE_7_LABEL[missing],
        "ready",
        missing === "hook"
          ? { input: "choice", hooks: video.hooks }
          : {
              input: "text",
              field: missing,
              value:
                (missing === "title" ? video.title : video.thumbnailConcept) ?? "",
            },
      );
    }
  }

  /* -- 8. it is finished here; move it ------------------------------------ */

  /*
    BRIEF.md principle 8 orders the post-publish loop: *check first-24h
    performance, swap thumbnail if needed, **then** repurpose into clips /
    newsletter / social*. Rules 2 and 3 are the first two steps and they are
    keyed on `kind === "published"`; Repurposed is terminal, so a move taken
    before the metrics exist is a one-way door out of both of them — the 24h
    prompt and the swap prompt could never fire again, and `first24_*` would
    stay null with nothing anywhere asking for them.

    So the "then" is made mechanical: while a published video has never had its
    first 24 hours written down, rule 8 offers no way out of the stage. The
    seeded Published checklist makes this the default path rather than an edge
    case — its two rows are ticked through rule 6 without recording anything,
    and the third keystroke used to take the move.

    Rule 2 is what fills the gap: it fires as soon as `published_at + 24h`
    passes, so the row is never empty for long, and before then the video
    simply has nothing to offer, which is true.
  */
  const awaitingFirst24 =
    kind === "published" &&
    video.publishedAt !== null &&
    video.metricsLoggedAt === null;

  if (video.checklist.length > 0 && !awaitingFirst24) {
    const to = nextStageAfter(channel.stages, kind);
    if (to !== null && movePasses(video, to)) {
      return build(8, `Move to ${to.name}`, "ready", {
        input: "move",
        toStageId: to.id,
        toStageName: to.name,
      });
    }
  }

  return null;
}

/** True when a swap was logged at or after the metrics were. */
function swappedSince(lastSwapAt: string | null, metricsLoggedAt: string): boolean {
  if (lastSwapAt === null) return false;
  const swapped = Date.parse(lastSwapAt);
  const logged = Date.parse(metricsLoggedAt);
  if (Number.isNaN(swapped) || Number.isNaN(logged)) return false;
  return swapped >= logged;
}

/**
 * Is this calendar date still ahead of us?
 *
 * Whole calendar days, both sides: `todayColumn(now)` is the UTC day the clock
 * is on, and the answer is whether the target day is strictly after it — so the
 * day itself counts as on/after and the row is Ready from midnight UTC on the
 * target date. PLAN.md's wording is *in the future → Waiting; on/after →
 * Ready*.
 *
 * `now` is real UTC and `target_publish_date` is a zoneless `date`, which has a
 * consequence worth stating rather than discovering: a user east of UTC sees
 * "Confirm live" from their local morning, and a user west of it sees it during
 * the evening before. One user, one zone, and a `date` column with no zone in
 * it — pinning this to a configured zone is a settings question (M7), not an
 * arithmetic one.
 */
function isFuture(date: string, now: number): boolean {
  // Whole calendar days through the one helper, rather than a second
  // `Date.parse(date + "T00:00:00Z")`: `todayColumn` is the same UTC floor this
  // used to compute by hand, and it cannot roll `2026-02-30` forward into
  // March the way `Date.parse` does. A value that is not a calendar day at all
  // keeps the old answer — not in the future, so the row is offered rather than
  // held back over a column nobody can read.
  if (!isDateColumn(date)) return false;
  return compareDateColumns(date, todayColumn(now)) > 0;
}

/** Elapsed ms since an ISO stamp; never negative, 0 for an unparseable one. */
function ageOf(iso: string, now: number): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, now - then);
}

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * PLAN.md: *Sort: Overdue → Ready → Waiting, then `now - stage_entered_at`
 * desc.* Longest in its stage first, because that is the definition of the
 * bottleneck the weekly review is looking for (BRIEF.md principle 5).
 *
 * `videoId` is the final tiebreak, so the order is total: two rows of the same
 * age must not swap places between two renders of the same data.
 */
export function compareRows(a: NowRow, b: NowRow): number {
  const section =
    SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
  if (section !== 0) return section;
  if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;
  return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
}

/** Every video's one row, sorted. Videos with nothing to offer simply vanish. */
export function rankNow(
  videos: readonly NowVideo[],
  context: NowContext,
  now: number,
): NowRow[] {
  const rows: NowRow[] = [];
  for (const video of videos) {
    const row = nextAction(video, context, now);
    if (row) rows.push(row);
  }
  return rows.sort(compareRows);
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

export interface NowFilters {
  /** Empty means every channel — the chips are a narrowing, not a selection. */
  readonly channelIds: readonly string[];
  /** PLAN.md's "≤ 10 min". */
  readonly quickOnly: boolean;
}

export const NO_FILTERS: NowFilters = { channelIds: [], quickOnly: false };

/**
 * PLAN.md: *"≤ 10 min" (uses `est_minutes`, null = 10; kinds `filming`/
 * `editing` are tagged "needs a block" and hidden)*.
 *
 * The three tests are separate on purpose.
 *
 * - **Needs a block.** A Filming row is hidden even when its checklist item
 *   claims five minutes, because the five minutes is the task and the afternoon
 *   is the setup. Only a rule-6 row carries the tag — see `needsABlock`.
 * - **The estimate.** Only a checklist row has a real one; every other row is
 *   built with `DEFAULT_EST_MINUTES` so that this comparison has a number, and
 *   that default is a filter default and not a claim (the row does not print
 *   it: see `components/now/now-row.tsx`).
 * - **Waiting.** Hidden outright. This goes past PLAN.md's letter, and
 *   deliberately: the filter's promise is *work you can finish now*, and the
 *   only controls a Waiting row has are "Unblocked" and "Still waiting" —
 *   neither of which is ten minutes of work, because neither is work. Keeping
 *   them was the filter answering a question nobody asked.
 */
export function matchesFilters(row: NowRow, filters: NowFilters): boolean {
  if (
    filters.channelIds.length > 0 &&
    !filters.channelIds.includes(row.channelId)
  ) {
    return false;
  }
  if (filters.quickOnly) {
    if (row.section === "waiting") return false;
    if (row.needsABlock) return false;
    if (row.estMinutes > QUICK_MINUTES) return false;
  }
  return true;
}

/** Rows grouped into the three sections, in `SECTION_ORDER`, empties included. */
export function bySection(
  rows: readonly NowRow[],
): { section: NowSection; rows: NowRow[] }[] {
  return SECTION_ORDER.map((section) => ({
    section,
    rows: rows.filter((row) => row.section === section),
  }));
}

/** How each section is titled. One place, so the page and a test agree. */
export const SECTION_TITLE: Record<NowSection, string> = {
  overdue: "Overdue",
  ready: "Ready",
  waiting: "Waiting",
};
