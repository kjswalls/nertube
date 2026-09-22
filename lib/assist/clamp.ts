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

  return {
    suggestions,
    recommended,
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

  const recommendedRaw = tidy(payload.recommended_role).toLowerCase();
  const recommendedRole = seen.has(recommendedRaw)
    ? (recommendedRaw as ThumbnailVerdict["role"])
    : null;

  return {
    verdicts,
    recommendedRole,
    report: {
      returned: payload.verdicts.length,
      droppedOverflow: 0,
      droppedDuplicates,
      droppedUnusable,
      // A recommendation naming a variant nobody uploaded is the same repair
      // as an out-of-range index: the pick is gone, and the panel should say so.
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
 * The one thing this rejects outright is an answer with nothing in it. An
 * empty list is not something to clamp — there is no work to keep — and a
 * panel that opens on nothing with no explanation is worse than a sentence
 * saying the model came back empty.
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
  return {
    kind: request.kind,
    suggestions: clamped.suggestions,
    recommended: clamped.recommended,
    meta: { ...context, requested, ...clamped.report },
  };
}
