import "server-only";

import { capFor, wantedFor } from "./clamp";
import { briefSections, videoParts } from "./prompts";
import type { AssistRequest, ThumbnailVerdict } from "./types";

/**
 * The prompt a person pastes into claude.ai (M11, "Open in Claude").
 *
 * Anthropic does not allow a claude.ai subscription to power a server-side
 * app, so the subscription path is done by hand: this module writes the
 * prompt on the server, the panel copies it, the person runs it in their own
 * conversation and pastes the reply back, and `lib/assist/reply.ts` reads it.
 * Nothing in this app stores, forwards or uses claude.ai credentials; the
 * only thing that crosses is text the person carries themselves.
 *
 * ## One brief, two endings
 *
 * Everything about *the job* — who it is for, the channel's voice guide
 * (fenced, first, and the thing that wins), the fifty published titles, the
 * craft rules for this kind, and everything written on the video — comes from
 * `briefSections` and `videoParts` in `lib/assist/prompts.ts`, the same
 * functions the API prompt is built from. A manual answer is exactly as
 * well-informed as one the key paid for, and tuning the brief is one edit.
 * `manual.test.ts` holds both prompts to carrying the guide and the titles.
 *
 * What differs is the ending. The API prompt ends in a JSON schema the SDK
 * enforces; a person's conversation has no schema, so this one asks for a
 * plain-text shape that is forgiving to read back — one proposal per line,
 * its reason after ` || ` — says in as many words that an app will read it,
 * and puts that instruction *last*, closest to where the answer starts.
 *
 * ## Why it is `server-only`
 *
 * The prompt carries the voice guide and the published titles, and its text
 * is part of PLAN.md's bundle check: no prompt prose in `.next/static`. It is
 * built here and sent to the browser only when somebody presses Open in
 * Claude (`app/actions/assist-manual.ts`).
 */

/** The separator the prompt asks for, and the one `reply.ts` reads first. */
export const MANUAL_SEPARATOR = "||";

/** What each role is called in the prompt and in the reply. */
export const MANUAL_ROLE_WORDS: Record<ThumbnailVerdict["role"], string> = {
  wild_card: "WILD CARD",
  moderate: "MODERATE",
  safe: "SAFE",
};

/** What a line of the answer is called, per kind, in the example. */
const NOUN: Record<Exclude<AssistRequest["kind"], "thumbnail_critique">, string> = {
  titles: "the title",
  concepts: "the concept, as one line",
  hooks: "the hook, word for word, as one line",
};

/** The plain-text shape, for the three kinds that answer with a list. */
function listShape(request: AssistRequest): string {
  if (request.kind === "thumbnail_critique") return critiqueShape(request);
  const want = wantedFor(request);
  const cap = capFor(request);
  const noun = NOUN[request.kind];

  return [
    "## How to answer — please follow this exactly",
    "",
    "I will copy your answer into an app that reads it line by line, so answer in this plain-text shape:",
    "",
    "```",
    `1. <${noun}> ${MANUAL_SEPARATOR} <one sentence: why it works>`,
    `2. <${noun}> ${MANUAL_SEPARATOR} <one sentence: why it works>`,
    "…",
    `PICK: <the number of the strongest> ${MANUAL_SEPARATOR} <one sentence: why it beats the others>`,
    "```",
    "",
    `- ${want === 1 ? "One line" : `${want} lines`}, one proposal per line, numbered.${
      cap > want ? ` Up to ${cap} if the extra ones are genuinely different; anything past ${cap} is dropped.` : ""
    }`,
    `- Put " ${MANUAL_SEPARATOR} " (two vertical bars) between the proposal and its reason. Nothing else on the line.`,
    "- No quotation marks around the proposals, no bold, no headings, no tables. Keep each proposal on its own single line, even a hook of two or three sentences.",
    "- End with the PICK line.",
  ].join("\n");
}

/** The critique's shape: one line per attached image, then the one to ship. */
function critiqueShape(
  request: Extract<AssistRequest, { kind: "thumbnail_critique" }>,
): string {
  const roles = request.variants.map((variant) => variant.role);
  return [
    "## How to answer — please follow this exactly",
    "",
    "I will copy your answer into an app that reads it line by line, so answer in this plain-text shape, one line per image:",
    "",
    "```",
    ...roles.map(
      (role) =>
        `${MANUAL_ROLE_WORDS[role]} ${MANUAL_SEPARATOR} reads: yes or no ${MANUAL_SEPARATOR} adds: yes or no ${MANUAL_SEPARATOR} <one or two sentences to act on>`,
    ),
    `SHIP: <${roles.map((role) => MANUAL_ROLE_WORDS[role].toLowerCase()).join(" | ")} | none>`,
    "```",
    "",
    '- "reads" is whether the image still reads at a 360-pixel tile; "adds" is whether it adds something the title does not already say.',
    `- Start each line with the image's name exactly as written above, and put " ${MANUAL_SEPARATOR} " between the parts.`,
    "- No bold, no headings, no tables. End with the SHIP line.",
  ].join("\n");
}

/**
 * The images, which the person attaches by hand: this app cannot attach
 * anything to a claude.ai conversation. Named in the order the panel lists
 * them, and by the same words the reply is asked to start its lines with.
 */
function attachedSection(
  request: Extract<AssistRequest, { kind: "thumbnail_critique" }>,
): string {
  const count = request.variants.length;
  return [
    "## The images",
    "",
    `I have attached ${count === 1 ? "the thumbnail image" : `${count} thumbnail images`} to this message, in this order:`,
    "",
    ...request.variants.map(
      (variant, index) => `${index + 1}. ${MANUAL_ROLE_WORDS[variant.role]}`,
    ),
    "",
    "If an image is missing, say which in the note for that line rather than guessing.",
  ].join("\n");
}

/**
 * The whole prompt, as one message: claude.ai has one box, so the brief, the
 * video and the answer's shape travel together, in that order.
 *
 * For the critique, `request.variants` names which images exist; their bytes
 * are ignored here (the person attaches the files), so a caller may pass them
 * with an empty `base64`.
 */
export function buildManualPrompt(request: AssistRequest): string {
  const sections = [
    ...briefSections(request),
    ["## The video", "", ...videoParts(request).slice(1)].join("\n\n"),
  ];
  if (request.kind === "thumbnail_critique") sections.push(attachedSection(request));
  sections.push(listShape(request));
  return sections.join("\n\n");
}
