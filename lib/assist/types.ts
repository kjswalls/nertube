/**
 * The assist boundary: what the app is allowed to know about the model.
 *
 * BRIEF.md asks for the Claude brainstorm to sit "behind a small, swappable
 * service module". This file is the seam. Everything above it — the server
 * action, the panel, the pills on the packaging block — speaks only these
 * types. Nothing above it imports `@anthropic-ai/sdk`, names a model, knows
 * what a `stop_reason` is, or can tell whether the answer came from Anthropic,
 * from the deterministic fake, or from whatever replaces both next year.
 *
 * There are three deliberate properties here.
 *
 * **One method, not four.** `run(request)` takes a discriminated request and
 * returns a discriminated result. Adding a fifth kind of assist is a new member
 * of two unions and a new branch in each provider — it is not a new method on
 * an interface that two implementations and every test double have to grow.
 *
 * **No generics on `run`.** A mapped return type (`titles in → titles out`)
 * reads well at the call site and costs every implementation a cast, because
 * TypeScript cannot prove that the branch which built a titles result is the
 * branch that was handed a titles request. The caller narrows on `result.kind`
 * instead: one `if` at a call site that already knows what it asked for, and no
 * `as` anywhere in the providers.
 *
 * **Failure is typed, not thrown as prose.** Everything that can go wrong with
 * a model call is an {@link AssistError} carrying a {@link AssistErrorCode} and
 * a sentence a person can read. PLAN.md's review note for M8 names three of
 * them (the key never reaching the browser, a 21-title answer being clamped
 * rather than discarded, a refusal arriving as a message rather than a crash);
 * the rest of the list — timeout, rate limit, 5xx, non-JSON, wrong-shape JSON,
 * empty answer, the person closing the panel mid-flight — is here because a
 * model call is the only part of this app that is slow, non-deterministic,
 * occasionally unwilling, and metered.
 *
 * This module is pure types and one error class: no `server-only`, no SDK, no
 * key. A client component may import it.
 */

/* -------------------------------------------------------------------------- */
/* What the app can ask for                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The four things the app asks a model for, one per assist control that M0–M7
 * placed on the page:
 *
 * - `titles` — the "Generate 20" pill beside the title candidates.
 * - `concepts` — "Suggest concepts", beside the thumbnail *concept* (the text
 *   locked at packaging, never the image files; BRIEF.md principle 2).
 * - `hooks` — "Draft a third", beside the hooks editor.
 * - `thumbnail_critique` — "Critique at tile size", in the Thumbnails section,
 *   the one kind that looks at pixels rather than producing prose.
 */
export type AssistKind = "titles" | "concepts" | "hooks" | "thumbnail_critique";

/** Every kind, in the order the page presents them. Iterated by tests. */
export const ASSIST_KINDS: readonly AssistKind[] = [
  "titles",
  "concepts",
  "hooks",
  "thumbnail_critique",
];

/**
 * The channel's half of the prompt.
 *
 * `voiceGuide` is the reason that field exists at all: BRIEF.md says the
 * brainstorm "must accept an optional voice guide document per channel and
 * condition output on it. Never produce generic-YouTuber voice." `pastTitles`
 * is the evidence that backs it up — what this channel has actually shipped.
 */
export interface ChannelContext {
  /** The channel's name, so the model can address the right person's channel. */
  readonly name: string;
  /** `channels.voice_guide`, verbatim, or null when the user has not written one. */
  readonly voiceGuide: string | null;
  /** Past titles from this channel, most recent first. Style evidence. */
  readonly pastTitles: readonly string[];
}

/**
 * The video's half of the prompt: what the person has already written down.
 * Every field is what is in the row right now, not a cleaned-up version of it.
 */
export interface VideoContext {
  /** `videos.title` — the working title. May be empty for a fresh idea. */
  readonly title: string;
  /** `videos.one_line_hook` — the capture-time one-liner. */
  readonly oneLineHook: string | null;
  /** `videos.notes` — the free-form notes. */
  readonly notes: string | null;
  /** `videos.tags`. */
  readonly tags: readonly string[];
  /** `videos.thumbnail_concept` — the written concept, when there is one. */
  readonly thumbnailConcept: string | null;
}

/** A thumbnail variant handed to the critique, as bytes the model can see. */
export interface ThumbnailVariantImage {
  /** `wild_card | moderate | safe` — BRIEF.md principle 7. */
  readonly role: "wild_card" | "moderate" | "safe";
  /** The image's media type, as the storage bucket reports it. */
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** Base64 of the file's bytes. Read server-side; never round-trips the browser. */
  readonly base64: string;
}

