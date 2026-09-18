import { z } from "zod";

import { TITLE_WARN_LENGTH } from "./packaging";

/**
 * Everything about a stage checklist that is a *rule* rather than a screen.
 *
 * The rows themselves are `checklist_items`, snapshot-copied from
 * `checklist_templates` by `move_video` and `capture_video` on first entry to a
 * stage (PLAN.md open question 2). Nothing in this file writes anything; it is
 * the ordering, the arithmetic and the one evidence table, kept apart from the
 * components so `/videos/[id]`, the board card and `/now` cannot each grow
 * their own answer to "which item is next" or "how many are done".
 */

/* -------------------------------------------------------------------------- */
/* The row                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One checklist row as every screen reads it.
 *
 * `createdAt` is not shown anywhere. It is here because it is the only
 * tiebreak that is stable: `checklist_items` has **no** unique on
 * `(video_id, stage_id, position)` — two custom items added in the same second
 * can legitimately share `min(position) - 1` — so `position` alone is not a
 * total order and a re-render could otherwise swap two rows.
 */
export interface ChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly position: number;
  /** `null` is a real value in the column and reads as `DEFAULT_EST_MINUTES`. */
  readonly estMinutes: number | null;
  /** When it was ticked, or null. The tick *is* this timestamp. */
  readonly checkedAt: string | null;
  readonly createdAt: string;
}

/**
 * The columns every read of `checklist_items` asks for, as one literal.
 *
 * supabase-js types a result from the select *string*, so this has to be a
 * literal rather than a concatenation — and having it in one place is what
 * keeps the detail page, the board and the server actions reading the same
 * shape into the same `ChecklistItem`.
 */
export const CHECKLIST_COLUMNS =
  "id, text, position, est_minutes, checked_at, created_at" as const;

/** The row as PostgREST hands it back. */
export interface ChecklistItemRow {
  id: string;
  text: string;
  position: number;
  est_minutes: number | null;
  checked_at: string | null;
  created_at: string;
}

/** `checklist_items` row → the shape every screen renders. */
export function readChecklistItem(row: ChecklistItemRow): ChecklistItem {
  return {
    id: row.id,
    text: row.text,
    position: row.position,
    estMinutes: row.est_minutes,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
  };
}

/**
 * What `checklist_items.est_minutes` means when it is NULL.
 *
 * PLAN.md says so twice — in the data model ("null reads as 10") and in the
 * `/now` filter ("uses `est_minutes`, null = 10") — and the "≤ 10 min" filter
 * is the reason it matters: a custom item with no estimate has to land
 * somewhere, and ten minutes is the seed's own middle.
 */
export const DEFAULT_EST_MINUTES = 10;

export function estMinutesOf(item: ChecklistItem): number {
  return item.estMinutes ?? DEFAULT_EST_MINUTES;
}

export function isChecked(item: ChecklistItem): boolean {
  return item.checkedAt !== null;
}

/**
 * The list's order: `position` ascending, then oldest first, then id.
 *
 * Ascending and not "unticked first": the checklist is a *procedure* — film the
 * thumbnail shots before you back the footage up — and re-sorting it as it is
 * ticked would move the row under the cursor of whoever is ticking. A custom
 * item is put at the top by giving it `min(position) - 1`, which is a smaller
 * number, not a different rule.
 */
export function compareItems(a: ChecklistItem, b: ChecklistItem): number {
  if (a.position !== b.position) return a.position - b.position;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return [...items].sort(compareItems);
}

/**
 * The position a new custom item takes so it is the next action.
 *
 * Typed on `position` alone rather than on `ChecklistItem`, because the server
 * action that needs this number reads *only* the positions — the rows
 * themselves would be a second copy of the list fetched to compute one integer.
 */
export function topPosition(items: readonly { position: number }[]): number {
  if (items.length === 0) return 1;
  return Math.min(...items.map((item) => item.position)) - 1;
}

/* -------------------------------------------------------------------------- */
/* What a custom item may say                                                  */
/* -------------------------------------------------------------------------- */

/** A row on a list, not a note. Twice the length of the longest seeded item. */
export const MAX_ITEM_LENGTH = 300;

/**
 * The rule for a custom item's text, in the one place both halves can import.
 *
 * `app/actions/checklist.ts` is a `"use server"` module and may only export
 * async functions, so a constant declared there is unreachable from the box
 * that enforces it — which is how a `maxLength` on an input and a `max()` on a
 * schema drift apart.
 */
export const ChecklistItemTextSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, "Give the item some words — it is the next thing you will do.")
      .max(
        MAX_ITEM_LENGTH,
        `Keep a checklist item to ${MAX_ITEM_LENGTH} characters — it is a row on a list, not the script.`,
      ),
  );

