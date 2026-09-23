import { z } from "zod";

import type { StageKind } from "./defaults";
import { MIN_MEDIAN_SAMPLE, EXPECTATION_SAMPLE } from "./next-action";
import { cleanProse, isBlank } from "./text";

/**
 * The channel's own settings — the five columns on `channels` that are not
 * its name: `voice_guide`, `script_template`, `wip_threshold`, `stale_days`
 * and `expected_ctr`. What each one may hold, and what each one *does*, in a
 * sentence the settings screen prints beside the field.
 *
 * Nothing here writes anything. `app/actions/channels.ts` applies these
 * schemas on the server, and since `0008_settings_boundary.sql` the database
 * holds the same bounds as CHECKs — the same floors and ceilings, the same
 * non-blank rule — so a forged write is refused where a typed one is.
 *
 * ## Why the consequences are data
 *
 * Each of these settings drives something visible on another screen, and the
 * one thing a settings page owes a person is to say what. The sentences live
 * here rather than in the component so that they sit next to the rule they
 * describe and so a unit test can pin the numbers they quote (the median's
 * sample size, for one) to the constants the rest of the app actually uses.
 */

/* -------------------------------------------------------------------------- */
/* The two texts                                                               */
/* -------------------------------------------------------------------------- */

/** Long enough for a real voice document; short enough to send to a model. */
export const MAX_VOICE_GUIDE_LENGTH = 20_000;

/** A script template is a skeleton, not a script. */
export const MAX_SCRIPT_TEMPLATE_LENGTH = 20_000;

/**
 * `{{hook}}` — where `move_video` splices the chosen hook the first time a
 * video enters Scripting. The template is the user's own shape, so a template
 * without it is *allowed*; the editor warns rather than refuses.
 */
export const HOOK_PLACEHOLDER = "{{hook}}";

export function hasHookPlaceholder(template: string): boolean {
  return template.includes(HOOK_PLACEHOLDER);
}

/**
 * Newlines are the content. A voice guide is paragraphs; a script template is
 * headings and blank lines. So the only normalisation is line endings — a
 * browser textarea submits `\r\n` on some platforms and `move_video`'s
 * `replace()` does not care, but a round trip that came back with different
 * bytes would read as "it changed my text" — and trailing whitespace on the
 * whole, never per line, never the leading indent of a bullet.
 */
