/**
 * The arithmetic behind every reorder in the settings area, once.
 *
 * Three editors — stages, buckets, checklist templates — each reorder a list
 * of rows that carry a `position`, and M7's three slices each wrote the same
 * five functions: sort by position, find the next position, swap one step,
 * renumber 1..n, and "is this name already taken". The integration pass
 * unified the button; this unifies what the button does. Every helper is
 * pure, so the editors can show the result before the write lands and the
 * unit tests can check the arithmetic without a database.
 *
 * `position` is display order, never behaviour (PLAN.md: *order of behaviour
 * is `CORE_KIND_ORDER` in code, never `position`*). Nothing here knows what
 * a row means; the order rule that does — a core stage never crosses another
 * — is `canMove` in `lib/stage-settings.ts`, which judges the list `moved`
 * hands back.
 */

import { sameLabel } from "./text";

export type MoveDirection = "up" | "down";

/** The least a row has to be for the order helpers to move it. */
export interface Positioned {
  readonly id: string;
  readonly position: number;
}

/**
 * Position ascending, then id, so the comparator is total for a list that
 * has not been written yet (two rows can share a position on screen for the
 * moment between an optimistic add and its answer).
 */
export function comparePositioned<T extends Positioned>(a: T, b: T): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortByPosition<T extends Positioned>(items: readonly T[]): T[] {
  return [...items].sort(comparePositioned);
}

/** Where a new row goes: after the last one, whatever gaps the list has. */
export function nextPosition<T extends { readonly position: number }>(items: readonly T[]): number {
  if (items.length === 0) return 1;
  return Math.max(...items.map((item) => item.position)) + 1;
}

/** Positions 1..n in the order given. */
export function renumber<T extends { position: number }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ ...item, position: index + 1 }));
}

/**
 * The list with the row at `index` swapped one step in `direction`, or null
 * when there is nothing on that side to swap with. Positions are not touched;
 * the caller decides whether the result is allowed and what to renumber.
 */
export function moved<T>(
  items: readonly T[],
  index: number,
  direction: MoveDirection,
): T[] | null {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= items.length) return null;
  if (target < 0 || target >= items.length) return null;
  const next = [...items];
  const held = next[index];
  next[index] = next[target];
  next[target] = held;
  return next;
}

/**
 * The list sorted, with one row moved one step and the whole list renumbered
 * 1..n, or null when the move is off the end or the row is not there. The
 * whole list comes back because the write is the whole list: one statement,
 * checked once at commit against a deferrable unique on the position.
 */
export function movedByPosition<T extends Positioned>(
  items: readonly T[],
  id: string,
  direction: MoveDirection,
): T[] | null {
  const sorted = sortByPosition(items);
  const index = sorted.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const swapped = moved(sorted, index, direction);
  return swapped === null ? null : renumber(swapped);
}

/**
 * True when `orderedIds` is exactly the set of `items`, each once. The check
 * that makes a forged reorder harmless: an id from another list, a missing
 * row or a duplicate all fail it, and nothing is written.
 */
export function isPermutationOf(
  orderedIds: readonly string[],
  items: readonly { id: string }[],
): boolean {
  if (orderedIds.length !== items.length) return false;
  const seen = new Set<string>();
  const have = new Set(items.map((item) => item.id));
  for (const id of orderedIds) {
    if (seen.has(id) || !have.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Whether a name reads the same as one the list already has — case,
 * padding and invisible characters aside. Not a database rule: nothing
 * behaves differently with two "Editing" columns; what breaks is a person
 * (or a screen reader) told two things by one word.
 */
export function nameTaken(
  name: string,
  others: readonly { readonly name: string }[],
): boolean {
  return others.some((other) => sameLabel(other.name, name));
}
