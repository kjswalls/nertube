import { inBucket } from "@/lib/buckets";

import type { Idea, IdeaBucket, IdeaFilters } from "./types";

/**
 * The bank's filtering, as a pure function — and, more importantly, the
 * sentence it says when the filters have emptied the list.
 *
 * ## Why the empty state is a function and not a string in the JSX
 *
 * The task the brief sets is *"an empty result says which filter emptied it
 * rather than showing a bare 'nothing here'"*, and that is an arithmetic claim,
 * not a wording choice. With four filters combining there are three genuinely
 * different reasons a list can be empty, and they need three different
 * sentences:
 *
 * 1. **One filter is empty on its own.** Nothing in this channel is tagged
 *    "gear", whatever else is switched on. Naming the other filters would send
 *    the reader to turn off the ones that are innocent.
 * 2. **Every filter matches something, but not the same something.** There are
 *    tutorials and there are money ideas, and no money tutorial. Naming a
 *    single filter here would be a lie — *any* of them would restore results.
 * 3. **The bank is empty before any filter runs.** Not a filter problem at all,
 *    and the answer is "capture one", not "turn a filter off".
 *
 * Telling those apart means running each criterion alone against the pool,
 * which is a loop with an off-by-one in it, which is a thing to unit-test
 * rather than to eyeball. `filtering.test.ts` is that test.
 *
 * Archived ideas are a *scope*, not a criterion: they are excluded before any
 * of this runs, and the explanation mentions them only to say that turning the
 * scope on would find some — which is the one case where "nothing matches" is
 * actively misleading.
 */

/* -------------------------------------------------------------------------- */
/* Criteria                                                                    */
/* -------------------------------------------------------------------------- */

export type IdeaCriterionKind = "search" | "tag" | "vertical" | "horizontal";

/** Names for the ids in `IdeaFilters`, so a sentence can use words. */
export interface FilterLabels {
  readonly verticals: readonly IdeaBucket[];
  readonly horizontals: readonly IdeaBucket[];
}

interface Criterion {
  readonly kind: IdeaCriterionKind;
  /** Is this filter switched on at all? */
  readonly active: (filters: IdeaFilters) => boolean;
  /** Does this one idea satisfy it, ignoring every other filter? */
  readonly test: (idea: Idea, filters: IdeaFilters) => boolean;
  /** "is tagged “gear”" — the predicate form, for sentence 1. */
  readonly predicate: (filters: IdeaFilters, labels: FilterLabels) => string;
  /** "the tag “gear”" — the noun form, for sentence 2. */
  readonly noun: (filters: IdeaFilters, labels: FilterLabels) => string;
}

/** `“gear”`, with the curly quotes the rest of the interface uses. */
function quoted(value: string): string {
  return `“${value}”`;
}

function nameOf(buckets: readonly IdeaBucket[], id: string | null): string {
  if (id === null) return "";
  return buckets.find((bucket) => bucket.id === id)?.name ?? "that bucket";
}

/**
 * Order matters only for the wording: a sentence naming two filters reads in
 * this order, which is the order the controls are drawn in.
 */
const CRITERIA: readonly Criterion[] = [
  {
    kind: "search",
    active: (filters) => filters.search.trim() !== "",
    test: (idea, filters) => {
      const needle = filters.search.trim().toLowerCase();
      if (needle === "") return true;
      // Title and one-line hook, which is what the brief says the search is
      // over. Notes are deliberately not searched: they are the long field, and
      // a search that matched them would return rows whose visible text does
      // not contain the word typed.
      return (
        idea.title.toLowerCase().includes(needle) ||
        (idea.oneLineHook ?? "").toLowerCase().includes(needle)
      );
    },
    predicate: (filters) => `matches ${quoted(filters.search.trim())}`,
    noun: (filters) => quoted(filters.search.trim()),
  },
  {
    kind: "tag",
    active: (filters) => filters.tag !== null,
    test: (idea, filters) =>
      filters.tag === null || idea.tags.includes(filters.tag),
    predicate: (filters) => `is tagged ${quoted(filters.tag ?? "")}`,
    noun: (filters) => `the tag ${quoted(filters.tag ?? "")}`,
  },
  {
    kind: "vertical",
    active: (filters) => filters.verticalId !== null,
    // `inBucket` and not `idea.verticalId === filters.verticalId`: the matrix
    // decides the same thing about the same rows, and the two must not be able
    // to drift. See `lib/buckets.ts` and `components/ideas/agreement.test.ts`.
    test: (idea, filters) => inBucket(idea, "vertical", filters.verticalId),
    predicate: (filters, labels) =>
      `is in the vertical ${quoted(nameOf(labels.verticals, filters.verticalId))}`,
    noun: (filters, labels) =>
      `the vertical ${quoted(nameOf(labels.verticals, filters.verticalId))}`,
  },
  {
    kind: "horizontal",
    active: (filters) => filters.horizontalId !== null,
    test: (idea, filters) => inBucket(idea, "horizontal", filters.horizontalId),
    predicate: (filters, labels) =>
      `is in the horizontal ${quoted(nameOf(labels.horizontals, filters.horizontalId))}`,
    noun: (filters, labels) =>
      `the horizontal ${quoted(nameOf(labels.horizontals, filters.horizontalId))}`,
  },
];