interface RequestBase {
  readonly video: VideoContext;
  readonly channel: ChannelContext;
}

/**
 * Ten to twenty title candidates, each with a reason, and a recommended pick.
 * BRIEF.md: "Title generation returns 10–20 options with a short rationale
 * each and a recommended pick, not a flat list."
 */
export interface TitlesRequest extends RequestBase {
  readonly kind: "titles";
  /** How many to ask for. Prompt-side; see `lib/assist/clamp.ts`. */
  readonly want?: number;
  /** Candidates already on the video, so the answer does not repeat them. */
  readonly existing?: readonly string[];
}

/** Thumbnail *concepts* — descriptions to film against, not image files. */
export interface ConceptsRequest extends RequestBase {
  readonly kind: "concepts";
  readonly want?: number;
  /** The concept already written, when there is one. */
  readonly existing?: readonly string[];
}

/**
 * The hooks not yet written. The column holds at most three
 * (`jsonb_array_length(hooks) <= 3`), so the interesting number is how many are
 * missing — which is why `existing` is not optional here.
 */
export interface HooksRequest extends RequestBase {
  readonly kind: "hooks";
  readonly want?: number;
  /** The hooks already written, verbatim. */
  readonly existing: readonly string[];
}

/** Judge the uploaded variants against the locked concept, at tile size. */
export interface ThumbnailCritiqueRequest extends RequestBase {
  readonly kind: "thumbnail_critique";
  readonly variants: readonly ThumbnailVariantImage[];
}

export type AssistRequest =
  | TitlesRequest
  | ConceptsRequest
  | HooksRequest
  | ThumbnailCritiqueRequest;

/* -------------------------------------------------------------------------- */
/* What comes back                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One proposal. `text` is the thing itself; `rationale` is why, in a line.
 *
 * The rationale is not decoration: it is what makes the list judgeable at a
 * glance, and when a candidate is accepted it becomes that candidate's `note`
 * — which is why `clamp.ts` keeps it inside `MAX_CANDIDATE_NOTE_LENGTH`.
 */
export interface AssistSuggestion {
  readonly text: string;
  readonly rationale: string;
}

/** One variant's verdict, from the critique. */
export interface ThumbnailVerdict {
  /** The role this verdict is about. Only roles that were sent survive clamping. */
  readonly role: "wild_card" | "moderate" | "safe";
  /** Does it still read at a 360px tile? */
  readonly readsAtTileSize: boolean;
  /** Does it *add* to the title rather than repeat it? (Packaging checklist.) */
  readonly complementsTitle: boolean;
  /** The sentence a person acts on. */
  readonly note: string;
}

/**
 * What the app learned about the call itself: how much was asked for, how much
 * came back, and what this module did to it before handing it over.
 *
 * The UI shows parts of this. "The model sent 21; the twenty best are here" is
 * a better sentence than silence, and it is the difference between clamping and
 * hiding. It is also stored with the result in `videos.brainstorm_last`, so a
 * panel reopened tomorrow can still explain itself.
 */
export interface AssistMeta {
  /**
   * Which implementation answered, by its own `name`.
   *
   * A plain string rather than a union of the two that ship today: the point
   * of this seam is that a third implementation is a new file, and a closed
   * union would make it an edit to *this* file as well. Readers that care
   * compare against `"fake"`, which is the one value with a meaning attached —
   * an answer nobody asked a model for, which the panel must say out loud.
   */
  readonly provider: string;
  /** The model id, or `"fixtures"` for the fake. */
  readonly model: string;
  /** What the prompt asked for. */
  readonly requested: number;
  /** What the model actually returned, before clamping. */
  readonly returned: number;
  /** Dropped for being past the cap. The clamp, in one number. */
  readonly droppedOverflow: number;
  /** Dropped for already being on the video. */
  readonly droppedDuplicates: number;
  /** Dropped for being blank, or too long to be the field it is destined for. */
  readonly droppedUnusable: number;
  /** True when the model's recommended index had to be pulled into range. */
  readonly recommendationAdjusted: boolean;
  /**
   * True when a server-side fallback model answered instead of the one asked
   * for (see `fallbacks` in `anthropic.ts`). Worth showing: the voice may be
   * slightly different from the usual.
   */
  readonly servedByFallback: boolean;
  /** Wall-clock milliseconds for the call, as this module measured it. */
  readonly elapsedMs: number;
}

interface ResultBase {
  readonly meta: AssistMeta;
}

