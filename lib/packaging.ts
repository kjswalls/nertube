import { z } from "zod";
import { cleanProse } from "./text";

/**
 * The packaging block's data rules: the shapes that may be written into
 * `videos.title_candidates` and `videos.hooks`, and the one predicate that
 * decides whether the TTH gate would let this video out of Packaging.
 *
 * ## Why this file exists at all
 *
 * Two of the three things the gate reads are **jsonb arrays with no schema in
 * the database**. `0001_init.sql` can say `jsonb_typeof(hooks) = 'array'` and
 * `jsonb_array_length(hooks) <= 3`, and that is the end of what a CHECK can
 * reasonably do: it cannot say "every element has a non-blank `text`", and — the
 * one that matters most — it cannot say "at most one element is `chosen`".
 * `move_video` counts chosen hooks and refuses anything that is not exactly one,
 * so a row with two chosen hooks is a row that can never leave Packaging and
 * whose only symptom is a gate refusal naming a field that is visibly filled in.
 *
 * PLAN.md line 60 puts that rule here in so many words: *zod additionally
 * enforces ≤ 1 chosen per list*. This file is that sentence, and the server
 * action is the only writer that goes through it.
 *
 * ## Reading is lenient, writing is strict
 *
 * `readTitleCandidates` / `readHooks` never throw: they are handed whatever
 * jsonb is in the row — written by this app, by the seed script, by a future
 * brainstorm import (M8), or by hand — and have to render *something*. They
 * repair only what cannot be rendered (a missing or duplicated id), and they
 * deliberately do **not** repair `chosen`: a row that really does carry two
 * chosen hooks must keep reading as two chosen hooks, so the indicator agrees
 * with the refusal `move_video` would produce. The strict schemas are what
 * stands between the editor and the column, so the repair never has to happen
 * on a row this app wrote.
 */

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The title length the course calls a limit worth knowing. Past it the field
 * warns; it never blocks, because a 58-character title that works is still a
 * title that works (PLAN.md line 166 takes the same line for AI-generated ones:
 * *flag titles > 55 chars in the UI rather than rejecting*).
 */
export const TITLE_WARN_LENGTH = 55;

/** The hard cap on the working title and on any one candidate's text. */
export const MAX_TITLE_LENGTH = 300;

/**
 * `0001_init.sql`: `jsonb_array_length(hooks) <= 3`. The UI refuses the fourth
 * with a sentence; this is the number that sentence is about, and the database
 * would refuse it anyway.
 */
export const MAX_HOOKS = 3;

/** One hook is a sentence or two of spoken script, not a paragraph. */
export const MAX_HOOK_LENGTH = 400;

/**
 * BRIEF.md asks for 10–20 candidates, so this is not a target — it is a
 * ceiling that keeps one row's jsonb bounded. There is no database constraint
 * behind it; it exists so a stuck key cannot write a megabyte into a column
 * that is read on every board render.
 */
export const MAX_CANDIDATES = 50;

/** A candidate's note is "why this one" — a line, not an essay. */
export const MAX_CANDIDATE_NOTE_LENGTH = 300;

/** The typed skip reason. Long enough to be a real sentence. */
export const MAX_SKIP_REASON_LENGTH = 500;

/**
 * And short enough not to be one. `packaging_skip_reason <> ''` is the CHECK;
 * this is the floor the *app* keeps, and it is deliberately higher.
 *
 * BRIEF.md principle 1 asks the app to make skipping the gate structurally
 * awkward, and the disclosure's argument is an asymmetry: skipping costs three
 * deliberate acts, satisfying the gate costs one sentence in a box already on
 * screen. A reason of `x` cleared the old `min(1)` floor, which put the
 * asymmetry the other way round — four clicks and one keystroke to skip — and
 * left behind a column that explains nothing to whoever reads the badge a month
 * later. Twelve characters is roughly "no time" plus a because.
 */
export const MIN_SKIP_REASON_LENGTH = 12;

/* -------------------------------------------------------------------------- */
/* Element schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * An element id.
 *
 * Ids are generated in the browser (`newId()` below) and their only job is to
 * be stable across a rename and unique within the list, so React can key rows
 * and an edit can name the row it edits. They are never shown, never parsed and
 * never used for authorisation, so the rule is deliberately loose about
 * *format* and strict about *shape*: printable, short, no whitespace.
 */
