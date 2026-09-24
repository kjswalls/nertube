import "server-only";

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { assemble } from "./clamp";
import { measureCall, worstCaseMicros, type CallOutcome, type MeasuredCall } from "./spend";
import { buildSystemPrompt, buildUserMessage } from "./prompts";
import { parseModelText, payloadSchemaFor } from "./schema";
import {
  AssistError,
  DEFAULT_ASSIST_TIMEOUT_MS,
  isAssistError,
  toAssistError,
  type AssistCallOptions,
  type AssistProvider,
  type AssistRequest,
  type AssistResult,
} from "./types";

/**
 * The real provider: Anthropic's API, behind the interface in `types.ts`.
 *
 * ## What is verified, and how
 *
 * This container has **no `ANTHROPIC_API_KEY` and no route to
 * api.anthropic.com**, so not one line of this file has ever run against the
 * real endpoint, and it never will here. That makes "I remember the parameter
 * is called X" worthless as a standard of evidence. Every API detail below was
 * read out of the installed package — `@anthropic-ai/sdk` 0.128.0, its
 * `resources/beta/messages/messages.d.ts` and `helpers/beta/zod.d.ts` — or out
 * of the `claude-api` skill that ships with this environment. What exercises
 * it instead is `anthropic.test.ts`, which hands the SDK a stub `fetch` and
 * asserts both on the request the SDK builds and on how each kind of response
 * is handled. Nothing here is claimed that could not be checked that way.
 *
 * The specifics, with provenance:
 *
 * - **`claude-opus-5`** — the model id, from the skill's model table.
 *   Overridable with `ANTHROPIC_MODEL`, as PLAN.md specifies.
 * - **`output_config: { effort: "medium" }`** — PLAN.md's decision (line 248).
 *   The installed `BetaOutputConfig` has exactly `effort`, `format` and
 *   `task_budget`, and `effort` takes `low | medium | high | xhigh | max`.
 *   Effort lives *inside* `output_config`; there is no top-level `effort`.
 * - **`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`** —
 *   also PLAN.md (line 248). The installed types declare
 *   `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'` and list that
 *   flag in `AnthropicBeta`. The scalar `"default"` form pairs with the
 *   `-07-01` flag; the array form pairs with `-06-01`, and crossing them is a
 *   400. It means a policy refusal is retried server-side on a substitute
 *   model, so one declined brainstorm is not a dead end.
 * - **No `thinking` parameter.** On this model thinking is on and adaptive by
 *   default, and `budget_tokens` was removed — sending it is a 400. Depth is
 *   `effort`, and nothing else.
 * - **Structured output through `betaZodOutputFormat`.** Its own docstring
 *   says it may be passed to `.create()` directly and that no automatic
 *   parsing happens then, which is exactly what is wanted: the schema
 *   constrains the model, and *we* parse, so a bad body becomes one of our
 *   typed errors instead of an SDK exception. (Why the schema carries no
 *   counts: the long note in `schema.ts`.)
 * - **`structured-outputs-2025-12-15` alongside the fallback beta.** This was
 *   the one detail in this file asserted from outside the package, and it was
 *   asserted wrongly — by omission. `output_config.format` is being sent to
 *   the *beta* messages endpoint, and the SDK's own structured-output entry
 *   point on that namespace (`client.beta.messages.parse`, at
 *   `resources/beta/messages/messages.js:75-83` in the installed 0.128.0)
 *   unconditionally adds that exact flag on top of whatever `betas` the caller
 *   passed. The plain `create()` two methods above it adds nothing of its own
 *   — it forwards `betas` and no more — so a direct `create()` call sends only
 *   what is listed here. Going without it is a request the vendor may reject
 *   as malformed on 100% of production calls, surfacing as `rejected` ("that
 *   is a bug in this app") with nobody able to find out from this container.
 *   Going with it, if it turns out to be unnecessary, costs an ignored header.
 *   `anthropic.test.ts` asserts both flags are on the wire, so this is pinned
 *   rather than remembered.
 * - **`stop_reason: "refusal"` with `stop_details`.** `BetaStopReason`
 *   includes `refusal`; `stop_details` is `BetaRefusalStopDetails | null`,
 *   carrying `category` and `explanation`. Checked before the content is
 *   touched, because a refusal has no JSON in it — this is PLAN.md's "a
 *   refusal surfaces as a message, not a crash", at the only place it can be
 *   honoured.
 *
 * ## The key
 *
 * Read from `process.env` inside `run()`, never at module scope, and this file
 * imports `server-only`: a client component that reaches this module fails the
 * build rather than shipping a key to a browser. `server-only` costs nothing
 * at the dependency ceiling — Next aliases the bare specifier to its own
 * bundled copy and declares the module in `next/types/global.d.ts`. Vitest has
 * no such alias, so `vitest.config.mts` points the specifier at Next's
 * `empty.js`, the same stub the server build uses.
 */