/** The three generative kinds all return a ranked list of proposals. */
export interface SuggestionsResult extends ResultBase {
  readonly kind: "titles" | "concepts" | "hooks";
  readonly suggestions: readonly AssistSuggestion[];
  /**
   * Index into `suggestions` of the recommended pick, or `null` when there is
   * nothing to recommend (an empty list after clamping). Always in range.
   */
  readonly recommended: number | null;
  /**
   * Why that one beats the others — a *comparative* sentence, which is a
   * different datum from the per-item `rationale` beside every proposal.
   *
   * The panel used to label the picked row's own rationale "Why it picked this
   * one:", which read as a comparison and was not one: nothing in the schema
   * or the prompt had ever asked why. Either the question gets asked or the
   * label goes; this is the question being asked. `null` when the model gave
   * nothing usable, or when the pick did not survive the clamp — in which case
   * the panel shows no such label rather than one over borrowed prose.
   */
  readonly recommendedReason: string | null;
}

export interface ThumbnailCritiqueResult extends ResultBase {
  readonly kind: "thumbnail_critique";
  readonly verdicts: readonly ThumbnailVerdict[];
  /** The role the model would ship, when it named one that was sent. */
  readonly recommendedRole: ThumbnailVerdict["role"] | null;
}

export type AssistResult = SuggestionsResult | ThumbnailCritiqueResult;

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