const StableId = z
  .string()
  .min(1, "Every candidate needs an id.")
  .max(64, "That id is too long to have come from this app.")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "That id is not a shape this app generates.",
  );

/**
 * A single-line value that must survive trimming.
 *
 * The trim happens *before* the length checks, so `"   "` is a blank — which is
 * the whole point: a candidate whose text is three spaces renders as an empty
 * row nobody can click, and a hook whose text is blank can still be `chosen`
 * and still satisfy `move_video`'s count, which is how an empty string ends up
 * being spliced into the script template at Scripting.
 */
function requiredText(max: number, blank: string, tooLong: string) {
  return z
    .string()
    // NUL out first: Postgres refuses it in any text, jsonb included.
    .transform((value) => cleanProse(value).trim())
    .pipe(z.string().min(1, blank).max(max, tooLong));
}

/** `[{id,text,note,chosen,source}]` — PLAN.md line 55. */
export const TitleCandidateSchema = z.object({
  id: StableId,
  text: requiredText(
    MAX_TITLE_LENGTH,
    "A title candidate needs some text — an empty one is not a candidate.",
    `Title candidates are capped at ${MAX_TITLE_LENGTH} characters.`,
  ),
  note: z
    .string()
    .transform((value) => cleanProse(value).trim())
    .pipe(
      z
        .string()
        .max(
          MAX_CANDIDATE_NOTE_LENGTH,
          `A candidate's note is capped at ${MAX_CANDIDATE_NOTE_LENGTH} characters.`,
        ),
    )
    // An empty note is *absent*, not `""`. One representation for "there is
    // nothing here" keeps the jsonb comparable and keeps the UI from having to
    // test for both.
    .transform((value) => (value === "" ? undefined : value))
    .optional(),
  chosen: z.boolean().default(false),
  /**
   * `manual` unless the brainstorm module put it there (M8, PLAN.md line 166:
   * per-title "Add as candidate" writes `{source:'ai'}`). Defaulted rather than
   * required so a hand-written row from a migration or a fixture still parses.
   */
  source: z.enum(["manual", "ai"]).default("manual"),
});

/** `[{id,text,chosen}]` — PLAN.md line 58. No note, no source: a hook is spoken. */
export const HookSchema = z.object({
  id: StableId,
  text: requiredText(
    MAX_HOOK_LENGTH,
    "A hook needs some text — an empty one cannot be the one you picked.",
    `Hooks are capped at ${MAX_HOOK_LENGTH} characters.`,
  ),
  chosen: z.boolean().default(false),
});

export type TitleCandidate = z.output<typeof TitleCandidateSchema>;
export type Hook = z.output<typeof HookSchema>;

/* -------------------------------------------------------------------------- */
/* List schemas                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The two rules a CHECK constraint cannot express, applied to any list of
 * `{id, chosen}`: ids are unique, and at most one element is chosen.
 *
 * It **rejects** rather than repairs. A transform that quietly kept the first
 * chosen element and cleared the rest would make the bug invisible: the user
 * would tick a second hook, watch the first one silently untick after a save,
 * and have no idea why. Saving two chosen hooks has to be impossible, and the
 * way it is impossible is that the write never happens.
 */
