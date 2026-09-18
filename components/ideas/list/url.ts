import { NO_IDEA_FILTERS, type IdeaBucket, type IdeaFilters } from "./types";

/**
 * The bank's filters as a URL, and back again.
 *
 * ## Why the filters are in the URL at all
 *
 * Three things wanted the same thing and none of them could have it while the
 * filter state lived only in React:
 *
 * 1. A filtered bank could not be sent to anybody or bookmarked — the address
 *    bar said `/c/pennies/ideas` whether you were looking at 140 rows or 2.
 * 2. Reloading, or coming back from a video, dropped the filters silently.
 * 3. The matrix had nowhere to point. A cell knows two bucket ids and wants to
 *    say "the ones still in the bank are over here"; with no way to express
 *    that as an address, M5's two halves stayed two pages that happened to
 *    count the same rows. `components/ideas/matrix/cell-panel.tsx` now links
 *    through `ideaBankHref` below.
 *
 * ## One place that names the parameters
 *
 * The route parses them, the filter bar writes them back as the user types, and
 * the matrix builds them from a cell. Three call sites, so the names are
 * defined once here — the same discipline `components/ideas/matrix/cell.tsx`
 * applies to `/capture`'s `vertical` and `horizontal`, which are deliberately
 * spelled the same way as these.
 */
export const IDEA_PARAM = {
  search: "q",
  tag: "tag",
  vertical: "vertical",
  horizontal: "horizontal",
  archived: "archived",
} as const;

/** How a value is read out of whatever is holding the query string. */
export type ParamLookup = (key: string) => string | null | undefined;

/**
 * A lookup over Next's `searchParams` object, which hands back
 * `string | string[] | undefined` — `?tag=a&tag=b` is a URL somebody can type,
 * and the first value is the one that wins.
 */
export function lookupOf(
  raw: Record<string, string | string[] | undefined>,
): ParamLookup {
  return (key) => {
    const value = raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
}

/**
 * The filters a query string is asking for.
 *
 * `buckets` is what makes this safe to call on a pasted URL: a bucket id is
 * resolved against the ones this channel actually has on that axis, and an
 * unknown id is dropped rather than becoming a filter that matches nothing and
 * explains itself as "that bucket". Dropping it means a stale link degrades to
 * the unfiltered bank, which is the honest answer to "this filter no longer
 * exists".
 */
export function readIdeaFilters(
  get: ParamLookup,
  buckets: {
    readonly verticals: readonly IdeaBucket[];
    readonly horizontals: readonly IdeaBucket[];
  },
): IdeaFilters {
  const known = (
    list: readonly IdeaBucket[],
    value: string | null | undefined,
  ): string | null =>
    value && list.some((bucket) => bucket.id === value) ? value : null;

  const tag = get(IDEA_PARAM.tag);

  return {
    search: get(IDEA_PARAM.search) ?? "",
    // A tag is free text with no catalogue to check it against, so an unknown
    // one stays on: it is a filter that finds nothing, and `explainEmpty` says
    // exactly that in words.
    tag: tag === undefined || tag === null || tag === "" ? null : tag,
    verticalId: known(buckets.verticals, get(IDEA_PARAM.vertical)),
    horizontalId: known(buckets.horizontals, get(IDEA_PARAM.horizontal)),
    includeArchived: get(IDEA_PARAM.archived) === "1",
  };
}

/**
 * The query string for a set of filters, with the defaults left out.
 *
 * Omitting defaults is what keeps the address bar quiet: the unfiltered bank is
 * `/c/pennies/ideas`, not `/c/pennies/ideas?q=&tag=&archived=0`, so a URL with
 * anything in it is a URL that is filtering.
 */
export function ideaFilterQuery(filters: IdeaFilters): string {
  const params = new URLSearchParams();
  const search = filters.search.trim();
  if (search !== "") params.set(IDEA_PARAM.search, search);
  if (filters.tag !== null) params.set(IDEA_PARAM.tag, filters.tag);
  if (filters.verticalId !== null) {
    params.set(IDEA_PARAM.vertical, filters.verticalId);
  }
  if (filters.horizontalId !== null) {
    params.set(IDEA_PARAM.horizontal, filters.horizontalId);
  }
  if (filters.includeArchived) params.set(IDEA_PARAM.archived, "1");
  return params.toString();
}

/** `/c/<slug>/ideas` with those filters on it. */
export function ideaBankHref(
  slug: string,
  filters: Partial<IdeaFilters>,
): string {
  const query = ideaFilterQuery({ ...NO_IDEA_FILTERS, ...filters });
  return query === "" ? `/c/${slug}/ideas` : `/c/${slug}/ideas?${query}`;
}
