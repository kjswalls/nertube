import { z } from "zod";

import { ChecklistItemTextSchema, DEFAULT_EST_MINUTES } from "./checklist";
import type { StageKind } from "./defaults";
import { NEEDS_A_BLOCK, QUICK_MINUTES } from "./next-action";
import {
  comparePositioned,
  isPermutationOf,
  movedByPosition,
  nextPosition,
  renumber,
  sortByPosition,
  type MoveDirection,
} from "./ordering";

// The order arithmetic is `lib/ordering.ts`'s, shared with the stages and
// bucket editors; re-exported under the names this editor has always used.
export { isPermutationOf, nextPosition, renumber };

/**
 * Everything about a stage's checklist *template* that is a rule rather than a
 * screen.
 *
 * A template is what `move_video` and `capture_video` copy onto a video the
 * first time it enters a stage (PLAN.md open question 2). After the copy the
 * two are strangers: `checklist_items` rows carry no reference back to the
 * template row they came from, and nothing in the schema — no trigger, no FK —
 * can carry an edit here across to a list somebody is already ticking. That
 * one-way boundary is the whole reason the settings editor is safe to use on a
 * Tuesday evening, and the reason every sentence it prints says *the next
 * video*.
 *
 * Nothing in this file writes anything. It is the row shape, the two input
 * rules, and the arithmetic the editor shows beside a stage so that a change
 * to an estimate is visibly a change to something.
 */

/* -------------------------------------------------------------------------- */
/* The row                                                                     */
/* -------------------------------------------------------------------------- */

export interface TemplateItem {
  readonly id: string;
  readonly stageId: string;
  readonly text: string;
  readonly position: number;
  /** `not null` on the template; the copy on a video may still be null. */
  readonly estMinutes: number;
}

/**
 * The columns every read of `checklist_templates` asks for, as one literal —
 * supabase-js types a result from the select *string*, so a concatenation
 * would not be a literal type to read.
 */
export const TEMPLATE_COLUMNS =
  "id, stage_id, text, position, est_minutes" as const;

/** The row as PostgREST hands it back. */
export interface TemplateRow {
  id: string;
  stage_id: string;
  text: string;
  position: number;
  est_minutes: number;
}

export function readTemplateItem(row: TemplateRow): TemplateItem {
  return {
    id: row.id,
    stageId: row.stage_id,
    text: row.text,
    position: row.position,
    estMinutes: row.est_minutes,
  };
}

/** Template order: `position` ascending, then id (`lib/ordering.ts`). */
export const compareTemplates: (a: TemplateItem, b: TemplateItem) => number = comparePositioned;

export function sortTemplates(items: readonly TemplateItem[]): TemplateItem[] {
  return sortByPosition(items);
}

/* -------------------------------------------------------------------------- */
/* What a template row may say                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The text rule is the *same* rule a custom item on a video obeys — one
 * schema, imported, so a template row can never be something the copy of it
 * would have refused.
 */
export const TemplateTextSchema = ChecklistItemTextSchema;

/**
 * A working day. An estimate is what `/now` uses to decide whether a row fits
 * the ten minutes a person has; anything beyond one sitting is not an estimate
 * of a checklist item, it is a description of a project.
 */
export const MAX_EST_MINUTES = 480;

export const EstMinutesSchema = z
  .number({ error: "Give the item an estimate in whole minutes." })
  .int("Minutes, not fractions of one.")
  .min(1, "An item that takes no time is not an item — remove it instead.")
  .max(
    MAX_EST_MINUTES,
    `Keep an estimate under ${MAX_EST_MINUTES} minutes — a checklist item is one sitting, not a week.`,
  );

/**
 * What a number box holds when nobody has typed in it: the same ten minutes a
 * `checklist_items` row with no estimate reads as, so the two defaults cannot
 * drift apart.
 */
export const DEFAULT_TEMPLATE_MINUTES = DEFAULT_EST_MINUTES;

/* -------------------------------------------------------------------------- */
/* The cost                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The honest answer to "how long does this stage take me": the sum of the
 * estimates, in minutes. Zero for a stage with no template.
 */
export function stageMinutes(items: readonly { estMinutes: number }[]): number {
  let total = 0;
  for (const item of items) total += item.estMinutes;
  return total;
}

/**
 * Minutes as a person reads them: `45 min`, `1 h`, `1 h 20`.
 *
 * Whole hours drop the minutes rather than printing `1 h 0`; under an hour is
 * plain minutes so the small numbers — which are the ones the ten-minute filter
 * is about — stay legible as minutes.
 */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
}

/**
 * Whether `/now` will list a video whose next unticked item this is under
 * "10 minutes or less".
 *
 * Two of the three tests `matchesFilters` makes, in the same order and with
 * the same constants: the stage's kind (Filming and Editing need a block, so
 * nothing in them is ever quick, however short the item claims to be) and the
 * estimate against `QUICK_MINUTES`. The third — Waiting rows are hidden — is a
 * fact about a video, not about a template, and has no answer here.
 */
export function fitsTenMinutes(
  estMinutes: number,
  stageKind: StageKind | null,
): boolean {
  if (stageKind !== null && NEEDS_A_BLOCK.includes(stageKind)) return false;
  return estMinutes <= QUICK_MINUTES;
}

/**
 * How many of a stage's rows the quick filter would let through, so the
 * editor can say "4 of 8 fit a ten-minute slot" beside the total.
 */
export function quickCount(
  items: readonly { estMinutes: number }[],
  stageKind: StageKind | null,
): number {
  let count = 0;
  for (const item of items) {
    if (fitsTenMinutes(item.estMinutes, stageKind)) count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Reorder                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The list with one row moved one step up or down, renumbered 1..n, or `null`
 * when the move is off the end — so the caller has a complete assignment to
 * send as one statement. Pure, so the editor can show the result before the
 * write lands.
 */
export function moveTemplate(
  items: readonly TemplateItem[],
  id: string,
  direction: MoveDirection,
): TemplateItem[] | null {
  return movedByPosition(items, id, direction);
}
