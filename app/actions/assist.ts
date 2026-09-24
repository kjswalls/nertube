"use server";

import { z } from "zod";

import {
  AssistError,
  isAssistError,
  type AssistErrorCode,
  type AssistKind,
  type AssistMeta,
  type AssistProvider,
  type AssistRequest,
  type SuggestionsResult,
  type ThumbnailVariantImage,
  type ThumbnailVerdict,
} from "@/lib/assist/types";
import { ROLE_LABEL } from "@/components/thumbnails/roles";
import {
  downloadObject,
  MAX_SKETCH_BYTES,
  MAX_SKETCH_LABEL,
  parseThumbnailVariantPath,
  visionMediaTypeFor,
  type ThumbnailRole,
} from "@/lib/storage";
import {
  loadCritiqueRequest,
  loadTextRequest,
  type LoadedCritique,
  type LoadedText,
} from "@/lib/assist/load";
import { chooseProvider, type ChosenProvider } from "@/lib/assist/mode";
import { assistFallbackWarning, selectAssistProvider } from "@/lib/assist/select";
import {
  capRefusalMessage,
  closeReservation,
  reserveSpend,
  settleSpend,
} from "@/lib/assist/spend";
import { STUB_API_KEY } from "@/lib/assist/test-stub";
import { readClock } from "@/lib/request-clock";
import { requireUser } from "@/lib/supabase/require-user";
import { readTimeZone } from "@/lib/time-zone-data";
import {
  STORED_ASSIST_KINDS,
  type StoredAssistEntryValue,
  type StoredAssistKind,
} from "@/components/assist/stored";

/**
 * The brainstorm, as a server action.
 *
 * ## Why the client sends a video id and nothing else
 *
 * Everything the call needs is either user data behind RLS (the video's notes,
 * the channel's voice guide, the titles it has already published) or the one
 * thing that must never be within reach of a browser — `ANTHROPIC_API_KEY`. So
 * the panel knows one function, this one, and passes an id and a kind. A client
 * that could choose the prompt, the voice guide or the past titles would be a
 * client that could spend the key on anything at all.
 *
 * ## Why it never throws
 *
 * A model call fails in more ways than anything else in this app: it declines,
 * it times out, it rate limits, the vendor falls over, the answer is not JSON,
 * the answer is JSON of the wrong shape, the answer is empty. `lib/assist`
 * turns every one of those into an `AssistError` carrying a sentence; this
 * hands that sentence back as data. An exception escaping a server action
 * reaches the browser as a digested "an error occurred in the Server Components
 * render", which is the one thing the person cannot act on.
 *
 * ## Why the result is written here
 *
 * `videos.brainstorm_last` exists so that closing the panel loses nothing
 * (PLAN.md), so the write belongs to the call rather than to the panel — a
 * person who closes the tab mid-flight still has the answer next time. If the
 * write fails the suggestions are still returned, with `persisted: false`, so
 * the panel can say they will not be here later instead of implying they will.
 */

/**
 * This app's own deadline, inside PLAN.md's `maxDuration = 60` on
 * `app/videos/[id]/page.tsx`. Ten seconds of headroom is what turns "the model
 * is slow" into a sentence in the panel rather than a platform timeout with
 * nothing on the screen.
 */
const DEADLINE_MS = 45_000;

/**
 * What an ask comes back as.
 *
 * Deliberately field-for-field the shape `useAssistRun` consumes
 * (`AssistAttempt<T>` in `components/assist/run.ts`), which is why the answer
 * is called `data` rather than `entry`: a control asks with
 * `run.ask(() => assist({ videoId, kind }))` and translates nothing.
 *
 * The two extra fields are for the panel rather than for the machine. `kind`
 * echoes the question this answer is about — nothing *matches* on it today,
 * and the comment here used to claim it did; it is there so a reply can be
 * read on its own, in a log or a network tab, without the request beside it,
 * and so the rejection branch below can say what was actually asked for.
 * `provider` is which implementation answered, or would have: a failure
 * sentence from the fixtures must not read as a sentence from a model, and
 * until it was carried here the panel had no way to say so on a failure.
 *
 * `critiqueThumbnails` below returns the same shape for the same reason. Two
 * questions, one result contract, one error contract, and no call site that
 * gets to invent a third.
 */