/** Per-call knobs. Both matter to the UI, and neither belongs in the request. */
export interface AssistCallOptions {
  /**
   * Aborts the call, rejecting it with `code: "cancelled"`.
   *
   * **No caller in this app supplies one, and today none can.** The only
   * callers are the two server actions in `app/actions/assist.ts`, and an
   * `AbortSignal` does not cross the server-action boundary: by the time
   * somebody presses Cancel the request is already running on the server and
   * nothing in the browser can recall it. `components/assist/run.ts` says the
   * same thing from the other side — cancelling is *stop waiting for this
   * answer*, not *stop the model* — and it is the accurate account of what
   * closing a panel costs: the waiting ends, the spending does not.
   *
   * So this is a seam, honoured by both implementations and exercised by the
   * unit tests, kept for a caller that can abort — a route handler, a queue
   * worker, a provider wrapper — rather than a cost control the app has.
   */
  readonly signal?: AbortSignal;
  /**
   * Hard ceiling in milliseconds. Exceeding it rejects with `code: "timeout"`.
   * Defaults to {@link DEFAULT_ASSIST_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
}

/**
 * The seam itself.
 *
 * Two implementations ship: `anthropic.ts` (real, server-only, needs a key) and
 * `fake.ts` (deterministic fixtures, no network). The server action picks one
 * from the environment, importing it lazily so a run on the fixtures never
 * loads the vendor SDK. A third — a different vendor, a local model, a cache in
 * front of either — is a new file implementing this interface and one line in
 * that chooser; nothing that renders changes.
 */
export interface AssistProvider {
  /**
   * Which implementation this is. Ends up in `meta.provider`.
   *
   * Deliberately `string`. A closed union here would mean that the "new file
   * plus one line in the chooser" promise above was false — every third
   * provider would also have to edit this interface to be allowed to exist.
   */
  readonly name: string;
  /**
   * Ask for one assist. Resolves with a result whose `kind` matches the
   * request's, or rejects with an {@link AssistError} — never with anything
   * else, which is the whole contract: the caller handles one error type.
   */
  run(request: AssistRequest, options?: AssistCallOptions): Promise<AssistResult>;
}

/**
 * PLAN.md puts `export const maxDuration = 60` on the segment that hosts the
 * brainstorm, because the call can take 10–40 seconds. This leaves a few
 * seconds inside that window for the timeout to be *ours* — a sentence the UI
 * can show — rather than the platform's, which is a dead request.
 */
export const DEFAULT_ASSIST_TIMEOUT_MS = 55_000;

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything that can go wrong, as a closed set. Each one is a different
 * sentence and, more importantly, a different *offer*: retry now, retry later,
 * change what you asked for, or nothing you can do.
 */
export type AssistErrorCode =
  /** No API key in the environment on a deployment that needs one. */
  | "not_configured"
  /** The model declined on policy grounds (`stop_reason: "refusal"`). */
  | "refused"
  /** We gave up waiting. */
  | "timeout"
  /** The caller's `AbortSignal` fired — usually the panel closing. */
  | "cancelled"
  /** 429. `retryAfterSeconds` is set when the API said how long. */
  | "rate_limited"
  /** 5xx: the vendor is having a bad time. */
  | "upstream"
  /** The request never reached the vendor: DNS, TLS, socket. */
  | "unreachable"
  /** 401/403: the key is missing, wrong, or not allowed to do this. */
  | "unauthorized"
  /** 400/422: we built a request the API would not accept. A bug, not a blip. */
  | "rejected"
  /** A 200 whose body was not JSON at all. */
  | "malformed"
  /** A 200 that parsed as JSON but is not the shape we asked for. */
  | "wrong_shape"
  /** A well-formed answer with nothing in it. */
  | "empty";

/**
 * The default sentence for each code. Plain, second person, no jargon.
 *
 * ## Why none of them names the vendor, and none of them names a variable
 *
 * **No vendor.** This file is the seam, and a sentence that says "Claude" is a
 * sentence the *fixtures* would also show — the provider that answers when
 * there is no key is `lib/assist/fake.ts`, which never asks anybody anything.
 * "Claude declined to answer this one" under a fixture refusal is the one lie
 * this feature is capable of telling, and it was telling it on every failure
 * path. A provider that wants its own name in a sentence passes `message`;
 * these are what is said when it does not.
 *
 * **No variable name.** `unauthorized` used to read "Check ANTHROPIC_API_KEY
 * in the deployment's environment", which put an infrastructure variable in
 * front of whoever happened to be using the app and contradicted this
 * milestone's own recorded decision to keep PLAN.md's build-output grep a
 * bright line. The variable name lives in {@link AssistError.detail}, which is
 * logged on the server and never rendered.
 */
const MESSAGES: Record<AssistErrorCode, string> = {
  not_configured:
    "This deployment has no API key for the brainstorm, so there is nothing to ask.",
  refused:
    "The assistant declined to answer this one. Rewording the notes usually clears it.",
  timeout:
    "The brainstorm took too long and was stopped. Trying again usually works.",
  cancelled: "The brainstorm was cancelled.",
  rate_limited:
    "Too many brainstorms too quickly — wait a moment and ask again.",
  upstream:
    "The assistant is having trouble right now. Try again in a minute.",
  unreachable:
    "Could not reach the assistant — check the connection and try again.",
  unauthorized:
    "This deployment's credentials were rejected. Nothing was changed — the key needs attention before the brainstorm will work.",
  rejected:
    "The request was rejected as malformed. That is a bug in this app, not something you did.",
  malformed: "The answer was not readable. Try again.",
  wrong_shape: "The answer came back in a shape this panel cannot read. Try again.",
  empty: "Nothing came back this time. Try again.",
};

/**
 * Worth pressing the button again? Codes where the same request might succeed
 * unchanged. `refused` is deliberately not retryable: the same prompt will be
 * declined the same way, and a retry button that cannot work is a lie.
 */
const RETRYABLE: ReadonlySet<AssistErrorCode> = new Set<AssistErrorCode>([
  "timeout",
  "rate_limited",
  "upstream",
  "unreachable",
  "malformed",
  "wrong_shape",
  "empty",
]);

/**
 * The one error the app catches.
 *
 * `message` is already a sentence for a person — the UI can render it without
 * a lookup table — and `code` is there for the cases where the UI wants to do
 * something more specific (offer a retry, link to the deployment settings,
 * say nothing at all because the person closed the panel themselves).
 */
export class AssistError extends Error {
  readonly code: AssistErrorCode;
  /** True when pressing the button again could plausibly work. */
  readonly retryable: boolean;
  /** For `rate_limited`, when the API told us how long to wait. */
  readonly retryAfterSeconds?: number;
  /** For `refused`, the policy category the API reported, when it gave one. */
  readonly category?: string;
  /** Developer-facing detail: never rendered on its own, always logged. */
  readonly detail?: string;

  constructor(
    code: AssistErrorCode,
    options: {
      message?: string;
      retryAfterSeconds?: number;
      category?: string;
      detail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? MESSAGES[code], { cause: options.cause });
    this.name = "AssistError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    if (options.category !== undefined) this.category = options.category;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

/**
 * Narrow an unknown caught value.
 *
 * `instanceof` is enough within one process, and this app has no second copy of
 * the module, but an error that crossed a bundle boundary loses its prototype —
 * so the shape is checked too.
 */
export function isAssistError(value: unknown): value is AssistError {
  return (
    value instanceof AssistError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "AssistError" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}

/**
 * Turn anything at all into an `AssistError`. The providers funnel every catch
 * through here, so `run()` can promise that nothing else ever escapes it.
 */
export function toAssistError(value: unknown): AssistError {
  if (isAssistError(value)) return value as AssistError;
  return new AssistError("upstream", {
    detail: value instanceof Error ? value.message : String(value),
    cause: value,
  });
}
