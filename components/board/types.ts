import type { StageKind } from "@/lib/defaults";

/**
 * The shapes the board page hands to the client board, and the ordering rules
 * that go with them.
 *
 * Everything here is plain data: the server component does the querying, the
 * date formatting and the "days in stage" arithmetic, and passes the result
 * down. Two reasons, both load-bearing:
 *
 * 1. **Hydration.** `days in stage` and a formatted date both depend on the
 *    clock and the locale. Computed on the server and passed as a string/number
 *    they are the same on both sides of hydration; computed in the component
 *    they are a mismatch waiting to happen.
 * 2. **The client owns positions, not facts.** A drag changes `stageId` and
 *    nothing else, so the card can keep every other field exactly as the server
 *    sent it.
 */

/** One column. `kind` is null for a user-added, inert stage. */
export interface BoardStage {
  readonly id: string;
  readonly name: string;
  readonly kind: StageKind | null;
  readonly position: number;
}

/** One card. */
export interface BoardCard {
  readonly id: string;
  /** `videos.title`; may be empty — a captured idea can have no title yet. */
  readonly title: string;
  readonly stageId: string;
  /** ISO timestamp. Replaced client-side by the value `move_video` stamps. */
  readonly stageEnteredAt: string;
  /** Whole days since `stageEnteredAt`, floored. 0 on the day of the move. */
  readonly daysInStage: number;
  /** `videos.target_publish_date`, already formatted for display, or null. */
  readonly targetPublishLabel: string | null;
  /** The raw `YYYY-MM-DD`, which is what the sort compares. */
  readonly targetPublishDate: string | null;
  /**
   * Storage path of the concept sketch, or null. The card renders a marked
   * empty slot for it — the signed-URL `<img>` is another agent's M1 work.
   */
  readonly thumbnailConceptPath: string | null;
  /** `packaging_skipped_at is not null` — the permanent amber badge. */
  readonly packagingSkipped: boolean;
  /** `videos.waiting_on`, shown as a chip. */
  readonly waitingOn: string | null;
  /**
   * `coalesce(updated_at, created_at)` in epoch milliseconds. Only the Idea
   * column reads it: it shows the 10 most recently updated and counts the rest.
   */
  readonly recencyMs: number;
}

/**
 * The board's card order, from PLAN.md: *cards sort by `target_publish_date`
 * asc nulls last, then `stage_entered_at` asc*. There is no intra-column
 * ordering to drag against — the order is derived, so a card's position in a
 * column is never something the user has to maintain.
 *
 * `id` is the final tiebreak so the order is total and a re-render never
 * reshuffles two otherwise identical cards.
 */
export function compareCards(a: BoardCard, b: BoardCard): number {
  if (a.targetPublishDate !== b.targetPublishDate) {
    if (a.targetPublishDate === null) return 1; // nulls last
    if (b.targetPublishDate === null) return -1;
    // `YYYY-MM-DD` sorts correctly as text.
    return a.targetPublishDate < b.targetPublishDate ? -1 : 1;
  }

  if (a.stageEnteredAt !== b.stageEnteredAt) {
    return a.stageEnteredAt < b.stageEnteredAt ? -1 : 1;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Most recently updated first; the Idea column's cap uses this. */
export function compareRecency(a: BoardCard, b: BoardCard): number {
  if (a.recencyMs !== b.recencyMs) return b.recencyMs - a.recencyMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How many Idea cards the board shows (PLAN.md: *the Idea column shows the 10
 * most recently updated ideas with "+K more in Ideas"*). The bank is a bank,
 * not a queue; rendering all of it would make the one column that never needs
 * attention the tallest thing on the page.
 */
export const IDEA_COLUMN_LIMIT = 10;

/**
 * The cross-channel Filming count at which the board suggests a batch day
 * (PLAN.md: *badge when Filming count across all channels ≥ 3*).
 */
export const FILMING_BATCH_THRESHOLD = 3;

/** Published/Repurposed cards drop off the board this long after publishing. */
export const PUBLISHED_CARD_TTL_DAYS = 30;