/* -------------------------------------------------------------------------- */
/* The ratio                                                                   */
/* -------------------------------------------------------------------------- */

export interface ChecklistProgress {
  readonly done: number;
  readonly total: number;
}

export function progressOf(items: readonly ChecklistItem[]): ChecklistProgress {
  let done = 0;
  for (const item of items) if (isChecked(item)) done += 1;
  return { done, total: items.length };
}

/**
 * The first unticked row in list order, or null when there is none.
 *
 * Null means two different things and neither of them is "nothing to do", which
 * is why `progressOf` is always read beside it: *zero items* is a stage with no
 * checklist, and *all ticked* is a stage that is finished. PLAN.md's ranking
 * rule 6 says the same thing from the other side — "Zero items is not 'all
 * checked'".
 */
export function nextItem(items: readonly ChecklistItem[]): ChecklistItem | null {
  for (const item of sortItems(items)) {
    if (!isChecked(item)) return item;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The fields a checklist row can be *measured* against.
 *
 * Read off the video the list belongs to, on the server, and handed down. The
 * numbers are the ones the packaging block already shows in its own controls,
 * so a row and its field can never disagree about how many candidates exist.
 */
export interface EvidenceFacts {
  /** `videos.title`, trimmed length. */
  readonly titleLength: number;
  /** How many title candidates the row holds. */
  readonly candidateCount: number;
  /** How many hooks are written (not how many are chosen). */
  readonly hookCount: number;
}

export interface Evidence {
  /** Short, measured, and rendered in the mono face. */
  readonly label: string;
  /** A rule is being broken right now — the only case that takes colour. */
  readonly overLimit: boolean;
  /** The long form, for `title`: what was counted and why it is beside this row. */
  readonly detail: string;
}

/**
 * How many hooks the brief asks for. The column CHECK caps `hooks` at 3 and
 * the seeded row says "drafted in 3 versions"; this is that number, named.
 */
export const HOOK_TARGET = 3;

/** How many title candidates the seeded row asks for at the low end. */
export const CANDIDATE_TARGET = 10;

/**
 * The whole mapping from a checklist row to something the app can count.
 *
 * **One table, deliberately.** The alternative — an `if` beside each row in the
 * markup — is how three screens end up counting candidates three ways, and how
 * a renamed template row silently keeps a count that no longer describes it.
 *
 * Matched on the row's *text* rather than on an id, because a
 * `checklist_items` row is a snapshot with no link back to the template it came
 * from (PLAN.md open question 2: no `template_item_id` in v1). The patterns are
 * deliberately loose enough to survive a lightly reworded template and specific
 * enough not to fire on a neighbouring row: "Hook scripted word-for-word" in
 * Scripting must not be counted as the packaging hook row, which is why that
 * pattern insists on the word *versions*.
 *
 * Nothing here ticks anything. PLAN.md review item 21 leaves auto-tick out of
 * v1 on purpose: the app can say *you have written two hooks*, and only the
 * person can say *the strongest is picked*.
 */
const EVIDENCE_TABLE: readonly {
  readonly match: RegExp;
  readonly read: (facts: EvidenceFacts) => Evidence;
}[] = [
  {
    // "Generated 10–20 title candidates, not 3"
    match: /title candidates/i,
    read: (facts) => ({
      label: `${facts.candidateCount} written`,
      overLimit: false,
      detail:
        facts.candidateCount === 1
          ? "1 title candidate is on this video"
          : `${facts.candidateCount} title candidates are on this video` +
            (facts.candidateCount < CANDIDATE_TARGET
              ? ` — the row asks for ${CANDIDATE_TARGET}–20`
              : ""),
    }),
  },
  {
    // "Title under 55 characters"
    match: /under \d+ characters/i,
    read: (facts) => ({
      label: `${facts.titleLength}/${TITLE_WARN_LENGTH}`,
      overLimit: facts.titleLength > TITLE_WARN_LENGTH,
      detail: `The working title is ${facts.titleLength} characters; this row asks for ${TITLE_WARN_LENGTH} or fewer`,
    }),
  },
  {
    // "Hook drafted in 3 versions, strongest picked"
    match: /hook.*versions/i,
    read: (facts) => ({
      label: `${facts.hookCount}/${HOOK_TARGET} written`,
      overLimit: false,
      detail:
        facts.hookCount === 1
          ? "1 hook is written on this video"
          : `${facts.hookCount} hooks are written on this video`,
    }),
  },
];

/**
 * The evidence for one row, or null when the app cannot count what it asks
 * about — which is most rows, and is the honest answer for them.
 */
export function evidenceFor(
  text: string,
  facts: EvidenceFacts,
): Evidence | null {
  for (const rule of EVIDENCE_TABLE) {
    if (rule.match.test(text)) return rule.read(facts);
  }
  return null;
}