export type AssistState =
  | {
      ok: true;
      kind: StoredAssistKind;
      data: StoredAssistEntryValue;
      /** Counts from the module: what it asked for, what came back, what was cut. */
      meta: AssistMeta;
      /** False when the answer could not be written to `brainstorm_last`. */
      persisted: boolean;
    }
  | {
      ok: false;
      kind: StoredAssistKind;
      code: AssistErrorCode;
      /** Already a sentence for a person — `lib/assist/types.ts` writes it. */
      message: string;
      retryable: boolean;
      retryAfterSeconds: number | null;
      /** Which implementation produced this failure, for the fixtures notice. */
      provider: string;
    };

const Input = z.object({
  videoId: z.uuid(),
  kind: z.enum(STORED_ASSIST_KINDS),
});

/**
 * Which implementation answers.
 *
 * The rule itself, with every case and the reasoning for each, is
 * `selectAssistProvider` in `lib/assist/select.ts` — a pure function taking an
 * explicit environment, because it is the one part of this feature that cannot
 * be checked by running it here; `chooseProvider` in `lib/assist/mode.ts` is
 * where the page and this action both ask it. In short: an explicit
 * `ASSIST_PROVIDER=fake` always wins; a key means Claude. With no key the
 * panels are served in the `manual` mode (M11) and never call this action;
 * a hand-made request still gets the old answer — "no API key configured" in
 * production, the fixtures (said on every answer) anywhere else.
 *
 * Both are imported lazily, so a process running the fixtures never loads the
 * vendor SDK at all — and, more to the point, never reaches a module that reads
 * the key.
 */