function listRules(
  singular: string,
  plural: string,
): (
  items: readonly { id: string; chosen: boolean }[],
  ctx: z.RefinementCtx,
) => void {
  return (items, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Two ${plural} share the id ${JSON.stringify(item.id)}; ids have to be unique.`,
        });
      }
      seen.add(item.id);
    }

    const chosen = items.filter((item) => item.chosen);
    if (chosen.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: [items.indexOf(chosen[1]), "chosen"],
        message: `Only one ${singular} can be the chosen one — ${chosen.length} are ticked.`,
      });
    }
  };
}

export const TitleCandidateListSchema = z
  .array(TitleCandidateSchema)
  .max(
    MAX_CANDIDATES,
    `That is more than ${MAX_CANDIDATES} candidates; the course asks for 10–20.`,
  )
  .superRefine(listRules("candidate", "candidates"));

export const HookListSchema = z
  .array(HookSchema)
  // The database says the same thing (`jsonb_array_length(hooks) <= 3`); this
  // is here so the refusal is a sentence rather than a constraint violation.
  .max(
    MAX_HOOKS,
    `Three hooks is the limit — write three and pick the strongest. Remove one before adding another.`,
  )
  .superRefine(listRules("hook", "hooks"));

/**
 * The typed skip reason. `packaging_skip_reason <> ''` is a CHECK; this is its
 * sentence, and a stricter floor than the CHECK on purpose — see
 * `MIN_SKIP_REASON_LENGTH`. The two messages are different because the two
 * mistakes are different: nothing typed at all, and something typed that is not
 * a reason.
 */
export const SKIP_REASON_EMPTY =
  "A reason is required — that is the whole point of skipping deliberately.";

export const SKIP_REASON_TOO_SHORT =
  `That is not a reason yet — write a sentence someone reading the badge in a month could act on (at least ${MIN_SKIP_REASON_LENGTH} characters).`;

export const SkipReasonSchema = z
  .string()
  .transform((value) => cleanProse(value).trim())
  .pipe(
    z
      .string()
      .min(1, SKIP_REASON_EMPTY)
      .min(MIN_SKIP_REASON_LENGTH, SKIP_REASON_TOO_SHORT)
      .max(
        MAX_SKIP_REASON_LENGTH,
        `Keep the reason under ${MAX_SKIP_REASON_LENGTH} characters.`,
      ),
  );

/* -------------------------------------------------------------------------- */
/* Lenient reading                                                             */
/* -------------------------------------------------------------------------- */

/** A browser-safe unique id. `crypto.randomUUID` needs a secure context. */
export function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Every string Postgres' own boolean input accepts as true, and as false.
 *
 * `move_video` reads `chosen` with `(h ->> 'chosen')::boolean`, so the set this
 * reader accepts has to be *that* set and not a plausible-looking subset of it.
 * The first version of this function stopped at `true/t/yes/on/1` and missed
 * `y` — which meant a row holding `{"chosen":"y"}` read as not-chosen in the
 * browser (indicator: "none is chosen yet") while `move_video` counted it and
 * let the video straight through. That is precisely the indicator/refusal
 * disagreement this file exists to prevent, so the lists are written out in
 * full and pinned by a test in `lib/packaging.test.ts`.
 *
 * Postgres accepts any unambiguous prefix of `true`/`false` as well as
 * `y/ye/yes`, `n/no`, `on`, `off`, `1` and `0`, case-insensitively and with
 * surrounding whitespace ignored.
 */
const PG_TRUE = new Set(["t", "tr", "tru", "true", "y", "ye", "yes", "on", "1"]);
const PG_FALSE = new Set(["f", "fa", "fal", "fals", "false", "n", "no", "off", "0"]);

function asChosen(value: unknown): boolean {
  // Postgres round-trips booleans, but a jsonb written by hand, by the seed or
  // by a future brainstorm import may hold `"true"` or `"y"`.
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (PG_TRUE.has(text)) return true;
    // Anything outside both lists is a value `(h ->> 'chosen')::boolean` cannot
    // cast: `move_video` does not read it as false, it *raises* — and a move
    // that errors out is a refusal the user sees, not a silent disagreement.
    // Reading it as not-chosen here is the closest a renderer can get.
    return false;
  }
  // `(h ->> 'chosen')::boolean` on a JSON number reads the digit, so 1 is true
  // and 0 is false there too. Anything else Postgres would raise on, and this
  // app never writes.
  if (value === 1) return true;
  return false;
}

/** Exported for the test that pins the accepted set against Postgres'. */
export const PG_BOOLEAN_STRINGS = {
  true: [...PG_TRUE] as readonly string[],
  false: [...PG_FALSE] as readonly string[],
};

function readList<T>(
  raw: unknown,
  map: (entry: Record<string, unknown>, id: string) => T,
): T[] {
  if (!Array.isArray(raw)) return [];

  const entries = raw.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );

  // Every id the list already carries, so a replacement cannot collide with one
  // further down.
  const present = new Set(
    entries
      .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
      .filter((id) => id !== "" && StableId.safeParse(id).success),
  );

  const used = new Set<string>();
  return entries.map((entry, index) => {
    const raw_id = typeof entry.id === "string" ? entry.id.trim() : "";
    const ok = raw_id !== "" && !used.has(raw_id) && StableId.safeParse(raw_id).success;

    // A blank or repeated id is the one thing that has to be repaired: React
    // keys off it, an edit names a row by it, and it goes into a rendered
    // `id` attribute. Everything else is preserved exactly, including `chosen`.
    //
    // The replacement is **derived from the position, not random**: this runs
    // during server rendering and again during hydration, and `newId()` would
    // produce a different string each time, so the two renders would disagree
    // about an attribute that is actually in the HTML.
    let id = raw_id;
    if (!ok) {
      let n = index;
      do {
        id = `auto-${n}`;
        n += 1;
      } while (present.has(id) || used.has(id));
    }
    used.add(id);
    return map(entry, id);
  });
}

/** `videos.title_candidates` as the editor renders it. Never throws. */
export function readTitleCandidates(raw: unknown): TitleCandidate[] {
  return readList(raw, (entry, id) => {
    const note = typeof entry.note === "string" ? entry.note.trim() : "";
    return {
      id,
      text: asText(entry.text),
      ...(note === "" ? {} : { note }),
      chosen: asChosen(entry.chosen),
      source: entry.source === "ai" ? ("ai" as const) : ("manual" as const),
    };
  });
}

/** `videos.hooks` as the editor renders it. Never throws. */
export function readHooks(raw: unknown): Hook[] {
  return readList(raw, (entry, id) => ({
    id,
    text: asText(entry.text),
    chosen: asChosen(entry.chosen),
  }));
}

/* -------------------------------------------------------------------------- */
/* Anchors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The `id` of the control a gate refusal links to, per missing field.
 *
 * PLAN.md: *a refused drop snaps back with a toast naming the missing field, a
 * "Fix packaging" link (detail scrolled to that field) and a "Skip gate…"
 * link*. M1 shipped neither, on purpose — the block did not exist and both
 * fragments pointed at nothing — and the M1 review recorded that as the reason.
 * These are the ids that make the links real, and they live here rather than in
 * the components so the board can build an href without importing a client
 * component, and so a renamed field cannot leave a link pointing at nothing.
 *
 * Each one names a **focusable control**, not the section around it: a link
 * that scrolls near a field and leaves the caret somewhere else is a link that
 * still has to be followed by a click. `components/packaging/hash-focus.ts`
 * does the focusing.
 */
export const GATE_ANCHOR: Record<GateField, string> = {
  title: "packaging-title",
  thumbnail_concept: "packaging-concept",
  hook: "packaging-hook",
};

/** Where "Skip gate…" lands: the reason box, with the disclosure opened. */
export const SKIP_ANCHOR = "packaging-skip";

/** The block itself, for a link that means "the packaging fields" generally. */
export const PACKAGING_ANCHOR = "packaging";

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/** The three fields `move_video` checks, in the order it checks them. */
export type GateField = "title" | "thumbnail_concept" | "hook";

/**
 * Everything the gate reads, and nothing else.
 *
 * `title` and `thumbnailConcept` are the values **as they are (or will be)
 * stored**: `move_video` compares with `coalesce(x, '') = ''` and does not trim,
 * so neither does this. The editor trims on the way in, which is what makes the
 * live indicator a prediction rather than a guess — what it evaluates is what
 * the next save will put in the column.
 */
export interface PackagingSnapshot {
  readonly title: string | null;
  readonly thumbnailConcept: string | null;
  readonly hooks: readonly { readonly chosen: boolean }[];
  readonly packagingSkippedAt: string | null;
}

export type GateStatus =
  | {
      readonly ready: true;
      /** True when the gate is satisfied only because packaging was skipped. */
      readonly skipped: boolean;
      readonly missing: null;
      readonly chosenHooks: number;
    }
  | {
      readonly ready: false;
      readonly skipped: false;
      readonly missing: GateField;
      readonly chosenHooks: number;
    };

/**
 * The single predicate. Line for line, this is `move_video`'s gate block:
 *
 * ```sql
 * if v_order > array_position(k_order, 'packaging') and v_video.packaging_skipped_at is null then
 *   select count(*) into v_chosen_hooks from jsonb_array_elements(v_video.hooks) h
 *    where coalesce((h ->> 'chosen')::boolean, false);
 *   if    coalesce(v_video.title, '') = ''              then v_missing := 'title';
 *   elsif coalesce(v_video.thumbnail_concept, '') = ''  then v_missing := 'thumbnail_concept';
 *   elsif v_chosen_hooks <> 1                           then v_missing := 'hook';
 * ```
 *
 * The `elsif` chain matters: the function stops at the *first* missing field, so
 * an indicator that listed all three would disagree with the refusal the board
 * shows for the same video. It names one field, the same one, for the same
 * reason.
 *
 * The skip check is first here as it is there: a skipped video passes the gate
 * with every field empty, and saying "needs a title" about one would be a
 * refusal that never happens.
 */
export function packagingGate(snapshot: PackagingSnapshot): GateStatus {
  const chosenHooks = snapshot.hooks.filter((hook) => hook.chosen).length;

  if (snapshot.packagingSkippedAt !== null) {
    return { ready: true, skipped: true, missing: null, chosenHooks };
  }
  if ((snapshot.title ?? "") === "") {
    return { ready: false, skipped: false, missing: "title", chosenHooks };
  }
  if ((snapshot.thumbnailConcept ?? "") === "") {
    return { ready: false, skipped: false, missing: "thumbnail_concept", chosenHooks };
  }
  if (chosenHooks !== 1) {
    return { ready: false, skipped: false, missing: "hook", chosenHooks };
  }
  return { ready: true, skipped: false, missing: null, chosenHooks };
}

/**
 * How each missing field reads in a sentence.
 *
 * Deliberately word-for-word what `app/actions/moves.ts` puts in the refusal
 * toast, including the parenthesis on the concept: the indicator on this page
 * and the refusal on the board are describing the same decision about the same
 * row, and two wordings for it is how "the sketch is the concept" got believed
 * in the first place (M1 review finding 3).
 */
export const GATE_WORDING: Record<GateField, string> = {
  title: "a working title",
  thumbnail_concept: "a thumbnail concept written down (the sketch is not it)",
  hook: "exactly one chosen hook",
};

/**
 * The indicator's whole sentence, derived from the same status the predicate
 * returns — so the light and the words cannot disagree.
 */
export function describeGate(status: GateStatus): string {
  if (status.ready) {
    return status.skipped ? "Packaging: skipped" : "Packaging: ready";
  }
  if (status.missing === "hook") {
    // The count is the actionable half. The editor makes two chosen hooks
    // unreachable, but a row written before this editor existed can hold them.
    const detail =
      status.chosenHooks === 0
        ? "none is chosen yet"
        : `${status.chosenHooks} are chosen`;
    return `Packaging: needs ${GATE_WORDING.hook} — ${detail}`;
  }
  return `Packaging: needs ${GATE_WORDING[status.missing]}`;
}
/**
 * `move_video` raises `gate:title`, `gate:thumbnail_concept` or `gate:hook`.
 * PostgREST hands that back as the error message, sometimes with its own
 * prefix, so this matches rather than compares.
 */
export function readGateField(message: string): GateField | null {
  const match = /gate:(title|thumbnail_concept|hook)/.exec(message);
  return match ? (match[1] as GateField) : null;
}

/**
 * The soft warning PLAN.md asks for, and the one place that knows it.
 *
 * PLAN.md, "Key UI behaviours": *One hard gate; Publish Prep → Scheduled with
 * < 3 thumbnail paths is a soft warning only.* It is **not** a refusal — the
 * move has already happened by the time this is computed, and BRIEF.md
 * principle 6 is that the tool must not add friction. What it is, is the one
 * moment where saying "you are queueing this up with one image" is still
 * useful: after it is scheduled, a swap means making a new thumbnail under
 * time pressure, which is the whole reason principle 7 asks for three.
 *
 * Returning a sentence rather than rendering one keeps the three surfaces that
 * move a video (the board's drag, the detail page's stage select, `/now`'s
 * move row) saying the same thing, the same way the gate refusal already is.
 */
export function describeThumbnailShortfall(ready: number): string | null {
  if (ready >= 3) return null;
  return ready === 0
    ? "Scheduled with no thumbnail variants yet. Three — a wild card, a moderate and a safe — are what make a bad first hour cost a swap rather than a day."
    : `Scheduled with ${ready} of 3 thumbnail variants. That is allowed, but a swap only takes minutes when the other two already exist.`;
}

