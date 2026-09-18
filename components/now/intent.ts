/**
 * What a row's control asks for when somebody finishes it.
 *
 * The row renders the control; the list performs the write and re-ranks. Two
 * reasons the intent is a value rather than a callback per control:
 *
 * 1. **One place does the writing.** Nine controls calling five server actions
 *    from inside nine components is nine places to forget the pending state,
 *    the toast and the patch that re-ranks the video.
 * 2. **The keyboard can reach it.** `x` completes the *selected* row without
 *    that row being focused, which means the list has to be able to produce the
 *    intent itself — see `defaultIntent` below.
 */

import type { NowRow } from "@/lib/next-action";

export type NowIntent =
  /** Rule 6: tick the checklist item this row named. */
  | { readonly kind: "tick" }
  /** Rules 1 and 7: write `title` or `thumbnail_concept`. */
  | { readonly kind: "text"; readonly value: string }
  /** Rules 1 and 7: mark one hook chosen. */
  | { readonly kind: "choose-hook"; readonly hookId: string }
  /** Rule 2: the pair, never one half. */
  | { readonly kind: "metrics"; readonly impressions: number; readonly ctr: number }
  /** Rule 5: record the URL and move into Published, stamped with the target date. */
  | { readonly kind: "confirm-live"; readonly url: string }
  /** Rule 4: `waiting_on` cleared. */
  | { readonly kind: "unblocked" }
  /**
   * Rule 4's other button. **Writes nothing.** "Still waiting" is an
   * acknowledgement — the block is real and has not moved — so it takes the row
   * off this session's list and leaves the column alone. A write here would
   * either reset `waiting_since` (losing the age that is the whole point of the
   * section) or invent a "snoozed until" column PLAN.md does not have.
   */
  | { readonly kind: "still-waiting" }
  /** Rule 3's "keep it": sets `swap_dismissed_at`. */
  | { readonly kind: "keep-thumbnail" }
  /** Rule 8: `move_video` to the next enabled stage. */
  | { readonly kind: "move" };

/**
 * The intent the `x` key produces for a row, or null when the row needs
 * something typed or chosen first.
 *
 * `x` is "complete this row", and it only does so where completion is
 * unambiguous and needs no input: a tick and a move. For everything else it
 * would be guessing — which hook, which number, which words — so the list puts
 * the caret in the row's control instead. That is the same two keystrokes
 * without the guess, and it is the difference between a shortcut and a
 * hazard: `x` must never silently make a judgement (dismiss a swap prompt,
 * declare a block over) on a row the user has not read.
 */
export function defaultIntent(row: NowRow): NowIntent | null {
  switch (row.input) {
    case "tick":
      return { kind: "tick" };
    case "move":
      return { kind: "move" };
    default:
      return null;
  }
}
