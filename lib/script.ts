import { HOOK_PLACEHOLDER } from "./channel-settings";
import { compareKinds, type StageKind } from "./defaults";
import { readHooks } from "./packaging";
import { cleanProse, isBlank } from "./text";

/**
 * The script: what it is as a column, where it may be written, and how the
 * template becomes one.
 *
 * Pure and free of React and of Supabase, so the server action, the editor and
 * the unit tests all import the same answers.
 */

/* -------------------------------------------------------------------------- */
/* The column                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Long enough for any script a person reads aloud, not for a book.
 *
 * A twenty-minute video is about 3,000 spoken words — some 18,000 characters.
 * Five times that leaves room for B-roll notes, cut sections kept at the
 * bottom and a pasted research dump, and still refuses a runaway paste before
 * it reaches the database.
 */
export const MAX_SCRIPT_LENGTH = 100_000;

/** A named video, or a playlist and a line about why. It is not a note. */
export const MAX_END_SCREEN_TARGET_LENGTH = 300;

/**
 * `videos.script` as it is stored: the text **exactly as written**, except for
 * U+0000 (which Postgres refuses), and `null` when nothing in it would draw.
 *
 * ## Why this is not `NullableText`
 *
 * Every other text column on the page is trimmed. The script is not, because it
 * saves while it is being typed: a trim on the way in would remove the newline
 * someone just pressed at the end of a paragraph, the server's answer would put
 * the shorter text back into the box, and the caret would jump. A script is a
 * document, and a document's trailing blank line is part of it — the channel's
 * own template ends with one.
 *
 * Blank still means `null`, for the reason the rest of the page has: `move_video`
 * fills the script only while it is `null`, and a script of three newlines is
 * one nobody wrote.
 */
export function scriptForColumn(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = cleanProse(value);
  return isBlank(cleaned) ? null : cleaned;
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                   */
/* -------------------------------------------------------------------------- */

/** `videos.script_structure`'s CHECK, in order. */
export const SCRIPT_STRUCTURES = ["listicle", "three_part", "story_arc"] as const;

export type ScriptStructure = (typeof SCRIPT_STRUCTURES)[number];

/** BRIEF.md's words for them: "listicle / 3-part / story arc". */
export const SCRIPT_STRUCTURE_LABEL: Readonly<Record<ScriptStructure, string>> = {
  listicle: "Listicle",
  three_part: "3-part",
  story_arc: "Story arc",
};

export function isScriptStructure(value: unknown): value is ScriptStructure {
  return (
    typeof value === "string" &&
    (SCRIPT_STRUCTURES as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Where it may be written                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Can this video's script be written?
 *
 * **From Scripting onward**, and not before. BRIEF.md's first principle is
 * that title, thumbnail concept and hook are decided *before* the script is
 * written, and that the app makes skipping that structurally awkward. A script
 * box open on an idea would be a way round the gate with no reason typed and
 * no badge on the card. The one way to script early is the deliberate one:
 * skip the gate with a reason, move the video into Scripting, and write.
 *
 * It stays writable after Scripting — a script is revised in Filming and cut
 * in Editing — and a video moved back to Packaging keeps its text, read-only,
 * until it comes forward again.
 *
 * An inert stage (a column the user added, `kind = null`) has no place in the
 * order, so nothing can be said about what it has passed. The section tabs
 * already treat that as "open, and say nothing" (`reached()` in
 * `components/video-sections/sections.ts`), and this agrees rather than
 * locking a script someone may be halfway through.
 */
export function scriptIsEditable(stageKind: StageKind | null): boolean {
  if (stageKind === null) return true;
  return compareKinds(stageKind, "scripting") >= 0;
}

/* -------------------------------------------------------------------------- */
/* The template                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The chosen hook's text, as `move_video` reads it: the first element of
 * `videos.hooks` whose `chosen` Postgres reads as true, or `null` when none is.
 *
 * `readHooks` is the lenient reader the gate indicator already uses, and its
 * `chosen` is Postgres' own boolean input set (`lib/packaging.ts` pins it), so
 * "which hook is chosen" has one answer on this page. The SQL takes the first
 * chosen element in array order (`limit 1` over `jsonb_array_elements`), and so
 * does this.
 */
export function chosenHookText(hooks: unknown): string | null {
  const chosen = readHooks(hooks).find((hook) => hook.chosen);
  return chosen === undefined ? null : chosen.text;
}

/**
 * The script `move_video` writes on a video's first entry to Scripting.
 *
 * The SQL (`0005_checklist_seeded_stages.sql`, carried from `0001_init.sql`):
 *
 * ```sql
 * replace(c.script_template, '{{hook}}',
 *         coalesce(<the first chosen hook's text>, ''))
 * ```
 *
 * `replace` swaps **every** occurrence, left to right, and treats the
 * replacement as plain text. `split(...).join(...)` is exactly that;
 * `String.prototype.replaceAll` with a string replacement is not, because it
 * reads `$&`, `$1` and `$$` in the replacement as patterns — a hook reading
 * "Make $$$ from $0" would come out mangled. The unit test pins that case.
 *
 * "Reset from template" on the Script tab calls this, through
 * `scriptFromTemplate` in `app/actions/videos.ts`, with the channel's template
 * and the video's hooks as they are stored *now*. `e2e/script-editor.spec.ts`
 * proves the two implementations agree on a real database: it moves a video
 * into Scripting, lets `move_video` write the script, presses Reset, and
 * compares the two texts byte for byte.
 *
 * One divergence, on data this app never writes: a hook whose `text` is a JSON
 * number reads as `'5'` through `->>` and as `""` through `readHooks`.
 */
export function buildScriptFromTemplate(template: string, hooks: unknown): string {
  return template.split(HOOK_PLACEHOLDER).join(chosenHookText(hooks) ?? "");
}

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How many words a script holds — for the sentence that says what a reset
 * would replace, not a writing target. Markdown punctuation standing on its
 * own (`##`, `-`, `→`) is not a word.
 */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * The toolbar's words for a refused save: short, because the toolbar is pinned
 * over the script and on a phone with the keyboard up every line of it is a
 * line of script the person cannot see (M10 review). The long sentence the
 * rest of the page uses is `CHANGED_ELSEWHERE`; this one also says what Reload
 * will do to the box, which that one does not need to (a one-line field loses
 * a line, this box loses an evening).
 */
export const SCRIPT_CONFLICT =
  "Not saved: this video changed in another tab. Reload replaces this text — copy yours first.";