function normaliseText(value: string): string {
  return cleanProse(value).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** Empty means null: a channel with no voice guide has none, not "". */
export const VoiceGuideSchema = z
  .string({ error: "The voice guide is text." })
  .max(
    MAX_VOICE_GUIDE_LENGTH,
    `Keep the voice guide under ${MAX_VOICE_GUIDE_LENGTH} characters — a page of it is plenty for the brainstorm to follow.`,
  )
  .transform((value) => {
    const text = normaliseText(value);
    return isBlank(text) ? null : text;
  });

/** `not null` on the table, and a blank one would write blank scripts. */
export const ScriptTemplateSchema = z
  .string({ error: "The script template is text." })
  .max(
    MAX_SCRIPT_TEMPLATE_LENGTH,
    `Keep the script template under ${MAX_SCRIPT_TEMPLATE_LENGTH} characters — it is the shape of a script, not one.`,
  )
  .transform(normaliseText)
  // `isBlank`, not `=== ""`: a template of zero-width characters would write
  // scripts that look empty; the database's `has_visible_text()` agrees.
  .refine((value) => !isBlank(value), {
    message:
      "A script template cannot be empty — every video entering Scripting would start from a blank page. Write at least the heading you always begin with.",
  });

/* -------------------------------------------------------------------------- */
/* The three numbers                                                           */
/* -------------------------------------------------------------------------- */

export const MAX_WIP_THRESHOLD = 99;
export const MAX_STALE_DAYS = 365;

export const WipThresholdSchema = z
  .number({ error: "The WIP threshold is a whole number of videos." })
  .int("A whole number of videos.")
  .min(1, "A threshold of zero would flag every column with anything in it. One is the lowest.")
  .max(MAX_WIP_THRESHOLD, `Keep the threshold under ${MAX_WIP_THRESHOLD}; past that it never fires.`);

export const StaleDaysSchema = z
  .number({ error: "Stale days is a whole number of days." })
  .int("A whole number of days.")
  .min(1, "A card is not stale the moment it arrives. One day is the lowest.")
  .max(MAX_STALE_DAYS, `Keep it under a year (${MAX_STALE_DAYS} days).`);

/**
 * `numeric(5,2)`: a percentage with two decimals. Zero is refused — a video
 * cannot be below an expectation of nothing, so the prompt would never fire
 * and the person would think they had set one. Empty means null, which is
 * the median fallback, and is the only way back to it.
 */
export const ExpectedCtrSchema = z
  .number({ error: "Expected CTR is a percentage, like 4.5." })
  .min(0.01, "A CTR expectation of zero would never be missed. Leave the box empty to fall back to the median instead.")
  .max(100, "A click-through rate is at most 100%.")
  .transform((value) => Math.round(value * 100) / 100);

export type NumberParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function readNumber(raw: string): number {
  const trimmed = raw.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The WIP box, read as a threshold. Never empty: the column is `not null`. */
export function parseWipThreshold(raw: string): NumberParse<number> {
  const parsed = WipThresholdSchema.safeParse(readNumber(raw));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  return { ok: true, value: parsed.data };
}

/** The stale-days box, read as days. Never empty: the column is `not null`. */
export function parseStaleDays(raw: string): NumberParse<number> {
  const parsed = StaleDaysSchema.safeParse(readNumber(raw));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  return { ok: true, value: parsed.data };
}

/** The CTR box, read as a percentage or as "no expectation". */
export function parseExpectedCtr(raw: string): NumberParse<number | null> {
  const trimmed = raw.trim().replace(/%$/, "");
  if (trimmed === "") return { ok: true, value: null };
  const parsed = ExpectedCtrSchema.safeParse(readNumber(trimmed));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  return { ok: true, value: parsed.data };
}

/** A number as its box should print it: `4.5`, not `4.50`; nothing for null. */
export function numberText(value: number | null): string {
  return value === null ? "" : String(value);
}

/* -------------------------------------------------------------------------- */
/* What each setting changes                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the stages are called on this channel, for the sentences below.
 *
 * A stage's name is a label the person may have changed (M7's rename), and a
 * settings note that says "Scripting" to someone whose column is called
 * "Draft" is describing a board that does not exist. The page reads the
 * channel's stages and hands the names in by kind; a missing kind (a
 * hand-edited channel) falls back to the seed's word.
 */
export type StageNames = Readonly<Partial<Record<StageKind, string>>>;

const SEED_NAMES: Readonly<Record<StageKind, string>> = {
  idea: "Idea",
  packaging: "Packaging",
  scripting: "Scripting",
  filming: "Filming",
  editing: "Editing",
  publish_prep: "Publish Prep",
  scheduled: "Scheduled",
  published: "Published",
  repurposed: "Repurposed",
};

export function stageName(names: StageNames, kind: StageKind): string {
  return names[kind] ?? SEED_NAMES[kind];
}

/**
 * The line of prose under each field, given the channel's stage names.
 * Written here so the numbers it quotes come from the same constants `/now`
 * and the swap prompt use — a sentence that said "your last ten" while the
 * code sampled twelve would be the kind of drift a settings screen exists to
 * prevent — and so the stages it names are the channel's own.
 */
export function settingNotes(names: StageNames) {
  const n = (kind: StageKind) => stageName(names, kind);
  return {
    voiceGuide:
      "The brainstorm — Generate 20, Draft hooks and Suggest concepts on a video's Packaging tab — is handed this text verbatim and writes in this voice, never a generic YouTuber's.",
    scriptTemplate: `Copied into a video's script the first time it enters ${n("scripting")}, with ${HOOK_PLACEHOLDER} replaced by the chosen hook. It is your own shape: headings, bullets, prose, a single line — whatever you begin from. Videos already past ${n("scripting")} keep the script they have.`,
    wipThreshold: `The board's column count turns red above this number, on the in-flight stages only — ${n("packaging")} through ${n("scheduled")}. ${n("idea")}, ${n("published")} and ${n("repurposed")} never warn.`,
    staleDays:
      "A card sitting longer than this in one stage is flagged on the board, and the weekly strip flags a column whose median is past it.",
    expectedCtr: `What the swap prompt compares a video's first-24-hour click-through against: below it, /now and the video's page ask "Swap thumbnail?". Leave it empty to use the median of the channel's last ${EXPECTATION_SAMPLE} published videos instead — which needs at least ${MIN_MEDIAN_SAMPLE} of them before it says anything.`,
  } as const;
}

/** The notes with the seed's stage names — for a channel that has renamed nothing. */
export const SETTING_NOTES = settingNotes({});