async function provider(
  supabase: Supabase,
  chosen: ChosenProvider,
  videoId: string,
  kind: AssistKind,
): Promise<AssistProvider> {
  if (chosen.name === "fake") {
    const warning = assistFallbackWarning(process.env);
    if (warning !== null) warnOnce(warning);
    const { createFakeProvider } = await import("@/lib/assist/fake");
    return createFakeProvider();
  }

  /*
    The monthly cap (M11), **reserved** before every real call and never
    before a fixture: the fixtures cost nothing.

    Once the request is built, and before it is sent, `beforeSend` asks the
    database to reserve the call's worst case (`reserveSpend`,
    `reserve_assist_spend` in 0011). That runs under a per-user lock, so asks
    started together — other videos, other kinds, other tabs — are counted
    one after another: at or over the cap nothing is sent, and at most one
    call can cross the line. When the answer comes back the reservation
    becomes the measured cost (`onUsage`); when none does (`onNoUsage`), it
    stays at its worst case if the API may have billed it anyway, and is
    removed if the API refused with a status. A budget that cannot be read
    refuses too: a ceiling that is skipped whenever it is unreadable is not a
    ceiling. (M11's adversarial review, findings 1 and 2: the first version
    only *checked* the spend, and twenty-one parallel asks all passed a $1
    cap at $0.99; a call that timed out was never counted at all.)
  */
  const now = await readClock();
  const zone = (await readTimeZone()).zone;
  let reservation: string | null = null;

  const { createAnthropicProvider } = await import("@/lib/assist/anthropic");
  return createAnthropicProvider({
    ...(chosen.stub ? { baseURL: chosen.stub.baseURL, apiKey: STUB_API_KEY } : {}),
    beforeSend: async (worst) => {
      let reserved;
      try {
        reserved = await reserveSpend(supabase, now, zone, {
          videoId,
          kind,
          requestedModel: worst.requestedModel,
          estimateMicros: worst.costMicros,
        });
      } catch (error) {
        throw new AssistError("spend_cap", {
          message:
            "This month's API spending could not be read, so this was not sent — a cap that cannot be checked would not be a cap. Try again in a moment, or use Open in Claude.",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (!reserved.ok) {
        throw new AssistError("spend_cap", {
          message: capRefusalMessage(reserved.budget),
          detail: `spend ${reserved.budget.spendMicros} µ$ against a cap of $${reserved.budget.cap.dollars} (${reserved.budget.cap.source}).`,
        });
      }
      reservation = reserved.id;
    },
    onUsage: async (call, outcome) => {
      if (reservation === null) return;
      const written = await settleSpend(supabase, reservation, outcome, call);
      if (!written.ok) {
        console.error(
          `[assist] a ${kind} call costing ${call.costMicros} µ$ could not be settled, so it stays at its worst case: ${written.error}`,
        );
      }
    },
    onNoUsage: async (mayHaveBilled) => {
      if (reservation === null) return;
      const closed = await closeReservation(supabase, reservation, mayHaveBilled);
      if (!closed.ok) {
        console.error(`[assist] a ${kind} reservation could not be closed: ${closed.error}`);
      }
    },
  });
}

/**
 * `ASSIST_PROVIDER=manual` means the panels never call the API (README, "Which
 * assist implementation answers"). The panels honour that by never offering an
 * ask; this is the same promise kept on the server, so a hand-made request, or
 * a panel bug, cannot spend the key either (M11 review, finding 5). Null when
 * the API may be called.
 */
function manualOnly(): AssistError | null {
  if ((process.env.ASSIST_PROVIDER ?? "").trim().toLowerCase() !== "manual") return null;
  return new AssistError("not_configured", {
    message:
      "This app is set to use Open in Claude only, so the API was not called and nothing was spent. Use Open in Claude.",
    detail: "ASSIST_PROVIDER=manual: the API actions refuse every request.",
  });
}

type Supabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

/** Said once per server process, not once per brainstorm. */
let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(message);
}

export async function assist(input: {
  videoId: string;
  kind: StoredAssistKind;
}): Promise<AssistState> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    /*
      Echo what was asked for rather than always saying "titles".

      The kind is the only part of a rejected input that may still be sound —
      a malformed id with a perfectly good kind is the common case — and a
      reply that renames the question makes a rejected ask unreadable on its
      own. Anything that is not one of the three falls back to titles, because
      then there genuinely is no question to name.
      */
    return {
      ok: false,
      kind: requestedKind(input.kind),
      code: "rejected",
      message: "That is not a video this panel can ask about.",
      retryable: false,
      retryAfterSeconds: null,
      provider: providerName(),
    };
  }
  const { videoId, kind } = parsed.data;

  const { supabase, user } = await requireUser();

  const manual = manualOnly();
  if (manual) return failure(kind, manual);

  /*
    One ask of one question about one video at a time.

    `assist()` authenticates the caller and RLS scopes the read, and until this
    guard nothing else bounded it: the same POST replayed twenty-five times in
    parallel with one session's cookies produced twenty-five live model calls,
    each carrying the voice guide and fifty past titles, each writing the
    column. The same question asked twice at once is waste in every case — the
    second answer replaces the first before anybody reads it — so it is
    refused with the code the panel already knows how to render.

    Deliberately narrow. It is keyed by *question*, not by user, because two
    different questions in flight at once is the design ("Generate 20" then
    "Draft a third" is two panels' worth of work, not a mistake). And it is
    process-local, so on a platform that runs more than one instance it bounds
    a tight loop rather than a determined one. The residual — an authenticated
    session can still spend the key faster than a person could — is written
    down in docs/MILESTONES.md under "The honest limit" rather than left for
    somebody to discover from a bill.
  */
  const lane = `${user.id}:${videoId}:${kind}`;
  if (IN_FLIGHT.has(lane)) {
    return failure(
      kind,
      new AssistError("rate_limited", {
        message:
          "That same brainstorm is already running. Wait for the answer rather than asking twice.",
        detail: `A ${kind} ask for video ${videoId} is already in flight for this user.`,
      }),
    );
  }
  IN_FLIGHT.add(lane);
  try {
    return await askFor(supabase, videoId, kind, await chooseProvider());
  } finally {
    IN_FLIGHT.delete(lane);
  }
}

/** The questions currently in flight, as `user:video:kind`. See `assist()`. */
const IN_FLIGHT = new Set<string>();

/** The `kind` an input asked for, when it asked for one this panel knows. */
function requestedKind(value: unknown): StoredAssistKind {
  return STORED_ASSIST_KINDS.includes(value as StoredAssistKind)
    ? (value as StoredAssistKind)
    : "titles";
}