/** From the `claude-api` skill's current model table. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Twenty titles with rationales is a couple of thousand output tokens; the
 * rest is headroom for adaptive thinking, which is on by default on this
 * model. 16k is the documented default for a non-streaming request — large
 * enough not to truncate, small enough to stay inside HTTP timeouts.
 */
export const MAX_TOKENS = 16_000;

/** Pairs with the scalar `fallbacks: "default"`. Present in `AnthropicBeta`. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * What `client.beta.messages.parse` sends for `output_config.format`, copied
 * from the installed SDK's own source rather than from memory. See the note
 * above: `create()` adds no beta of its own, so structured output on the beta
 * endpoint has to carry its flag from here.
 */
const STRUCTURED_OUTPUT_BETA = "structured-outputs-2025-12-15";

/** Both flags, in the order the SDK would send them. */
export const REQUIRED_BETAS = [FALLBACK_BETA, STRUCTURED_OUTPUT_BETA] as const;

/**
 * The SDK retries 429s, 5xx *and timeouts* twice by default, so the worst case
 * would be three times the deadline — well past the 60 seconds PLAN.md gives
 * the segment. This call is one thing a person is watching a spinner for, so
 * the retry is theirs: one attempt, a typed error, and a button that says ask
 * again.
 */
const MAX_RETRIES = 0;

/** Test seams and deployment overrides. Everything defaults to the environment. */
export interface AnthropicProviderOptions {
  /** Overrides `ANTHROPIC_API_KEY`. */
  readonly apiKey?: string;
  /** Overrides `ANTHROPIC_MODEL`, which itself overrides {@link DEFAULT_MODEL}. */
  readonly model?: string;
  /** Overrides the SDK's base URL. */
  readonly baseURL?: string;
  /** Defaults to {@link MAX_RETRIES}. */
  readonly maxRetries?: number;
  /**
   * The transport. The unit tests pass a stub here: it is how the real
   * provider is exercised — request body included — with no network.
   */
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  /**
   * Told about every response that came back from the API (M11): what it
   * cost, priced by `measureCall` in `spend.ts`, and how the call ended —
   * `answered`, `refused` (`stop_reason: "refusal"`), or `failed` (a 200 whose
   * body could not be used: not JSON, the wrong shape, empty, cut off). All
   * three were billed, so all three are reported. A request that got no
   * response at all — a 4xx or 5xx, a dropped socket, our own timeout — has
   * no usage to report; it goes to `onNoUsage` instead.
   *
   * Awaited before `run()` settles, so a recorder that writes to the
   * database has written by the time the answer is shown. Whatever it
   * throws is logged and swallowed: a call that has been made and paid for
   * must still hand back its answer.
   */
  readonly onUsage?: (call: MeasuredCall, outcome: CallOutcome) => unknown;
  /**
   * Called once the request is built and before it is sent (M11 review,
   * finding 1), with the most it can cost (`worstCaseMicros` in `spend.ts`).
   * Whatever it throws is what `run()` throws, and **nothing is sent**: this
   * is where the server action reserves the worst case against the monthly
   * cap, and refuses.
   */
  readonly beforeSend?: (worst: {
    readonly requestedModel: string;
    readonly costMicros: number;
  }) => Promise<void> | void;
  /**
   * Told when the request got no response to price (M11 review, finding 2):
   * `mayHaveBilled` is true for our own timeout, an abort or a dropped
   * connection — the API may have run the whole call and billed it — and
   * false when the API answered with an error status, which bills nothing.
   * Awaited, and whatever it throws is logged and swallowed.
   */
  readonly onNoUsage?: (mayHaveBilled: boolean) => unknown;
}

