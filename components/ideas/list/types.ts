/**
 * What one row of the idea bank is, as the server hands it to the browser.
 *
 * An idea IS a video in the Idea stage — there is no second table and no second
 * shape. What makes this its own type rather than a reuse of
 * `components/board/types.ts`'s `BoardCard` is that the two views ask different
 * questions of the same row: a card asks "is this moving?" (days in stage, the
 * checklist ratio, the target date), and a bank row asks "is this worth
 * making?" (the hook, the tags, the two buckets, and how long it has been sat
 * there). Sharing one type would mean every card carrying four fields it never
 * draws, and every bank row carrying five.
 *
 * Every clock-derived string is computed on the server and passed down as text,
 * for the reason `components/video-detail/age.ts` gives at length: a component
 * that reads `Date.now()` while rendering produces one answer on the server and
 * a different one in the browser a moment later, and React calls that a
 * hydration mismatch.
 */

/** A bucket, as a filter option and as the name a row draws. */
export interface IdeaBucket {
  readonly id: string;
  readonly name: string;
}

export interface Idea {
  readonly id: string;
  /** As captured. May be empty — `capture_video` defaults `title` to `''`. */
  readonly title: string;
  readonly oneLineHook: string | null;
  readonly tags: readonly string[];
  readonly verticalId: string | null;
  readonly horizontalId: string | null;
  /** Resolved on the server, so a row never has to carry the bucket list. */
  readonly verticalName: string | null;
  readonly horizontalName: string | null;
  /**
   * How long it has been sitting in the Idea stage, in words — `formatAge` over
   * `stage_entered_at`, which for a captured idea is its capture time and for a
   * video that was moved back down is when it came back.
   */
  readonly ageLabel: string | null;
  /** The capture date, for the age chip's tooltip. */
  readonly capturedLabel: string | null;
  readonly archivedAt: string | null;
  /** `created_at` in milliseconds: the list is newest-captured first. */
  readonly capturedMs: number;
}

/**
 * The four filters, plus the archived scope.
 *
 * Every one of them is a single value rather than a list. "Filters combine"
 * means *across* the four — a tag and a vertical and a search — which is the
 * combination the brief's matrix thinking implies; two tags at once would be a
 * second combinator (and or or?) for a bank of a few hundred rows.
 */
export interface IdeaFilters {
  /** Free text over title and one-line hook. */
  readonly search: string;
  readonly tag: string | null;
  readonly verticalId: string | null;
  readonly horizontalId: string | null;
  /**
   * Archived ideas are dismissed, not deleted. Off by default: the bank is what
   * is still live. On, they come back with a Restore button, which is what
   * makes archiving safe to do quickly.
   */
  readonly includeArchived: boolean;
}

export const NO_IDEA_FILTERS: IdeaFilters = {
  search: "",
  tag: null,
  verticalId: null,
  horizontalId: null,
  includeArchived: false,
};