/** The ask itself, once the caller and the question are known to be sound. */
async function askFor(
  supabase: Supabase,
  videoId: string,
  kind: StoredAssistKind,
  chosen: ChosenProvider,
): Promise<AssistState> {
  /*
    What the prompt is built from — the video, the channel's voice guide, its
    last fifty published titles, and what the video already has so the answer
    does not repeat it — is read by `loadTextRequest` (lib/assist/load.ts),
    with the caller's RLS-scoped client. It is the same function Open in
    Claude's prompt is built from (M11), so the API and the manual path ask
    from identical inputs by construction rather than by two copies agreeing.

    No row means no row *for this user*: RLS does not distinguish somebody
    else's video from one that never existed, and neither does this. Nothing
    is spent on a video the caller cannot see. How many of each to ask for
    (PLAN.md's 10–20 titles, four concepts, and — deliberately — no number
    for hooks, so `wantedFor` asks for the ones missing) lives there too.
  */
  let loaded: LoadedText;
  try {
    loaded = await loadTextRequest(supabase, videoId, kind);
  } catch (error) {
    return failure(kind, error);
  }
  const { request, voiceGuide } = loaded;

  let result: SuggestionsResult;
  try {
    const answered = await (await provider(supabase, chosen, videoId, kind)).run(request, {
      timeoutMs: DEADLINE_MS,
    });
    if (answered.kind === "thumbnail_critique") {
      // Unreachable through this action; the type union makes it sayable.
      throw new AssistError("wrong_shape", {
        detail: `Asked for ${kind}, got a thumbnail critique.`,
      });
    }
    result = answered;
  } catch (error) {
    return failure(kind, error, chosen.name);
  }

  const entry: StoredAssistEntryValue = {
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

  /*
    Persist, without letting a failed write lose the answer — and without
    letting *this* answer lose somebody else's.

    This used to be an ordinary column update carrying a whole envelope
    rebuilt from `video.brainstorm_last`, which was read at the top of this
    function, before a call PLAN.md budgets at ten to forty seconds. Two asks
    overlapping meant the slower one committed an envelope that had never seen
    the faster one's key: twenty titles somebody waited for, gone, with the
    call still answering `persisted: true` because the UPDATE succeeded.

    So the read and the write are one statement now, in
    `merge_brainstorm_entry` (migration 0009), and this sends one kind's entry
    rather than the envelope. `brainstorm_last` left the client's column grant
    in the same migration, so there is no second way to write it and no
    snapshot that can go stale.

    Nothing is revalidated: no other view reads the column, and re-rendering
    the detail route underneath an open panel would move the page while
    somebody is reading it.
  */
  const { error: writeError } = await supabase.rpc("merge_brainstorm_entry", {
    p_video: videoId,
    p_kind: kind,
    p_entry: entry,
  });

  return { ok: true, kind, data: entry, meta: result.meta, persisted: !writeError };
}

/**
 * Every failure, as the sentence a panel shows. Never an exception.
 *
 * Split from `failure()` below because there is more than one assist action
 * now — the brainstorm answers per *kind*, the thumbnail critique does not —
 * and the one thing they must not do is disagree about what a failed model
 * call looks like. One mapping, two callers.
 */
function failureOf(error: unknown): {
  code: AssistErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
} {
  if (isAssistError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds ?? null,
    };
  }
  return {
    code: "upstream",
    message:
      "The brainstorm failed for a reason this app did not recognise. Nothing was changed.",
    retryable: true,
    retryAfterSeconds: null,
  };
}

/** The same, carrying the kind the panel asked about. */
function failure(
  kind: StoredAssistKind,
  error: unknown,
  provider: string = providerName(),
): AssistState {
  return { ok: false, kind, provider, ...failureOf(error) };
}

/**
 * Which implementation answered, or would have.
 *
 * Read from the environment rather than from the provider instance, because a
 * failure can happen before one is ever built — bad input, a video the caller
 * cannot see — and the panel's question is the same either way: *was a model
 * asked anything at all?* `selectAssistProvider` is the one rule, so this
 * cannot disagree with what actually ran.
 *
 * The reason the answer has to travel with a failure is the one the fixtures
 * notice exists for. `lib/assist/fake.ts` can refuse, rate-limit and time out,
 * and every sentence for those used to name the vendor: a keyless deployment
 * told people "Claude declined to answer this one" about notes no model had
 * ever seen. The sentences are neutral now, and this is what lets the panel
 * add the rest of the truth underneath.
 */
