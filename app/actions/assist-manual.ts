"use server";

import { z } from "zod";

import {
  isAssistError,
  MANUAL_PROVIDER,
  type AssistErrorCode,
  type AssistMeta,
} from "@/lib/assist/types";
import { loadCritiqueRequest, loadTextRequest } from "@/lib/assist/load";
import { buildManualPrompt } from "@/lib/assist/manual";
import { createPastedProvider, MAX_REPLY_LENGTH } from "@/lib/assist/reply";
import { signedUrlsFor, type ThumbnailRole } from "@/lib/storage";
import { requireUser } from "@/lib/supabase/require-user";
import {
  STORED_ASSIST_KINDS,
  type StoredAssistEntryValue,
} from "@/components/assist/stored";

import type { AssistState, CritiqueState } from "./assist";

/**
 * "Open in Claude" — the manual path for every assist (M11).
 *
 * Anthropic does not allow a claude.ai subscription to power a server-side
 * app, so this path is done by hand and this file never talks to claude.ai:
 *
 * 1. `assistPrompt` / `critiquePrompt` build the prompt **on the server**,
 *    from the same inputs the API path reads (`lib/assist/load.ts`) and the
 *    same brief (`lib/assist/manual.ts` over `lib/assist/prompts.ts`), and
 *    hand it to the browser only because somebody pressed Open in Claude.
 * 2. The panel copies it and opens claude.ai/new; the person runs it in
 *    their own conversation, under their own account.
 * 3. `readPastedReply` / `readPastedCritique` take the text they pasted back
 *    and run it through `createPastedProvider` — one more implementation of
 *    the one `AssistProvider` seam — so it is clamped, capped and
 *    de-duplicated by the same `assemble()` a model's answer is, and comes
 *    back in exactly the shape `assist()` and `critiqueThumbnails()` return.
 *    The panels hand it to the same `useAssistRun`, draw the same proposal
 *    list and accept through the same save queue.
 *
 * Nothing here reads, stores or forwards anything of claude.ai's — no
 * cookie, no token, no credential. The only thing that crosses is text the
 * person carries across themselves, and nothing here spends an API key.
 *
 * Like `assist()`, every action answers with data and never throws: a reply
 * that cannot be read comes back as a sentence saying what was expected, and
 * the panel keeps the pasted text in its box.
 */

/** A prompt, or the sentence saying why there is none. */
export type ManualPromptState =
  | { ok: true; prompt: string }
  | { ok: false; message: string };

/** One image the person has to attach by hand, and where to get it. */
export interface ManualImage {
  readonly role: ThumbnailRole;
  /** A signed URL to the file, or null when it could not be signed. */
  readonly url: string | null;
}

export type ManualCritiquePromptState =
  | { ok: true; prompt: string; images: readonly ManualImage[] }
  | { ok: false; message: string };

const TextKind = z.enum(STORED_ASSIST_KINDS);

const PromptInput = z.object({ videoId: z.uuid(), kind: TextKind });
const CritiquePromptInput = z.object({ videoId: z.uuid() });

/*
  The reply is bounded here as well as in the parser: a server action is a
  request body, and a body far longer than any answer to these prompts is not
  one worth reading. The parser's own ceiling is what produces the sentence.
*/
const Reply = z.string().max(MAX_REPLY_LENGTH * 2);
const ReplyInput = z.object({ videoId: z.uuid(), kind: TextKind, reply: Reply });
const CritiqueReplyInput = z.object({ videoId: z.uuid(), reply: Reply });

const NOT_A_VIDEO = "That is not a video this panel can ask about.";

/* -------------------------------------------------------------------------- */
/* The prompts                                                                 */
/* -------------------------------------------------------------------------- */

