import { z } from "zod";

import { AXIS_LABEL, type BucketAxis } from "./buckets";

/**
 * Everything about editing a channel's buckets that is a rule rather than a
 * screen: what a bucket may be called, what a quota may be, how many of each
 * axis the brief thinks a channel should have, and the sentences a refusal
 * or a removal is made of.
 *
 * Nothing in this file writes anything. `app/actions/buckets.ts` applies these
 * rules on the server before it touches the table, and the database applies
 * the load-bearing ones again: `unique (channel_id, axis, name)`,
 * `check (monthly_quota > 0)`, and the deferrable `(channel_id, axis,
 * position)` that a reorder has to satisfy at commit.
 *
 * ## What a bucket is to the rest of the app
 *
 * An id. `videos.vertical_id` and `videos.horizontal_id` point at rows here
 * through a three-column composite key, and nothing — not the matrix, not the
 * bank's filter, not the capture picker — compares a bucket's *name*. So a
 * rename is a change of label and nothing else, which is why the editor
 * treats it as the edit with no consequences, and why a removal is the edit
 * with one: the key is `on delete set null`, so removing a bucket unfiles
 * every video that carried it, on that axis only. That sentence is
 * `unfiledSentence` below, and the editor says it before the click.
 */

/* -------------------------------------------------------------------------- */
/* The name                                                                    */
/* -------------------------------------------------------------------------- */

/** A matrix heading. Long enough for "self-experiment" twice over. */
export const BUCKET_NAME_MAX = 40;

export const BucketNameSchema = z
  .string({ error: "A bucket needs a name." })
  .trim()
  .min(1, "A bucket needs a name — a row with no heading is one nobody can file under.")
  .max(BUCKET_NAME_MAX, `Keep a bucket name under ${BUCKET_NAME_MAX} characters; it is a matrix heading.`);

/**
 * Two buckets on one axis of one channel may not share a name, whatever the
 * case.
 *
 * The database unique is case-sensitive, so "Review" and "review" would both
 * be accepted by it — and then the matrix would draw two columns a person
 * cannot tell apart and the capture picker would offer two options with the
 * same word on them. The rule is stated here, case-insensitively, and the
 * database's is the backstop.
 */
export function bucketNameTaken(
  name: string,
  others: readonly { readonly name: string }[],
): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  return others.some((other) => other.name.trim().toLocaleLowerCase() === wanted);
}

/** The sentence for a name the axis already has. */
export function duplicateSentence(axis: BucketAxis, name: string): string {
  return `This channel already has a ${AXIS_LABEL[axis].toLowerCase()} called “${name}”. Two with one name would be two matrix headings nobody could tell apart.`;
}

/* -------------------------------------------------------------------------- */
/* The quota                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A month's worth. `monthly_quota` is `check (> 0)` in the database; the
 * ceiling is this file's, and generous — a quota is "2 book reviews a month",
 * and anything past a couple a day is not a plan for a month.
 */
export const MAX_QUOTA = 99;

export const QuotaSchema = z
  .number({ error: "A quota is a whole number of videos a month." })
  .int("A quota is a whole number of videos — there is no half a review.")
  .min(1, "A quota of zero is not a quota. Leave the box empty to have no target instead.")
  .max(MAX_QUOTA, `Keep a monthly quota under ${MAX_QUOTA}; past that it is not a plan for a month.`);

export type QuotaParse =
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false; readonly error: string };

/**
 * What the quota box holds, read as a quota.
 *
 * Empty means **no quota** — the matrix draws a count and no bar — and is
 * the only way to clear one. Zero is refused here, in words, before the
 * database refuses it with a CHECK violation nobody can read; so is a
 * negative number, a fraction, and anything that is not a number at all.
 */
export function parseQuotaInput(raw: string): QuotaParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const numeric = /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const parsed = QuotaSchema.safeParse(numeric);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  return { ok: true, value: parsed.data };
}

/** The quota as the box should print it: the number, or nothing. */
export function quotaText(quota: number | null): string {
  return quota === null ? "" : String(quota);
}

/* -------------------------------------------------------------------------- */
/* The shape of an axis                                                        */
/* -------------------------------------------------------------------------- */

