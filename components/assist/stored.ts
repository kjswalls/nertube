import { z } from "zod";

/**
 * `videos.brainstorm_last`, and the one place that knows its shape.
 *
 * PLAN.md gives the column one job: *the most recent brainstorm result, so
 * closing the panel loses nothing*. That makes reopening free — no second call,
 * no second charge — and it makes "this is from earlier" something the panel
 * can say honestly rather than guess.
 *
 * ## Why the shape lives here rather than in `lib/assist`
 *
 * `lib/assist` is the swappable service module: what a provider is asked and
 * what it answers. What this *app* chooses to keep afterwards, in a column with
 * its own history, is not the provider's business — a different vendor behind
 * the same interface must not change what is already in the column. So the
 * envelope is the panel's, versioned (`v`), and read leniently: a row written
 * by an older build, by hand, or by a provider that has since been replaced has
 * to render or be ignored, never throw. A detail page that will not open
 * because a cached suggestion is the wrong shape is a page you cannot use.
 *
 * ## Why it is keyed by kind
 *
 * The same panel answers three questions — twenty title candidates, thumbnail
 * concepts, and the spoken hooks — and they are separate calls behind the
 * interface. Keeping them in one object keyed by kind means asking for hooks
 * never throws away the titles you have not accepted yet, and asking for
 * concepts throws away neither.
 *
 * The three are the three *text* assists. The thumbnail critique is not here
 * and is deliberately not stored at all: it is a judgement about the bytes in
 * the bucket at the moment it ran, and a kept verdict about an image that has
 * since been replaced reads as current when it is not. See
 * `app/actions/assist.ts`.
 */

export const STORED_ASSIST_KINDS = ["titles", "concepts", "hooks"] as const;
export type StoredAssistKind = (typeof STORED_ASSIST_KINDS)[number];

const Suggestion = z.object({
  text: z.string().min(1),
  rationale: z.string(),
});

export const StoredAssistEntry = z.object({
  /** When it was asked for, so "from earlier" has an age. */
  at: z.string(),
  /** `fake` or `anthropic`, and the model — provenance, not decoration. */
  provider: z.string(),
  model: z.string(),
  /**
   * Whether the channel had a voice guide *at the time*. M8's acceptance is
   * that changing the guide changes the output; a stored answer that predates
   * the guide should say so rather than look like the guide was ignored.
   */
  voiceGuide: z.boolean(),
  suggestions: z.array(Suggestion),
  /** The model's own pick, as an index into `suggestions`. */
  recommended: z.number().int().nullable(),
  /**
   * Why that one beats the others, when the answer said.
   *
   * Optional and defaulted rather than required, for the same reason
   * `concepts` is optional above: rows written before the question was asked
   * have to keep reading. A row without it shows the pick without a reason,
   * which is what every row written before this did anyway.
   */
  recommendedReason: z.string().nullable().optional().default(null),
});

export type StoredAssistEntryValue = z.infer<typeof StoredAssistEntry>;

export const StoredBrainstorm = z.object({
  v: z.literal(1),
  titles: StoredAssistEntry.optional(),
  /**
   * Added after the first three kinds shipped, and deliberately *not* a new
   * `v`: every key is optional, so a row written before this existed reads
   * exactly as it did, and a row written after it is ignored key-by-key by an
   * older build rather than rejected whole. A version bump is for a change
   * that makes the old shape unreadable, and this is not one.
   */
  concepts: StoredAssistEntry.optional(),
  hooks: StoredAssistEntry.optional(),
});

export type StoredBrainstormValue = z.infer<typeof StoredBrainstorm>;

/** What the panel starts with: whatever of the three kinds the column holds. */
export type StoredBrainstormView = Readonly<
  Record<StoredAssistKind, StoredAssistEntryValue | null>
>;

export const NOTHING_STORED: StoredBrainstormView = {
  titles: null,
  concepts: null,
  hooks: null,
};

/** The column, leniently. Never throws; anything unreadable reads as absent. */
export function readStoredBrainstorm(raw: unknown): StoredBrainstormView {
  const parsed = StoredBrainstorm.safeParse(raw);
  if (!parsed.success) return NOTHING_STORED;
  return {
    titles: usable(parsed.data.titles),
    concepts: usable(parsed.data.concepts),
    hooks: usable(parsed.data.hooks),
  };
}

/** An entry with nothing in it is the same as no entry. */
function usable(
  entry: StoredAssistEntryValue | undefined,
): StoredAssistEntryValue | null {
  if (!entry || entry.suggestions.length === 0) return null;
  const recommended =
    entry.recommended !== null &&
    entry.recommended >= 0 &&
    entry.recommended < entry.suggestions.length
      ? entry.recommended
      : null;
  // The comparison belongs to the pick. A stored row whose index no longer
  // points anywhere keeps neither.
  return {
    ...entry,
    recommended,
    recommendedReason: recommended === null ? null : (entry.recommendedReason ?? null),
  };
}

/**
 * The column as it should be written after a fresh answer of one kind.
 *
 * Written by walking the kinds rather than naming them, so adding a fourth
 * text assist is one entry in `STORED_ASSIST_KINDS` and nothing here. A kind
 * with no answer is left out of the object entirely rather than written as
 * `null`, because `videos.brainstorm_last` is a jsonb column somebody may read
 * by hand and a key that means "nothing" is noise.
 */
export function withEntry(
  current: StoredBrainstormView,
  kind: StoredAssistKind,
  entry: StoredAssistEntryValue,
): StoredBrainstormValue {
  const next: StoredBrainstormValue = { v: 1 };
  for (const which of STORED_ASSIST_KINDS) {
    const replacing = which === kind;
    /*
      An empty answer never replaces a kept one.

      `lib/assist/clamp.ts` now refuses to return an empty list at all, so in
      this app nothing reaches here with one. This is the backstop for the
      thing that made that a blocker: an entry with no suggestions reads back
      as *absent* (`usable` above), so writing one does not store an empty
      answer — it destroys the answer that was there, silently, while the call
      reports success. The column's whole job is that closing the panel loses
      nothing, and no answer is worth less than the one it would overwrite.
    */
    const value =
      replacing && entry.suggestions.length === 0 ? current[which] : replacing ? entry : current[which];
    if (value) next[which] = value;
  }
  return next;
}