/**
 * Build the provider. Cheap and synchronous: no client is constructed and no
 * environment variable is read until a call is actually made, so importing
 * this module in a keyless environment is harmless.
 */
export function createAnthropicProvider(
  options: AnthropicProviderOptions = {},
): AssistProvider {
  return {
    name: "anthropic",
    async run(request, callOptions) {
      try {
        return await callAnthropic(request, options, callOptions ?? {});
      } catch (error) {
        throw toAssistError(error);
      }
    },
  };
}

async function callAnthropic(
  request: AssistRequest,
  options: AnthropicProviderOptions,
  callOptions: AssistCallOptions,
): Promise<AssistResult> {
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (apiKey === "") {
    throw new AssistError("not_configured", {
      detail:
        "ANTHROPIC_API_KEY is empty or unset in this environment. Set it in the deployment's server-side environment variables.",
    });
  }

  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

  const client = new Anthropic({
    apiKey,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const system = buildSystemPrompt(request);
  const format = betaZodOutputFormat(payloadSchemaFor(request.kind));
  const content = buildContent(request);

  // The most this can cost, reserved before anything leaves (see `beforeSend`).
  if (options.beforeSend) {
    await options.beforeSend({
      requestedModel: model,
      costMicros: worstCaseMicros({
        textBytes:
          Buffer.byteLength(system) +
          Buffer.byteLength(buildUserMessage(request)) +
          Buffer.byteLength(JSON.stringify(format)),
        images: request.kind === "thumbnail_critique" ? request.variants.length : 0,
        maxTokens: MAX_TOKENS,
      }),
    });
  }

  const startedAt = Date.now();
  let message;
  try {
    message = await client.beta.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        betas: [...REQUIRED_BETAS],
        // A refusal is retried server-side on a substitute model chosen by the
        // API, so a single declined request is not a dead end.
        fallbacks: "default",
        output_config: {
          effort: "medium",
          format,
        },
        system,
        messages: [{ role: "user", content }],
      },
      {
        timeout: callOptions.timeoutMs ?? DEFAULT_ASSIST_TIMEOUT_MS,
        ...(callOptions.signal === undefined
          ? {}
          : { signal: callOptions.signal }),
      },
    );
  } catch (error) {
    await reportNoUsage(options.onNoUsage, mayHaveBilled(error));
    throw mapSdkError(error);
  }

  const elapsedMs = Date.now() - startedAt;

  // From here on the call has been billed, whatever happens to the answer.
  const measured = measureCall(message, model);
  let outcome: CallOutcome = "failed";
  try {
    const result = readMessage(request, message, model, elapsedMs);
    outcome = "answered";
    return result;
  } catch (error) {
    if (isAssistError(error) && error.code === "refused") outcome = "refused";
    throw error;
  } finally {
    await reportUsage(options.onUsage, measured, outcome);
  }
}