function providerName(): string {
  return selectAssistProvider(process.env);
}

/* -------------------------------------------------------------------------- */
/* The thumbnail critique                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The one assist in this app that looks at pixels.
 *
 * ## Why it is a second action and not a fourth `kind` of the first
 *
 * `assist()` above answers with *suggestions*: a list of text, which the panel
 * offers and the person accepts into a field. A critique answers with a
 * judgement about images — three verdicts and a role it would ship — and its
 * input is bytes rather than a request the client could describe. Sharing one
 * action would mean a return type that is a union nobody can narrow without
 * asking what was sent, and a `brainstorm_last` write on a path that must not
 * write (see below). Same module, same provider, same failure mapping, same
 * deadline; different question.
 *
 * ## Why the answer is not stored
 *
 * `videos.brainstorm_last` exists so that closing the panel loses nothing, and
 * for titles, concepts and hooks that is exactly right: they are proposals
 * about text the person can still see. A critique is about the *bytes that were
 * in the bucket when it ran*. Replace the wild card and a stored verdict
 * becomes a confident paragraph about an image that no longer exists — which is
 * worse than no verdict, because it reads as current. So this one is asked for
 * again when it is wanted again, and the panel says so rather than implying it
 * was kept.
 *
 * ## Why the bytes are read here
 *
 * The key may only exist on the server, so the request that carries the images
 * is built on the server, so the images are read on the server — with the
 * caller's own RLS-scoped client, which is also what the storage policy checks.
 * `lib/storage.ts`'s `downloadObject` is the only thing that names the bucket.
 */

/** One variant that could not be sent, and the sentence saying why. */
export interface SkippedVariant {
  readonly role: ThumbnailRole;
  readonly reason: string;
}

export interface CritiqueAnswer {
  readonly verdicts: readonly ThumbnailVerdict[];
  /** The role the model would ship, when it named one that was actually sent. */
  readonly recommendedRole: ThumbnailRole | null;
  /** Variants left out of the judgement, named rather than dropped. */
  readonly skipped: readonly SkippedVariant[];
}

export type CritiqueState =
  | {
      ok: true;
      data: CritiqueAnswer;
      meta: AssistMeta;
      /** Always true: nothing was meant to be stored, so nothing was lost. */
      persisted: boolean;
    }
  | {
      ok: false;
      code: AssistErrorCode;
      message: string;
      retryable: boolean;
      retryAfterSeconds: number | null;
      /** Which implementation produced this failure. See `AssistState`. */
      provider: string;
    };

const CritiqueInput = z.object({ videoId: z.uuid() });

/**
 * The ceiling on one image, before base64.
 *
 * The same number the uploader already refuses above (`MAX_SKETCH_BYTES`), so
 * in practice nothing stored through this app can exceed it; the check is here
 * because an object can also arrive in the bucket another way, and a 40 MB PNG
 * turned into base64 is a request that fails slowly and expensively instead of
 * a sentence that arrives immediately.
 */
const MAX_IMAGE_BYTES = MAX_SKETCH_BYTES;

export async function critiqueThumbnails(input: {
  videoId: string;
}): Promise<CritiqueState> {
  const parsed = CritiqueInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "rejected",
      message: "That is not a video this panel can ask about.",
      retryable: false,
      retryAfterSeconds: null,
      provider: providerName(),
    };
  }
  const { videoId } = parsed.data;

  const { supabase, user } = await requireUser();

  const manual = manualOnly();
  if (manual) return { ok: false, provider: providerName(), ...failureOf(manual) };

  /*
    One critique of one video at a time, as `assist()` has one ask of one
    question: the same critique twice at once is two billed multi-image calls
    for one answer. (The spend cap no longer depends on this — the
    reservation holds the line whatever is in flight — but the waste is the
    same as it ever was.)
  */
  const lane = `${user.id}:${videoId}:thumbnail_critique`;
  if (IN_FLIGHT.has(lane)) {
    return {
      ok: false,
      provider: providerName(),
      ...failureOf(
        new AssistError("rate_limited", {
          message: "That critique is already running. Wait for the answer rather than asking twice.",
          detail: `A critique for video ${videoId} is already in flight for this user.`,
        }),
      ),
    };
  }
  IN_FLIGHT.add(lane);
  try {
    return await critiqueFor(supabase, videoId, await chooseProvider());
  } finally {
    IN_FLIGHT.delete(lane);
  }
}

