import { THUMBNAIL_ROLES, type ThumbnailRole } from "@/lib/storage";

/**
 * What the three roles mean, what they are called on screen, and the wording
 * the section uses when something is refused.
 *
 * Pure, and imported by both halves on purpose: `app/actions/thumbnails.ts`
 * refuses a swap with the same sentence the dialog refuses it with, and the
 * slot's label is the same string the log prints in its "from" column. A label
 * written twice is a label that ends up saying "Wild card" in one place and
 * "Wildcard" in another, in a log that is supposed to be a record.
 *
 * The role *strings* themselves are `lib/storage.ts`'s, because they are the
 * storage path segment and the database's own CHECK values before they are
 * anything a person reads.
 */

export { THUMBNAIL_ROLES };
export type { ThumbnailRole };

/** The name on the slot, in the log, and in every refusal. */
export const ROLE_LABEL: Readonly<Record<ThumbnailRole, string>> = {
  wild_card: "Wild card",
  moderate: "Moderate",
  safe: "Safe",
};

/**
 * What each variant is *for*, in one line, under its frame.
 *
 * This is the **role's** description, the same on every video — not a note
 * somebody wrote about this particular image. The two were being called by one
 * word, which is why the slot labels it in the UI rather than presenting it as
 * a remark. A genuine per-variant note has no column, and neither BRIEF.md nor
 * PLAN.md asks for one; the per-variant thing a person actually writes is the
 * swap reason, which the live slot prints from the log.
 *
 * BRIEF.md principle 7 is not "make three thumbnails", it is "make three
 * *different bets*": the whole mechanism only pays off if the safe one is
 * genuinely a different idea from the wild card, so that swapping is a change
 * of approach rather than a change of crop. Three slots with three identical
 * captions would quietly invite three crops of one image, which is the failure
 * mode this note exists to name.
 */
export const ROLE_NOTE: Readonly<Record<ThumbnailRole, string>> = {
  wild_card:
    "The risky one. Strong claim, odd framing, the idea you would not normally dare ship.",
  moderate:
    "The considered one. The concept as written, executed straight.",
  safe: "The fallback. Clear and legible at tile size even if nobody is intrigued by it.",
};

/* -------------------------------------------------------------------------- */
/* The reason a swap is logged with                                            */
/* -------------------------------------------------------------------------- */

/**
 * `thumbnail_swaps.reason` is `not null check (reason <> '')`, so the database
 * refuses a blank one. A blank is not the problem worth guarding, though: a
 * reason of `x` satisfies the CHECK and tells whoever reads the log in three
 * months precisely nothing, which is the same hole `MIN_SKIP_REASON_LENGTH`
 * closed on the packaging skip. The floor is a short sentence — "CTR 2.1%, well
 * under 4%" is 24 characters.
 */
export const MIN_SWAP_REASON_LENGTH = 12;

/** Room for a paragraph, not an essay. */
export const MAX_SWAP_REASON_LENGTH = 500;

export const SWAP_REASON_EMPTY =
  "A swap needs a reason — the log is the only record of why the thumbnail changed.";

export const SWAP_REASON_TOO_SHORT =
  `Say a little more: at least ${MIN_SWAP_REASON_LENGTH} characters, so the log still means something in three months.`;

/**
 * What the **first** ship is logged as.
 *
 * `swap_thumbnail` writes a log row on every call, including the first, where
 * `from_role` is null — there is nothing to explain because nothing was
 * replaced. Demanding a typed justification for choosing a thumbnail at launch
 * would be friction for its own sake (BRIEF.md principle 6), and inventing a
 * sentence in the user's voice would be worse. So the first ship is logged as
 * exactly what it was, in the app's voice, and the UI says so before the
 * button is pressed. Every *change* after that is typed by hand.
 */
export const LAUNCH_REASON = "Chosen at launch.";

/**
 * Is this reason good enough, or what is wrong with it.
 *
 * Used by the dialog before the round trip and by the action after it, so the
 * two cannot drift into disagreeing about what counts as a reason.
 */
export function describeReasonRejection(raw: string): string | null {
  const typed = raw.trim();
  if (typed === "") return SWAP_REASON_EMPTY;
  if (typed.length < MIN_SWAP_REASON_LENGTH) return SWAP_REASON_TOO_SHORT;
  return null;
}

/* -------------------------------------------------------------------------- */
/* What the database refuses, in words                                         */
/* -------------------------------------------------------------------------- */

/**
 * The CHECK that refuses a shipped role with no asset, said usefully.
 *
 * `0001_init.sql`:
 *
 * ```sql
 * constraint videos_shipped_role_has_asset check (
 *   shipped_role is null
 *   or (shipped_role = 'wild_card' and thumb_wild_card_path is not null) …)
 * ```
 *
 * That constraint **is** the guard — the task brief is explicit that it must
 * not be re-implemented in TypeScript and then described as the rule. So the
 * app asks, the database refuses, and this turns `new row for relation "videos"
 * violates check constraint "videos_shipped_role_has_asset"` into a sentence
 * naming the slot and the thing to do about it.
 */
export function noAssetMessage(role: ThumbnailRole): string {
  return `${ROLE_LABEL[role]} has no image yet — upload one before shipping it.`;
}

/** The same, for the CHECK that refuses removing the image that is live. */
export function shippedCannotBeRemovedMessage(role: ThumbnailRole): string {
  return (
    `${ROLE_LABEL[role]} is the one that is live, and a video cannot be live with no thumbnail. ` +
    `Ship another variant first, then remove this one.`
  );
}

/** `thumbnail_swaps_roles`: `from_role is distinct from to_role`. */
export function alreadyLiveMessage(role: ThumbnailRole): string {
  return `${ROLE_LABEL[role]} is already the live one.`;
}
