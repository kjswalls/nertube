/**
 * What a piece of typed text is, once the characters that render as nothing
 * are taken out of the question.
 *
 * ## Why this exists
 *
 * Every "needs a name" rule in the settings area used to be `.trim().min(1)`,
 * and `trim()` strips whitespace only. Unicode has a second family of
 * characters that draw nothing — the zero-width space (U+200B), the byte-order
 * mark (U+FEFF), the word joiner (U+2060), the bidi controls — and a name made
 * of them passes `min(1)` and renders as an empty column heading, or as an
 * exact visual twin of a name the channel already has, which is precisely
 * what the duplicate rule exists to stop. M7's review sent one through every
 * screen. This is the one place the answer lives; the four schemas import it,
 * and `0008_settings_boundary.sql`'s `has_visible_text()` is the same rule
 * stated in SQL, so it cannot arrive by a forged request either.
 *
 * ## Two shapes of text, two treatments
 *
 * A **label** — a stage name, a bucket name, a checklist row — is one line
 * that is read at a glance, so the invisible characters are simply removed
 * before the length rule runs and the stored value is what the eye sees.
 *
 * **Prose** — the voice guide, the script template — is the person's own
 * document, and some format characters are content there: a zero-width
 * joiner inside an emoji sequence, a zero-width non-joiner in Persian. So
 * prose keeps its characters and only the *question* "is there anything
 * here" is asked on the stripped form. The one character taken out of prose
 * is U+0000, which Postgres refuses in every `text` column with a message no
 * person should be shown.
 */

/**
 * Format characters (`\p{Cf}`: the zero-width family, bidi controls, BOM,
 * soft hyphen, …) and the NUL byte. NUL is a control character, not a format
 * one, and is listed on its own because it is the one that reaches the
 * database as an error rather than as nothing.
 */
const INVISIBLE = /[\p{Cf}\u0000]/gu;

/** The text with every character that draws nothing removed. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, "");
}

/**
 * A one-line label as it should be stored: format characters gone, padding
 * gone. `"Money​"` becomes `"Money"`, so it cannot be a second "Money".
 */
export function cleanLabel(value: string): string {
  return stripInvisible(value).trim();
}

/** True when nothing in the text would draw. The non-blank rule, for any text. */
export function isBlank(value: string): boolean {
  return cleanLabel(value) === "";
}

/**
 * Prose as it should be stored: NUL removed (Postgres refuses it), everything
 * else exactly as written. Blankness is a separate question — `isBlank`.
 */
export function cleanProse(value: string): string {
  return value.replace(/\u0000/g, "");
}

/**
 * Two labels are the same label when they read the same: invisible
 * characters and padding gone, case folded. What the duplicate rules compare.
 */
export function sameLabel(a: string, b: string): boolean {
  return cleanLabel(a).toLocaleLowerCase() === cleanLabel(b).toLocaleLowerCase();
}
