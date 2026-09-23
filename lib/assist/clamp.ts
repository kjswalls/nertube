import { cleanLabel, sameLabel, stripInvisible } from "@/lib/text";
import {
  MAX_CANDIDATE_NOTE_LENGTH,
  MAX_HOOKS,
  MAX_HOOK_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/packaging";
import { MAX_CONCEPT_LENGTH } from "@/lib/video-fields";

import {
  AssistError,
  type AssistMeta,
  type AssistRequest,
  type AssistResult,
  type AssistSuggestion,
  type ThumbnailVerdict,
} from "./types";
import type { CritiquePayload, SuggestionsPayload } from "./schema";

/**
 * Clamping: the half of the contract the schema deliberately does not enforce.
 *
 * `schema.ts` decides whether an answer is *readable*. This file decides what
 * of a readable answer is *usable*, and it is written around one rule: never
 * throw away work over a number.
 *
 * A model asked for twenty titles that sends twenty-one has done something
 * useful twenty-one times. A model that recommends index 25 of a 20-item list
 * has an opinion and a fencepost error. A model that proposes a title the
 * person already has in their candidates has wasted one line, not the answer.
 * Each of those is repaired here and *counted*, because the count is what lets
 * the panel say "the model sent 21; here are 20" instead of quietly dropping
 * one and hoping nobody notices.
 *
 * The only things actually dropped are the ones that could not be used at all:
 * blank text, text longer than the database column it is destined for, and
 * duplicates of what the person already wrote.
 *
 * Pure. No key, no SDK, no network — both providers run their answers through
 * it, which is also what keeps the fake honest about the shapes the real one
 * produces.
 */

/* -------------------------------------------------------------------------- */
/* How many to ask for                                                         */
/* -------------------------------------------------------------------------- */

/**
 * BRIEF.md's packaging checklist: *"Generated 10–20 title candidates, not 3."*
 * Twenty is the top of that range and the number on the pill ("Generate 20"),
 * so it is what the prompt asks for and the cap the answer is held to.
 */
export const TITLES_WANT = 20;

/**
 * Four concepts is a shortlist you can film against in one session; a thumbnail
 * concept is a paragraph describing a shot, and twenty of those is homework
 * rather than help.
 */
export const CONCEPTS_WANT = 4;

/** The column holds three hooks and no more: `jsonb_array_length(hooks) <= 3`. */
export const HOOKS_MAX = MAX_HOOKS;

/** Caps per kind, so a runaway answer cannot blow up a jsonb column. */
const CAPS = {
  titles: TITLES_WANT,
  concepts: CONCEPTS_WANT + 2,
  hooks: HOOKS_MAX,
} as const;

/** The longest a suggestion's `text` may be, per kind: the column it becomes. */
const TEXT_LIMITS = {
  titles: MAX_TITLE_LENGTH,
  concepts: MAX_CONCEPT_LENGTH,
  hooks: MAX_HOOK_LENGTH,
} as const;

/** The kinds that answer with a ranked list. */
export type SuggestionKind = "titles" | "concepts" | "hooks";

/**
 * The ceiling an answer of this kind is held to — which is not always the
 * number the prompt asks for. Concepts are asked for four and capped at six,
 * because a fifth genuinely different picture is worth keeping and a fifth
 * paragraph of padding is not. `prompts.ts` reads this so the instruction the
 * model is given ("anything past six will be trimmed") is the rule the code
 * actually applies.
 */
export function capFor(request: AssistRequest): number {
  if (request.kind === "thumbnail_critique") return request.variants.length;
  return CAPS[request.kind];
}

/**
 * How many the prompt should ask for.
 *
 * Hooks are the interesting one: the pill says "Draft a third", because what
 * the person wants is the hooks they have *not* written. Asking for three when
 * two exist and then dropping two of the three is a slower way of getting one
 * mediocre hook; asking for one and getting one is the feature.
 *
 * A caller may override with `want`, which is then held to the same cap — the
 * server action does not get to ask for two hundred titles.
 */
export function wantedFor(request: AssistRequest): number {
  if (request.kind === "thumbnail_critique") return request.variants.length;

  const cap = CAPS[request.kind];
  if (request.want !== undefined) {
    return Math.max(1, Math.min(cap, Math.floor(request.want)));
  }
  if (request.kind === "hooks") {
    const missing = HOOKS_MAX - request.existing.length;
    return Math.max(1, Math.min(cap, missing));
  }
  return request.kind === "titles" ? TITLES_WANT : CONCEPTS_WANT;
}

/* -------------------------------------------------------------------------- */
/* Tidying                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The comparison `lib/text.ts` calls "the same label": invisible characters
 * gone, padding gone, case folded. As a *key*, so a whole list can be checked
 * against a Set in one pass rather than pairwise. `clamp.test.ts` asserts this
 * agrees with `sameLabel`, so the two can never drift apart.
 */
export function comparisonKey(value: string): string {
  return cleanLabel(value).toLocaleLowerCase();
}

/** True when two suggestions would read as the same thing. `sameLabel`, renamed. */
export const readsTheSame = sameLabel;

/**
 * What the model wrote, as a single line: invisible characters out, runs of
 * whitespace collapsed, ends trimmed. Models like to return `"  Title  "` and,
 * once in a while, a title with a newline in it; neither is a different title.
 */
function tidy(value: string): string {
  return stripInvisible(value).replace(/\s+/g, " ").trim();
}

/**
 * A rationale, cut to fit. Accepting a candidate writes the rationale into that
 * candidate's `note`, and `TitleCandidateSchema` caps a note at
 * `MAX_CANDIDATE_NOTE_LENGTH` — so an over-long rationale would turn "Add as
 * candidate" into a validation error at the write path, which is precisely the
 * kind of failure this module exists to absorb. A cut note still explains; a
 * refused write does not.
 */
function fitRationale(value: string): string {
  const tidied = tidy(value);
  if (tidied.length <= MAX_CANDIDATE_NOTE_LENGTH) return tidied;
  return `${tidied.slice(0, MAX_CANDIDATE_NOTE_LENGTH - 1).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* The clamp                                                                   */
/* -------------------------------------------------------------------------- */

/** What the clamp did, for `AssistMeta` and for the sentence the panel shows. */
export interface ClampReport {
  readonly returned: number;
  readonly droppedOverflow: number;
  readonly droppedDuplicates: number;
  readonly droppedUnusable: number;
  readonly recommendationAdjusted: boolean;
}

export interface ClampedSuggestions {
  readonly suggestions: AssistSuggestion[];
  readonly recommended: number | null;
  /**
   * The model's comparative sentence, or null when it gave nothing usable or
   * when its pick did not survive. A reason for a pick that was dropped is a
   * reason about something the person cannot see, so it goes with it.
   */
  readonly recommendedReason: string | null;
  readonly report: ClampReport;
}

/**
 * A validated payload → what the panel can show.
 *
 * Order matters and is deliberate: unusable first (a blank line is not a
 * duplicate of anything), then duplicates (against what is already on the
 * video *and* within the answer itself — models repeat themselves), then the
 * cap. So the twenty that survive are twenty usable, distinct suggestions
 * rather than whichever twenty happened to arrive first.
 */
export function clampSuggestions(
  kind: SuggestionKind,
  payload: SuggestionsPayload,
  existing: readonly string[] = [],
): ClampedSuggestions {
  const limit = TEXT_LIMITS[kind];
  const cap = CAPS[kind];

  // The existing entries are tidied first: the model's `"  Already   mine "`
  // and the row's `"Already mine"` are the same title, and `comparisonKey`
  // deliberately keeps `sameLabel`'s exact semantics rather than growing a
  // second, looser comparison of its own.
  const seen = new Set(existing.map((value) => comparisonKey(tidy(value))));
  const kept: AssistSuggestion[] = [];
  /** Index in the model's original list, so a surviving pick keeps its meaning. */
  const originalIndex: number[] = [];

  let droppedDuplicates = 0;
  let droppedUnusable = 0;

  payload.suggestions.forEach((raw, index) => {
    const text = tidy(raw.text);
    if (text === "" || text.length > limit) {
      droppedUnusable += 1;
      return;
    }
    const key = comparisonKey(text);
    if (key === "" || seen.has(key)) {
      droppedDuplicates += 1;
      return;
    }
    seen.add(key);
    kept.push({ text, rationale: fitRationale(raw.rationale) });
    originalIndex.push(index);
  });

  const droppedOverflow = Math.max(0, kept.length - cap);
  const suggestions = kept.slice(0, cap);
  const survivors = originalIndex.slice(0, cap);

  const { recommended, adjusted } = pickRecommended(
    payload.recommended_index,
    survivors,
    suggestions.length,
  );

  /*
    The comparison only stands while the thing it compares is the thing that
    is marked. If the pick was dropped or out of range, `pickRecommended` falls
    back to the first survivor — an honest fallback, but not what the sentence
    was written about — so the sentence goes rather than being re-pointed at a
    proposal it was never about.
  */
  const reason = tidy(payload.recommended_reason ?? "");
  const recommendedReason =
    recommended === null || adjusted || reason === ""
      ? null
      : fitRationale(reason);

  return {
    suggestions,
    recommended,
    recommendedReason,
    report: {
      returned: payload.suggestions.length,
      droppedOverflow,
      droppedDuplicates,
      droppedUnusable,
      recommendationAdjusted: adjusted,
    },
  };
}

/**
 * The model's pick, translated.
 *
 * Three cases. It survived — point at where it ended up, and nothing was
 * adjusted. It was dropped or out of range — the list is still ranked, so the
 * first surviving suggestion is the honest fallback, and the panel is told the
 * recommendation moved. Nothing survived — there is nothing to recommend.
 */
function pickRecommended(
  raw: number,
  survivors: readonly number[],
  length: number,
): { recommended: number | null; adjusted: boolean } {
  if (length === 0) return { recommended: null, adjusted: false };

  const wanted = Number.isFinite(raw) ? Math.round(raw) : NaN;
  const position = survivors.indexOf(wanted);
  if (position !== -1) return { recommended: position, adjusted: false };
  return { recommended: 0, adjusted: true };
}

/* -------------------------------------------------------------------------- */
/* The critique                                                                */
/* -------------------------------------------------------------------------- */

/** A note is a sentence or two; this is the ceiling on "or two". */
const MAX_VERDICT_NOTE_LENGTH = 600;

export interface ClampedCritique {
  readonly verdicts: ThumbnailVerdict[];
  readonly recommendedRole: ThumbnailVerdict["role"] | null;
  readonly report: ClampReport;
}

/**
 * Verdicts, held to the variants that were actually sent.
 *
 * `role` arrives as a plain string because a schema enum would turn one stray
 * label into a whole discarded critique. Here the stray label is simply not a
 * variant anyone uploaded, so its verdict is dropped and counted, and the
 * verdicts about real images survive.
 */
export function clampCritique(
  payload: CritiquePayload,
  roles: readonly ThumbnailVerdict["role"][],
): ClampedCritique {
  const allowed = new Set<string>(roles);
  const seen = new Set<string>();
  const verdicts: ThumbnailVerdict[] = [];
  let droppedUnusable = 0;
  let droppedDuplicates = 0;

  for (const raw of payload.verdicts) {
    const role = tidy(raw.role).toLowerCase();
    if (!allowed.has(role)) {
      droppedUnusable += 1;
      continue;
    }
    if (seen.has(role)) {
      droppedDuplicates += 1;
      continue;
    }
    seen.add(role);
    const note = tidy(raw.note);
    verdicts.push({
      role: role as ThumbnailVerdict["role"],
      readsAtTileSize: raw.reads_at_tile_size,
      complementsTitle: raw.complements_title,
      note:
        note.length > MAX_VERDICT_NOTE_LENGTH
          ? `${note.slice(0, MAX_VERDICT_NOTE_LENGTH - 1).trimEnd()}…`
          : note,
    });
  }

  // Order the verdicts the way the section shows the variants, not the way the
  // model happened to list them, so the critique reads down the page.
  verdicts.sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role));

  /*
    A recommendation is kept only if it survives its own verdict.

    Two ways it does not. It can name a variant nobody uploaded, which is the
    same repair as an out-of-range index — the pick is gone. Or it can name one
    the model *itself* just said does not read at tile size, which is the one
    question the critique exists to answer: "would ship" printed directly above
    "Does not read at tile size", with a button that writes a real
    `swap_thumbnail`, is worse than no recommendation. Both are dropped and
    counted, and the panel says the pick could not be used.
  */
  const recommendedRaw = tidy(payload.recommended_role).toLowerCase();
  const named = seen.has(recommendedRaw)
    ? (recommendedRaw as ThumbnailVerdict["role"])
    : null;
  const namedVerdict = verdicts.find((verdict) => verdict.role === named);
  const contradicted = namedVerdict !== undefined && !namedVerdict.readsAtTileSize;
  const recommendedRole = contradicted ? null : named;

  return {
    verdicts,
    recommendedRole,
    report: {
      returned: payload.verdicts.length,
      droppedOverflow: 0,
      droppedDuplicates,
      droppedUnusable,
      recommendationAdjusted: recommendedRaw !== "" && recommendedRole === null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

/** What the provider knows that the payload does not. */
export interface AssembleContext {
  readonly provider: AssistMeta["provider"];
  readonly model: string;
  readonly elapsedMs: number;
  readonly servedByFallback: boolean;
}

/**
 * A validated payload → the result the app sees: clamped, counted, and carrying
 * the metadata that lets the panel explain itself.
 *
 * Both providers end here. That is the point: the fake cannot drift into
 * producing a shape the real one never would, because neither of them builds
 * an `AssistResult` by hand.
 *
 * The one thing this rejects outright is an answer with nothing *usable* in
 * it, and the emphasis is the point. Checking the payload alone was not
 * enough: an answer of twenty titles that are all duplicates of what the video
 * already has arrives full and leaves the clamp empty, and that resolved as a
 * *success* with `suggestions: []`. Two things followed from it, both bad. The
 * panel drew "0 proposals — the tool talking." over an empty list, with no
 * failure block and no retry, after somebody had waited for a call and paid
 * for it. And `app/actions/assist.ts` writes on the success path, so that
 * empty entry replaced whatever `videos.brainstorm_last` was holding — and
 * `readStoredBrainstorm` reads an empty entry as absent, so the twenty titles
 * that were kept were gone. That is the one job PLAN.md gives the column.
 *
 * It is not a corner case either: "Add all as candidates", then "Ask again",
 * is the straight line the panel is built for, and once the candidate list
 * matches the answer it repeats for as long as somebody keeps pressing.
 *
 * So the emptiness check happens *after* the clamp, it names which drop
 * emptied the list, and it throws — which means `failure()` returns before the
 * write and the kept answer survives.
 */
export function assemble(
  request: AssistRequest,
  payload: SuggestionsPayload | CritiquePayload,
  context: AssembleContext,
): AssistResult {
  const requested = wantedFor(request);

  if (request.kind === "thumbnail_critique") {
    const critique = payload as CritiquePayload;
    if (critique.verdicts.length === 0) {
      throw new AssistError("empty", {
        detail: "The critique came back with no verdicts in it.",
      });
    }
    const roles = request.variants.map((variant) => variant.role);
    const clamped = clampCritique(critique, roles);
    return {
      kind: "thumbnail_critique",
      verdicts: clamped.verdicts,
      recommendedRole: clamped.recommendedRole,
      meta: { ...context, requested, ...clamped.report },
    };
  }

  const suggestions = payload as SuggestionsPayload;
  if (suggestions.suggestions.length === 0) {
    throw new AssistError("empty", {
      detail: "The answer parsed, but its list of suggestions was empty.",
    });
  }
  const clamped = clampSuggestions(
    request.kind,
    suggestions,
    request.existing ?? [],
  );
  if (clamped.suggestions.length === 0) throw emptyAfterClamp(clamped.report);
  return {
    kind: request.kind,
    suggestions: clamped.suggestions,
    recommended: clamped.recommended,
    recommendedReason: clamped.recommendedReason,
    meta: { ...context, requested, ...clamped.report },
  };
}

/**
 * Nothing survived the clamp: a failure, with the reason it was empty.
 *
 * `empty` is retryable, so the panel already offers the button. The sentence
 * differs by cause because the two are different situations for the person:
 * an answer that was entirely repeats of their own list is one to retry after
 * changing the list, and one that was entirely unusable text is a bad answer
 * to ask for again.
 */
function emptyAfterClamp(report: ClampReport): AssistError {
  const { returned, droppedDuplicates, droppedUnusable } = report;
  if (droppedDuplicates > 0 && droppedUnusable === 0) {
    return new AssistError("empty", {
      message:
        "Everything it came back with is already on this video, so there is nothing new to offer. Accept or remove some of what you have, or ask again.",
      detail: `All ${returned} suggestions were duplicates of what the video already has.`,
    });
  }
  if (droppedUnusable > 0 && droppedDuplicates === 0) {
    return new AssistError("empty", {
      message:
        "Nothing usable came back this time — everything in the answer was blank or too long for the field. Try again.",
      detail: `All ${returned} suggestions were blank or over the column's limit.`,
    });
  }
  return new AssistError("empty", {
    message:
      "Nothing usable came back this time — everything in the answer was either already on this video or unusable. Try again.",
    detail: `All ${returned} suggestions were dropped: ${droppedDuplicates} duplicates, ${droppedUnusable} unusable.`,
  });
}