/** The critique itself, once the caller and the video are known to be sound. */
async function critiqueFor(
  supabase: Supabase,
  videoId: string,
  chosen: ChosenProvider,
): Promise<CritiqueState> {

  /*
    The video, the channel and which slots hold an image, read by
    `loadCritiqueRequest` (lib/assist/load.ts) — the same read Open in
    Claude's critique prompt is built from. It refuses a video the caller
    cannot see, and one with nothing uploaded, with the sentences below.
  */
  let loaded: LoadedCritique;
  try {
    loaded = await loadCritiqueRequest(supabase, videoId);
  } catch (error) {
    return { ok: false, provider: providerName(), ...failureOf(error) };
  }

  /*
    The images, read together — at most three, so one wait rather than three.

    Everything that can go wrong with one variant leaves the other two
    judgeable: a format the model cannot read, an object that is no longer
    there, a file too big to send. Each becomes a named skip rather than a
    failed critique, because "the wild card is an AVIF" is something a person
    can act on and "it did not work" is not.
  */
  const fetched = await Promise.all(
    // Only the slots that hold something: an empty slot is not a skip — there
    // was nothing to judge and nothing went wrong, so it earns no sentence.
    loaded.uploaded.map(
      async ({
        role,
        path,
      }): Promise<
        { role: ThumbnailRole } & (
          | { image: ThumbnailVariantImage; reason?: undefined }
          | { image?: undefined; reason: string }
        )
      > => {
        const parsedPath = parseThumbnailVariantPath(path);
        const mediaType = parsedPath ? visionMediaTypeFor(parsedPath.extension) : null;
        if (!mediaType) {
          return {
            role,
            reason: `${ROLE_LABEL[role]} is stored in a format Claude cannot look at. Re-export it as a PNG or a JPEG and ask again.`,
          };
        }

        const { bytes, error } = await downloadObject(supabase, path);
        if (!bytes) {
          return {
            role,
            reason: `${ROLE_LABEL[role]}’s image could not be read back from storage (${error ?? "unknown"}), so it was left out.`,
          };
        }
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return {
            role,
            reason: `${ROLE_LABEL[role]} is larger than ${MAX_SKETCH_LABEL} and was left out. YouTube caps a thumbnail at 2 MB anyway.`,
          };
        }

        return {
          role,
          image: { role, mediaType, base64: Buffer.from(bytes).toString("base64") },
        };
      },
    ),
  );

  const images: ThumbnailVariantImage[] = [];
  const skipped: SkippedVariant[] = [];
  for (const result of fetched) {
    if (result.image) images.push(result.image);
    else if (result.reason) skipped.push({ role: result.role, reason: result.reason });
  }

  if (images.length === 0) {
    return {
      ok: false,
      provider: providerName(),
      ...failureOf(
        new AssistError("rejected", {
          message: `${skipped[0].reason} There was nothing else to look at.`,
        }),
      ),
    };
  }

  /*
    No past titles here, deliberately (`loadCritiqueRequest` reads none).

    `assist()` sends the channel's last fifty published titles as style
    evidence, because a title is written in a voice. A verdict about whether a
    face reads at 360 pixels is not, and fifty titles would be fifty lines of
    prompt that change nothing about the answer.
  */
  const request: AssistRequest = { ...loaded.request, variants: images };

  let result;
  try {
    const answered = await (
      await provider(supabase, chosen, videoId, "thumbnail_critique")
    ).run(request, { timeoutMs: DEADLINE_MS });
    if (answered.kind !== "thumbnail_critique") {
      throw new AssistError("wrong_shape", {
        detail: `Asked for a critique, got ${answered.kind}.`,
      });
    }
    result = answered;
  } catch (error) {
    return { ok: false, provider: chosen.name, ...failureOf(error) };
  }

  return {
    ok: true,
    data: {
      verdicts: result.verdicts,
      recommendedRole: result.recommendedRole,
      skipped,
    },
    meta: result.meta,
    persisted: true,
  };
}