export async function assistPrompt(input: {
  videoId: string;
  kind: "titles" | "concepts" | "hooks";
}): Promise<ManualPromptState> {
  const parsed = PromptInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_A_VIDEO };
  const { supabase } = await requireUser();
  try {
    const { request } = await loadTextRequest(supabase, parsed.data.videoId, parsed.data.kind);
    return { ok: true, prompt: buildManualPrompt(request) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

export async function critiquePrompt(input: {
  videoId: string;
}): Promise<ManualCritiquePromptState> {
  const parsed = CritiquePromptInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_A_VIDEO };
  const { supabase } = await requireUser();
  try {
    const { request, uploaded } = await loadCritiqueRequest(supabase, parsed.data.videoId);
    /*
      The files, for the person to attach: claude.ai cannot be handed an
      image by this app, so the panel links to each one. Signed with the
      caller's own client, through the same storage policy a thumbnail on the
      page is — one round trip for all three, an hour's life, as elsewhere.
    */
    const urls = await signedUrlsFor(
      supabase,
      uploaded.map((variant) => variant.path),
    );
    return {
      ok: true,
      prompt: buildManualPrompt(request),
      images: uploaded.map((variant) => ({
        role: variant.role,
        url: urls.get(variant.path) ?? null,
      })),
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the reply back                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A pasted reply to one of the three text assists → the same answer, stored
 * the same way, that `assist()` produces.
 *
 * The entry written to `videos.brainstorm_last` is field for field the one
 * `assist()` writes, through the same `merge_brainstorm_entry` function —
 * the column's one write path — with `provider: "manual"` and
 * `model: "claude.ai"`, so a panel reopened tomorrow says where it came from.
 */
export async function readPastedReply(input: {
  videoId: string;
  kind: "titles" | "concepts" | "hooks";
  reply: string;
}): Promise<AssistState> {
  const parsed = ReplyInput.safeParse(input);
  if (!parsed.success) {
    const kind = TextKind.safeParse(input?.kind);
    return failed(
      kind.success ? kind.data : "titles",
      "rejected",
      typeof input?.reply === "string" && input.reply.length > MAX_REPLY_LENGTH
        ? "That is far longer than any answer to this prompt. Paste only Claude’s reply to it."
        : NOT_A_VIDEO,
    );
  }
  const { videoId, kind, reply } = parsed.data;
  const { supabase } = await requireUser();

  let entry: StoredAssistEntryValue;
  let meta: AssistMeta;
  try {
    const { request, voiceGuide } = await loadTextRequest(supabase, videoId, kind);
    const result = await createPastedProvider(reply).run(request);
    if (result.kind === "thumbnail_critique") {
      // Unreachable: the request was a text kind. The union makes it sayable.
      return failed(kind, "wrong_shape", "That reply was read as a critique.");
    }
    meta = result.meta;
    entry = {
      at: new Date().toISOString(),
      provider: result.meta.provider,
      model: result.meta.model,
      voiceGuide,
      suggestions: result.suggestions.map((suggestion) => ({
        text: suggestion.text,
        rationale: suggestion.rationale,
      })),
      recommended: result.recommended,
      recommendedReason: result.recommendedReason,
    };
  } catch (error) {
    return failedWith(kind, error);
  }

  const { error: writeError } = await supabase.rpc("merge_brainstorm_entry", {
    p_video: videoId,
    p_kind: kind,
    p_entry: entry,
  });

  return { ok: true, kind, data: entry, meta, persisted: !writeError };
}

/**
 * A pasted critique → the same answer `critiqueThumbnails()` produces.
 *
 * Not stored, exactly as the API's is not: a verdict is about the images in
 * the bucket at the moment it was written, and a kept one reads as current
 * after a variant has been replaced (M8). Only the variants that exist are
 * judged; a verdict about an empty slot is dropped and counted by the clamp.
 */
export async function readPastedCritique(input: {
  videoId: string;
  reply: string;
}): Promise<CritiqueState> {
  const parsed = CritiqueReplyInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "rejected",
      message: NOT_A_VIDEO,
      retryable: false,
      retryAfterSeconds: null,
      provider: MANUAL_PROVIDER,
    };
  }
  const { supabase } = await requireUser();
  try {
    const { request } = await loadCritiqueRequest(supabase, parsed.data.videoId);
    const result = await createPastedProvider(parsed.data.reply).run(request);
    if (result.kind !== "thumbnail_critique") {
      return {
        ok: false,
        code: "wrong_shape",
        message: "That reply was not read as a critique.",
        retryable: false,
        retryAfterSeconds: null,
        provider: MANUAL_PROVIDER,
      };
    }
    return {
      ok: true,
      data: {
        verdicts: result.verdicts,
        recommendedRole: result.recommendedRole,
        skipped: [],
      },
      meta: result.meta,
      persisted: true,
    };
  } catch (error) {
    const { code, message } = codeAndMessage(error);
    return {
      ok: false,
      code,
      message,
      retryable: false,
      retryAfterSeconds: null,
      provider: MANUAL_PROVIDER,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Failure, as data                                                            */
/* -------------------------------------------------------------------------- */

function codeAndMessage(error: unknown): { code: AssistErrorCode; message: string } {
  if (isAssistError(error)) return { code: error.code, message: error.message };
  return {
    code: "upstream",
    message: "That could not be read, for a reason this app did not recognise. Nothing was changed.",
  };
}

function messageOf(error: unknown): string {
  return codeAndMessage(error).message;
}

/**
 * A failed read. Never "retryable": pressing Read again on the same text
 * gives the same answer, so the panel offers the box instead of a button.
 * `provider` is what tells the panel this failure belongs to the paste box
 * rather than to an API ask.
 */
function failed(
  kind: "titles" | "concepts" | "hooks",
  code: AssistErrorCode,
  message: string,
): AssistState {
  return {
    ok: false,
    kind,
    code,
    message,
    retryable: false,
    retryAfterSeconds: null,
    provider: MANUAL_PROVIDER,
  };
}

function failedWith(kind: "titles" | "concepts" | "hooks", error: unknown): AssistState {
  const { code, message } = codeAndMessage(error);
  return failed(kind, code, message);
}