/** How many of the four filters are switched on. */
export function activeFilterCount(filters: IdeaFilters): number {
  return CRITERIA.filter((criterion) => criterion.active(filters)).length;
}

/** The archived scope, which is applied before any criterion. */
export function inScope(idea: Idea, filters: IdeaFilters): boolean {
  return filters.includeArchived || idea.archivedAt === null;
}

/** Every switched-on criterion, ANDed. The scope is *not* part of this. */
export function matchesFilters(idea: Idea, filters: IdeaFilters): boolean {
  return CRITERIA.every(
    (criterion) => !criterion.active(filters) || criterion.test(idea, filters),
  );
}

/** Scope and criteria together: what the list actually renders. */
export function visibleIdeas(
  ideas: readonly Idea[],
  filters: IdeaFilters,
): Idea[] {
  return ideas.filter(
    (idea) => inScope(idea, filters) && matchesFilters(idea, filters),
  );
}

/* -------------------------------------------------------------------------- */
/* The empty state                                                             */
/* -------------------------------------------------------------------------- */

/** `["a", "b", "c"]` → `"a, b and c"`. */
function conjoin(parts: readonly string[], word: "and" | "or"): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} ${word} ${parts[parts.length - 1]}`;
}

/**
 * Why the list in front of the reader is empty, in one sentence.
 *
 * `ideas` is the **whole** bank, archived rows included — the archived ones are
 * what the last clause is about. Call this only when
 * `visibleIdeas(ideas, filters)` is empty; it assumes so.
 */
export function explainEmpty(
  ideas: readonly Idea[],
  filters: IdeaFilters,
  labels: FilterLabels,
): string {
  const pool = ideas.filter((idea) => inScope(idea, filters));
  const active = CRITERIA.filter((criterion) => criterion.active(filters));

  /*
    How many archived ideas the filters *would* have matched. Only ever used as
    a trailing clause: "nothing matches" is a misleading thing to tell somebody
    whose match is sitting one toggle away.
  */
  const archivedMatches =
    filters.includeArchived || active.length === 0
      ? 0
      : ideas.filter(
          (idea) => idea.archivedAt !== null && matchesFilters(idea, filters),
        ).length;

  const archivedClause =
    archivedMatches === 0
      ? ""
      : ` ${archivedMatches} archived ${archivedMatches === 1 ? "idea does" : "ideas do"} — turn on "Show archived" to see ${archivedMatches === 1 ? "it" : "them"}.`;

  // Reason 3: nothing to filter in the first place.
  if (pool.length === 0) {
    if (active.length === 0) {
      return ideas.length === 0
        ? "This bank is empty. Press c to capture an idea — a title is enough."
        : `Every idea in this bank is archived.${archivedClause}`;
    }
    return `This bank is empty, so no filter can find anything in it.${archivedClause}`;
  }

  if (active.length === 0) {
    // Nothing is filtering and the pool is not empty, so the caller should not
    // have been here. Say something true rather than something confident.
    return "Nothing to show.";
  }

  // Reason 1: one or more filters match nothing at all on their own. Each of
  // those is sufficient on its own, so all of them are named.
  const lonely = active.filter(
    (criterion) => !pool.some((idea) => criterion.test(idea, filters)),
  );

  if (lonely.length > 0) {
    const phrases = lonely.map((criterion) =>
      criterion.predicate(filters, labels),
    );
    return `No idea in this bank ${conjoin(phrases, "or")}.${archivedClause}`;
  }

  // Reason 2: each filter has matches, but no idea has all of them.
  const nouns = active.map((criterion) => criterion.noun(filters, labels));
  return `Each filter finds something on its own, but no idea has ${conjoin(nouns, "and")} together.${archivedClause}`;
}
