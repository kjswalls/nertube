import { z } from "zod";

import { AssistError, type AssistKind } from "./types";

/**
 * The shape the model is asked to answer in — and *only* the shape.
 *
 * ## Structural only, on purpose
 *
 * PLAN.md is explicit about this (line 155): the schema is structural, counts
 * and lengths live in the prompt, and the clamping happens in code. Two
 * separate reasons, and both of them bite.
 *
 * The first is mechanical. These schemas are handed to the structured-output
 * API through `betaZodOutputFormat`, which runs them through the SDK's
 * `transformJSONSchema` — and that function keeps `minItems` only when it is
 * 0 or 1 and folds every other bound (`maxItems`, `minLength`, `maximum`, …)
 * into the schema's *description* text rather than sending it as a constraint.
 * Verified by reading `node_modules/@anthropic-ai/sdk/lib/transform-json-schema.js`
 * in the installed 0.128.0, not from memory. So a `.max(20)` here would not
 * constrain the model at all — but it *would* still run on our side, where
 * `safeParse` enforces it strictly.
 *
 * Which is the second, and worse, reason: a schema with counts in it turns a
 * 21-title answer into a validation failure. Twenty-one titles is not a
 * failure. It is twenty titles and one more, produced by a model that was
 * asked for twenty and got carried away, and throwing all twenty-one away over
 * an off-by-one is the wrong behaviour by any measure — the person waited
 * thirty seconds and paid for the tokens. So: validate the shape here, clamp
 * the count in `clamp.ts`, keep the work.
 *
 * ## What "structural" means exactly
 *
 * Field names, field types, nesting. Not: how many, how long, which enum
 * member, whether an index is in range. Everything in that second list is a
 * thing the clamp can repair without losing anything, and every one of them
 * is a thing that would otherwise throw away a whole good answer.
 *
 * `role` is a string here rather than an enum for the same reason. A critique
 * that names four variants when three were sent is three good verdicts and one
 * to drop, not a wrong-shape error.
 *
 * Pure: zod only, no key, no SDK. A client component may import it.
 */

/* -------------------------------------------------------------------------- */
/* The wire shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One proposal as the model writes it. The `describe` calls are not comments:
 * `betaZodOutputFormat` carries them into the JSON Schema the model is shown,
 * so they are part of the prompt.
 */
const SuggestionPayload = z.object({
  text: z
    .string()
    .describe("The title, concept or hook itself. No quotes, no numbering."),
  rationale: z
    .string()
    .describe("One sentence: why this one works. Not a restatement of it."),
});

/** `titles`, `concepts` and `hooks` all answer in this shape. */
export const SuggestionsPayload = z.object({
  suggestions: z.array(SuggestionPayload),
  recommended_index: z
    .number()
    .describe(
      "Zero-based index into suggestions of the single strongest option.",
    ),
  /**
   * The comparative sentence. Asked for because the panel marks one proposal
   * as the model's pick and labels a sentence as the reason for it — and until
   * this field existed, the sentence it labelled was the picked item's own
   * `rationale`, which says why that one works, not why it beats the rest.
   *
   * Structural only, like everything else here, and *optional* for the same
   * reason a nine-title answer is not a wrong-shape error: an answer that is
   * useful without it must not be thrown away over it. A missing or empty
   * reason means the panel marks the pick and says nothing else about it,
   * which is what it did before the question was asked at all. The one thing
   * that must never happen is a label with nothing behind it.
   *
   * The `describe` below is not a comment — `betaZodOutputFormat` carries it
   * into the JSON Schema the model is shown — and `prompts.ts` asks for it in
   * as many words, so optional here is about what this code will *accept*,
   * not about what it asks for.
   */
  recommended_reason: z
    .string()
    .optional()
    .describe(
      "One sentence: why the recommended option beats the others in this list. Not a restatement of it.",
    ),
});

export type SuggestionsPayload = z.infer<typeof SuggestionsPayload>;

/** One variant's verdict, as the model writes it. */
const VerdictPayload = z.object({
  role: z
    .string()
    .describe("Exactly one of: wild_card, moderate, safe — as labelled above."),
  reads_at_tile_size: z
    .boolean()
    .describe("True if the image still reads as anything at a 360px tile."),
  complements_title: z
    .boolean()
    .describe(
      "True if it adds something the title does not already say, rather than repeating it.",
    ),
  note: z
    .string()
    .describe("One or two sentences the creator can act on before publishing."),
});

export const CritiquePayload = z.object({
  verdicts: z.array(VerdictPayload),
  recommended_role: z
    .string()
    .describe(
      "The role you would ship, from the ones given. Empty string if none is shippable.",
    ),
});

export type CritiquePayload = z.infer<typeof CritiquePayload>;

/** The schema for a kind. One place, so the prompt and the parse agree. */
export function payloadSchemaFor(
  kind: AssistKind,
): typeof SuggestionsPayload | typeof CritiquePayload {
  return kind === "thumbnail_critique" ? CritiquePayload : SuggestionsPayload;
}

/* -------------------------------------------------------------------------- */
/* Reading an answer                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Two hundred characters of whatever the model actually said, for the log.
 * Never rendered — the sentence the person sees is the `AssistError`'s — but
 * without it "wrong shape" is unfalsifiable at three in the morning.
 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * The model's text → a validated payload, or the two typed errors that a bad
 * answer earns.
 *
 * `malformed` is "that was not JSON" — a truncated response, a refusal written
 * as prose, an HTML error page from something in the middle. `wrong_shape` is
 * "that was JSON, but not this JSON" — the model answered `{titles: [...]}`,
 * or sent a bare array, or used `reason` where the schema says `rationale`.
 * They are different bugs and the log should be able to tell them apart.
 */
export function parseModelText(
  kind: AssistKind,
  text: string,
): SuggestionsPayload | CritiquePayload {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new AssistError("malformed", {
      detail: `Response was not JSON: ${excerpt(text)}`,
      cause,
    });
  }

  const parsed = payloadSchemaFor(kind).safeParse(json);
  if (!parsed.success) {
    throw new AssistError("wrong_shape", {
      detail: `Response did not match the ${kind} schema: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}. Body: ${excerpt(text)}`,
    });
  }

  return parsed.data;
}