/**
 * BRIEF.md: *"each channel defines 3–5 verticals (topic pillars) and 8–12
 * horizontals (formats)"*. Not a limit — a channel with two pillars or
 * fourteen formats is allowed — but the shape the matrix was designed around,
 * and the editor says where the axis stands against it.
 */
export const AXIS_SHAPE = {
  vertical: { min: 3, max: 5 },
  horizontal: { min: 8, max: 12 },
} as const satisfies Record<BucketAxis, { min: number; max: number }>;

/** The plural a person uses for the axis. */
export const AXIS_PLURAL = {
  vertical: "topic pillars",
  horizontal: "formats",
} as const satisfies Record<BucketAxis, string>;

export type AxisStanding = "none" | "under" | "within" | "over";

/** Where a count stands against the brief's shape for the axis. */
export function axisStanding(axis: BucketAxis, count: number): AxisStanding {
  const { min, max } = AXIS_SHAPE[axis];
  if (count === 0) return "none";
  if (count < min) return "under";
  if (count > max) return "over";
  return "within";
}

/**
 * The line beside an axis's heading: how many there are, and whether that is
 * the shape the brief describes. One sentence, so a person adding their third
 * pillar sees it become "within" without reading a paragraph.
 */
export function axisCountSentence(axis: BucketAxis, count: number): string {
  const { min, max } = AXIS_SHAPE[axis];
  const plural = AXIS_PLURAL[axis];
  const noun = count === 1 ? AXIS_LABEL[axis].toLowerCase() : plural;
  switch (axisStanding(axis, count)) {
    case "none":
      return `No ${plural} yet — the brief suggests ${min}–${max}.`;
    case "under":
      return `${count} ${noun} — the brief suggests ${min}–${max}.`;
    case "within":
      return `${count} ${noun} — within the ${min}–${max} the brief suggests.`;
    case "over":
      return `${count} ${noun} — more than the ${min}–${max} the brief suggests; a wider matrix is a thinner one.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What removing a bucket does to the videos filed under it.
 *
 * The composite key on `videos` is `on delete set null`, so the videos are
 * not deleted, not moved, and not touched on the other axis: they lose this
 * one label and keep everything else. Said before the click, with the count,
 * so a removal is never a surprise about somebody's bank.
 */
export function unfiledSentence(
  axis: BucketAxis,
  name: string,
  filed: number,
): string {
  const label = AXIS_LABEL[axis].toLowerCase();
  if (filed === 0) {
    return `Nothing is filed under “${name}”, so removing it changes no video.`;
  }
  const videos = filed === 1 ? "One video is" : `${filed} videos are`;
  const them = filed === 1 ? "it" : "them";
  return `${videos} filed under “${name}”. Removing it leaves ${them} with no ${label} — nothing else about ${them} changes, and ${filed === 1 ? "it" : "they"} can be filed again by hand.`;
}

/* -------------------------------------------------------------------------- */
/* Order                                                                       */
/* -------------------------------------------------------------------------- */

/** The least a bucket has to be for the order helpers to move it. */
export interface OrderedBucket {
  readonly id: string;
  readonly position: number;
}

/** Position ascending, then id, so the comparator is total before a write. */
export function compareBuckets<T extends OrderedBucket>(a: T, b: T): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortBuckets<T extends OrderedBucket>(items: readonly T[]): T[] {
  return [...items].sort(compareBuckets);
}

/** Where a new bucket goes: after the last one on its axis. */
export function nextBucketPosition(items: readonly OrderedBucket[]): number {
  if (items.length === 0) return 1;
  return Math.max(...items.map((item) => item.position)) + 1;
}

/**
 * The axis with one bucket moved one step, renumbered 1..n, or `null` when the
 * move is off the end. The whole axis comes back because the write is the
 * whole axis: one statement, checked once at commit against the deferrable
 * unique on `(channel_id, axis, position)`.
 */
export function moveBucket<T extends OrderedBucket>(
  items: readonly T[],
  id: string,
  direction: "up" | "down",
): T[] | null {
  const sorted = sortBuckets(items);
  const index = sorted.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= sorted.length) return null;
  const swapped = [...sorted];
  swapped[index] = sorted[target];
  swapped[target] = sorted[index];
  return swapped.map((item, position) => ({ ...item, position: position + 1 }));
}