/** Hand a priced call to the caller's recorder, never letting it fail the call. */
async function reportUsage(
  onUsage: AnthropicProviderOptions["onUsage"],
  measured: MeasuredCall,
  outcome: CallOutcome,
): Promise<void> {
  if (!onUsage) return;
  try {
    await onUsage(measured, outcome);
  } catch (error) {
    console.error(
      "[assist] a billed call could not be recorded:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Could a request that failed this way still have been billed? Only when the
 * API never told us otherwise: an error *status* is the API refusing the
 * request, which bills nothing; a timeout, an abort or a dropped connection
 * may have cut off a call the API ran to the end.
 */
function mayHaveBilled(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true; // includes our timeout
  if (error instanceof APIUserAbortError) return true;
  if (error instanceof APIError) return typeof error.status !== "number" || error.status === 0;
  return true;
}

/** Tell the caller no usage came back, never letting it fail the call. */
async function reportNoUsage(
  onNoUsage: AnthropicProviderOptions["onNoUsage"],
  billed: boolean,
): Promise<void> {
  if (!onNoUsage) return;
  try {
    await onNoUsage(billed);
  } catch (error) {
    console.error(
      "[assist] a call with no response could not be closed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Turn a response the API sent back into an answer, or the error it is. */
function readMessage(
  request: AssistRequest,
  message: BetaMessage,
  model: string,
  elapsedMs: number,
): AssistResult {
  // A refusal carries no JSON, so it is checked before the content is read.
  // With `fallbacks: "default"` this means the substitute declined as well —
  // the whole chain said no.
  if (message.stop_reason === "refusal") {
    throw new AssistError("refused", {
      ...(message.stop_details?.category
        ? { category: message.stop_details.category }
        : {}),
      detail:
        message.stop_details?.explanation ??
        "The API returned stop_reason 'refusal' with no explanation.",
    });
  }

  const text = message.content
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("")
    .trim();

  if (text === "") {
    // `max_tokens` here means the JSON was cut off mid-object, which reads as
    // an unreadable answer rather than as an empty one.
    throw new AssistError(
      message.stop_reason === "max_tokens" ? "malformed" : "empty",
      {
        detail: `No text block in the response (stop_reason: ${message.stop_reason ?? "null"}).`,
      },
    );
  }

  const payload = parseModelText(request.kind, text);

  return assemble(request, payload, {
    provider: "anthropic",
    model: message.model ?? model,
    elapsedMs,
    servedByFallback: servedByFallback(message, model),
  });
}

/* -------------------------------------------------------------------------- */
/* Request content                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The user turn. Prose for the three generative kinds; for the critique, the
 * images first and then the prose, so the instructions are the last thing read
 * — and each image labelled by role in the text, because the API takes the
 * blocks in order and the model needs to know which tile is the wild card.
 */
function buildContent(request: AssistRequest) {
  const prose = buildUserMessage(request);
  if (request.kind !== "thumbnail_critique") return prose;

  return [
    ...request.variants.map((variant) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: variant.mediaType,
        data: variant.base64,
      },
    })),
    { type: "text" as const, text: prose },
  ];
}

/**
 * Did a substitute model answer? Two signals, because either can be absent:
 * the `fallback_message` iteration entry the SDK documents, and the plain fact
 * that the response names a different model than the request asked for.
 */
function servedByFallback(
  message: { model?: string; usage?: { iterations?: unknown } },
  requested: string,
): boolean {
  const iterations = message.usage?.iterations;
  if (
    Array.isArray(iterations) &&
    iterations.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "fallback_message",
    )
  ) {
    return true;
  }
  return typeof message.model === "string" && message.model !== requested;
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every way the SDK can fail → one of our codes → one sentence for a person.
 *
 * Ordered most specific first, as the SDK's own error guidance asks: the
 * subclasses (`APIConnectionTimeoutError` before `APIConnectionError`,
 * `RateLimitError` before the generic `APIError`) would otherwise be swallowed
 * by their parents. Status codes are read off `APIError.status` rather than
 * matched on message text.
 */
function mapSdkError(error: unknown): AssistError {
  if (error instanceof AssistError) return error;

  if (error instanceof APIUserAbortError) {
    return new AssistError("cancelled", { detail: error.message, cause: error });
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AssistError("timeout", { detail: error.message, cause: error });
  }
  if (error instanceof APIConnectionError) {
    return new AssistError("unreachable", {
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof RateLimitError) {
    const retryAfter = retryAfterSeconds(error);
    return new AssistError("rate_limited", {
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      detail: error.message,
      cause: error,
    });
  }
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError
  ) {
    // The variable's name belongs here and nowhere else: `detail` is logged
    // on the server and never rendered, so the person who can fix it reads it
    // and the person using the app does not.
    return new AssistError("unauthorized", {
      detail: `${error.message} — check ANTHROPIC_API_KEY in the deployment's server-side environment.`,
      cause: error,
    });
  }
  if (
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError
  ) {
    return new AssistError("rejected", { detail: error.message, cause: error });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === "number" ? error.status : 0;
    if (status === 0 || status >= 500 || status === 408 || status === 409) {
      return new AssistError("upstream", {
        detail: `${status || "no status"}: ${error.message}`,
        cause: error,
      });
    }
    return new AssistError("rejected", {
      detail: `${status}: ${error.message}`,
      cause: error,
    });
  }
  // An `AbortError` from the caller's own signal, if it ever reaches here
  // without the SDK wrapping it.
  if (error instanceof Error && error.name === "AbortError") {
    return new AssistError("cancelled", { detail: error.message, cause: error });
  }
  return toAssistError(error);
}

/** `retry-after` in whole seconds, when the API sent one we can believe. */
function retryAfterSeconds(error: RateLimitError): number | undefined {
  const header = error.headers?.get?.("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds);
}
