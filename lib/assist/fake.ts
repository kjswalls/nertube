import { cleanLabel } from "@/lib/text";

import { assemble, wantedFor } from "./clamp";
import type { CritiquePayload, SuggestionsPayload } from "./schema";
import {
  AssistError,
  type AssistCallOptions,
  type AssistErrorCode,
  type AssistProvider,
  type AssistRequest,
  type AssistResult,
} from "./types";

/**
 * The fake provider: plausible answers, deterministically, with no network.
 *
 * This is not a stub that returns `["title 1", "title 2"]`. It is the
 * implementation every test and every keyless run uses — including the
 * container this milestone was built in, where there is no API key and
 * api.anthropic.com is unreachable — and it has three jobs a lazier fixture
 * would fail at.
 *
 * **It has to be good enough to develop against.** Laying out a panel of
 * twenty titles needs twenty titles of realistic length with real rationales,
 * or the panel gets designed around text that does not exist.
 *
 * **It has to be deterministic.** The same request gives the same answer, byte
 * for byte, forever — so an end-to-end test can assert on a title, and a
 * screenshot diff means something. Everything that varies (which phrasing,
 * which order, even the reported latency) is derived from a hash of the
 * request; nothing reads the clock or a random source.
 *
 * **It has to be able to fail on demand.** The UI needs a refusal, a timeout
 * and a rate limit as much as it needs twenty titles: those are the states
 * that are hardest to build and easiest to leave untested. Any
 * {@link AssistErrorCode} can be summoned three ways — an option at
 * construction, the `ASSIST_FAKE_SCENARIO` environment variable, or a marker
 * written into the video's own text, `[[assist:refused]]`, which is the one
 * that works from inside a running browser test without restarting anything.
 * Three further scenarios exercise the clamp rather than the error path:
 * `overflow` returns one more suggestion than was asked for, `duplicate`
 * repeats what the video already has, and `unusable` returns a blank and an
 * over-long entry.
 *
 * And the voice guide is load-bearing here too: it changes both the rotation
 * of phrasings and a word woven into the rationales, so "edit the voice guide,
 * press the button, see different output" is demonstrable without a key.
 */

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything the fake can be asked to do instead of answering normally. */
export type FakeScenario =
  | "ok"
  | AssistErrorCode
  /** Return one more than the cap, so the clamp has something to clamp. */
  | "overflow"
  /** Return what the video already has, so the dedupe has something to drop. */
  | "duplicate"
  /** Return a blank and an over-long entry, so "unusable" has something to count. */
  | "unusable";

const SCENARIOS: ReadonlySet<string> = new Set<FakeScenario>([
  "ok",
  "not_configured",
  "refused",
  "timeout",
  "cancelled",
  "rate_limited",
  "upstream",
  "unreachable",
  "unauthorized",
  "rejected",
  "malformed",
  "wrong_shape",
  "empty",
  "overflow",
  "duplicate",
  "unusable",
]);

/** The three that produce a *bad answer* rather than a failed call. */
const CLAMP_SCENARIOS: ReadonlySet<string> = new Set([
  "overflow",
  "duplicate",
  "unusable",
]);

/**
 * `[[assist:timeout]]` anywhere in the video's title, hook or notes.
 *
 * A marker in the content is how a Playwright test asks for a refusal in the
 * middle of a run: it types it into a field it already has open. An
 * environment variable alone would mean a server restart per failure mode,
 * which in practice means the failure modes do not get tested.
 */
const MARKER = /\[\[assist:([a-z_]+)\]\]/;

function scenarioFromRequest(request: AssistRequest): FakeScenario | null {
  const haystack = [
    request.video.title,
    request.video.oneLineHook ?? "",
    request.video.notes ?? "",
  ].join("\n");
  const found = MARKER.exec(haystack);
  if (found === null) return null;
  return SCENARIOS.has(found[1]) ? (found[1] as FakeScenario) : null;
}

function scenarioFromEnv(): FakeScenario | null {
  const name = (process.env.ASSIST_FAKE_SCENARIO ?? "").trim();
  return SCENARIOS.has(name) ? (name as FakeScenario) : null;
}

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

/** FNV-1a, 32-bit. Small, stable, and not a security boundary. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The seed: everything about the request that should change the answer. The
 * voice guide is in it deliberately — editing the guide and pressing the
 * button again must visibly produce something else, with or without a key.
 */
function seedOf(request: AssistRequest): number {
  return hash(
    [
      request.kind,
      request.channel.name,
      request.channel.voiceGuide ?? "",
      request.video.title,
      request.video.oneLineHook ?? "",
      request.video.notes ?? "",
      request.video.thumbnailConcept ?? "",
      request.video.tags.join(","),
    ].join("\u0000"),
  );
}

const STOPWORDS = new Set([
  "about",
  "after",
  "every",
  "never",
  "there",
  "these",
  "thing",
  "things",
  "those",
  "which",
  "while",
  "would",
  "write",
  "writing",
  "voice",
  "channel",
]);

/**
 * A word borrowed from the voice guide, so its fingerprint is visible in the
 * output rather than merely implied. The longest distinctive word wins, which
 * is crude and completely deterministic.
 */
function voiceWord(guide: string | null): string | null {
  if (guide === null) return null;
  const words = cleanLabel(guide)
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .filter((word) => word.length >= 5 && !STOPWORDS.has(word));
  if (words.length === 0) return null;
  return words.reduce((best, word) =>
    word.length > best.length || (word.length === best.length && word < best)
      ? word
      : best,
  );
}

/** The subject of the video, in a few words, for the fixtures to talk about. */
function topicOf(request: AssistRequest): string {
  const candidates = [
    request.video.title,
    request.video.oneLineHook ?? "",
    request.video.tags[0] ?? "",
  ]
    .map((value) => cleanLabel(value).replace(MARKER, "").trim())
    .filter((value) => value !== "");
  const topic = candidates[0] ?? "this video";
  return topic.length > 60 ? `${topic.slice(0, 57).trimEnd()}…` : topic;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const TITLE_SHAPES: readonly ((topic: string) => string)[] = [
  (t) => `I tried ${t} for 30 days`,
  (t) => `The honest truth about ${t}`,
  (t) => `${t}: what nobody tells you first`,
  (t) => `Why ${t} stopped working for me`,
  (t) => `${t} — the 3 things that actually matter`,
  (t) => `How I finally got ${t} right`,
  (t) => `The cheapest way to do ${t}`,
  (t) => `${t} without the burnout`,
  (t) => `What ${t} taught me about my own work`,
  (t) => `${t} is easier than everyone says`,
  (t) => `The ${t} mistake I made for two years`,
  (t) => `${t}, explained in one afternoon`,
  (t) => `Stop overthinking ${t}`,
  (t) => `${t}: a system that survives a bad week`,
  (t) => `The part of ${t} everyone skips`,
  (t) => `${t} on a beginner's budget`,
  (t) => `One change that fixed ${t} for me`,
  (t) => `${t} after the novelty wears off`,
  (t) => `Everything I got wrong about ${t}`,
  (t) => `${t}: is it worth your Saturday?`,
  (t) => `The quiet case against ${t}`,
  (t) => `${t} when you have 20 minutes a day`,
  (t) => `Six months of ${t}, honestly`,
  (t) => `${t} for people who hate ${t}`,
];

const TITLE_REASONS: readonly string[] = [
  "Sells the result rather than the contents, and the number gives it a spine.",
  "Curiosity without a lie: the viewer cannot guess the answer from the title.",
  "Short enough to survive a phone's truncation and still make its promise.",
  "Names the objection the audience already has, so the click feels like relief.",
  "The first-person framing keeps it inside this channel's register.",
  "Concrete noun plus a cost — the two things that make a thumbnail pair easy.",
  "Promises a decision, not information; that is what gets watched to the end.",
  "The tension is in the contrast, so the thumbnail can carry the other half.",
];

const CONCEPT_SHAPES: readonly ((topic: string) => string)[] = [
  (t) =>
    `Mid-shot, straight to camera, unimpressed expression, holding the one object that stands for ${t}. Plain wall behind. Three words top-left: NOT WORTH IT.`,
  (t) =>
    `Overhead of the desk mid-mess: two coffees, the notebook open on the ${t} page, hands in frame. No text — the mess is the message.`,
  (t) =>
    `Split frame: left, the setup on day one; right, the same setup after a month of ${t}. One arrow between them, nothing else.`,
  (t) =>
    `Tight on the face, caught mid-laugh, with ${t} visibly going wrong behind the shoulder and slightly out of focus.`,
  (t) =>
    `Wide, small in frame, standing in front of the whole ${t} setup with arms folded. Reads as scale at tile size.`,
  (t) =>
    `Hand entering frame holding a single index card with the number from the video on it, ${t} blurred behind.`,
];

const CONCEPT_REASONS: readonly string[] = [
  "Adds the emotion the title leaves out instead of illustrating the words.",
  "One subject, one idea — still legible as a 360px tile on a phone.",
  "Filmable in the room you already film in, with what is already on the desk.",
  "The contrast survives being shrunk; colour is doing the work, not detail.",
  "Leaves the title something to say, which is what makes the pair work.",
];

const HOOK_SHAPES: readonly ((topic: string) => string)[] = [
  (t) =>
    `Three weeks in, ${t} had cost me two hundred pounds and a Saturday, and I nearly gave up on it. Here is what changed on the Sunday.`,
  (t) =>
    `Everyone told me ${t} needed the expensive version. It does not, and I can prove it in about four minutes.`,
  (t) =>
    `The first time I tried ${t}, I got it completely backwards — and the mistake is the useful part, so let me show you that first.`,
  (t) =>
    `If you only take one thing from this: ${t} works when it is boring, and stops the moment you make it clever.`,
  (t) =>
    `I have done ${t} every day since January. Here is the honest ledger — what it gave back, and what it quietly took.`,
];

const HOOK_REASONS: readonly string[] = [
  "Pays off the title's promise inside the first ten seconds, with a number.",
  "Opens on a concrete moment rather than a description of the video.",
  "No greeting, no channel preamble — it starts mid-stride, as spoken.",
  "Two sentences, both sayable in one breath, which is what survives the edit.",
];

const CRITIQUE_NOTES: Record<string, readonly string[]> = {
  wild_card: [
    "The idea is strong but the text is doing all of it — at tile size the two smaller words vanish and only the shape is left. Crop tighter on the face and lose a word.",
    "Risky in the right way: the expression reads even when small. The background is fighting it, though — knock it a stop darker.",
  ],
  moderate: [
    "Reads cleanly at 360px and the subject is unambiguous. It repeats the title almost exactly, so the pair says one thing twice — change the prop, not the framing.",
    "Safe framing, good contrast, nothing wasted. It is the one to beat, not the one to ship.",
  ],
  safe: [
    "Legible, on-brand, and slightly inert — it will not lose you clicks and it will not win any. Fine as the fallback it is meant to be.",
    "Clear at any size. The bottom third is empty; move the subject down and let the title have the top.",
  ],
};

/** Comfortably past every text limit, without depending on their exact values. */
const OVERLONG = 5_000;

/* -------------------------------------------------------------------------- */
/* Building an answer                                                          */
/* -------------------------------------------------------------------------- */

/** Pick `count` entries from a pool, starting at the seed and cycling. */
function rotate<T>(pool: readonly T[], seed: number, count: number): T[] {
  const start = seed % pool.length;
  return Array.from(
    { length: count },
    (_unused, index) => pool[(start + index) % pool.length],
  );
}

function suggestionsFor(
  request: AssistRequest,
  count: number,
): SuggestionsPayload {
  const seed = seedOf(request);
  const topic = topicOf(request);
  const word = voiceWord(request.channel.voiceGuide);

  const shapes =
    request.kind === "titles"
      ? TITLE_SHAPES
      : request.kind === "concepts"
        ? CONCEPT_SHAPES
        : HOOK_SHAPES;
  const reasons =
    request.kind === "titles"
      ? TITLE_REASONS
      : request.kind === "concepts"
        ? CONCEPT_REASONS
        : HOOK_REASONS;

  const texts = rotate(shapes, seed, count).map((shape) => shape(topic));
  const rationales = rotate(reasons, seed >>> 3, count).map((reason, index) =>
    word !== null && index % 3 === 0
      ? `${reason} Keeps the channel's "${word}" register.`
      : reason,
  );

  return {
    suggestions: texts.map((text, index) => ({
      text,
      rationale: rationales[index],
    })),
    recommended_index: seed % Math.max(1, count),
  };
}

function critiqueFor(request: AssistRequest): CritiquePayload {
  if (request.kind !== "thumbnail_critique") {
    throw new AssistError("rejected", {
      detail: "critiqueFor was handed the wrong request kind.",
    });
  }
  const seed = seedOf(request);
  const verdicts = request.variants.map((variant, index) => {
    const notes = CRITIQUE_NOTES[variant.role] ?? CRITIQUE_NOTES.safe;
    const pick = (seed + index) % notes.length;
    return {
      role: variant.role,
      reads_at_tile_size: variant.role !== "wild_card" || pick === 1,
      complements_title: variant.role !== "moderate",
      note: notes[pick],
    };
  });
  const recommended = request.variants[seed % request.variants.length];
  return { verdicts, recommended_role: recommended?.role ?? "" };
}

/** The scenarios that bend the *answer* rather than failing the call. */
function withClampBait(
  payload: SuggestionsPayload,
  scenario: FakeScenario,
  request: AssistRequest,
): SuggestionsPayload {
  if (scenario === "duplicate") {
    const existing =
      request.kind === "thumbnail_critique" ? [] : (request.existing ?? []);
    return {
      ...payload,
      suggestions: [
        ...existing.map((text) => ({
          text,
          rationale: "A repeat of one you already have.",
        })),
        ...payload.suggestions,
      ],
    };
  }
  if (scenario === "unusable") {
    return {
      ...payload,
      suggestions: [
        { text: "   ", rationale: "Blank on purpose." },
        { text: "x".repeat(OVERLONG), rationale: "Far too long on purpose." },
        ...payload.suggestions,
      ],
    };
  }
  return payload;
}

/** Scenario names that are also error codes — everything but the clamp bait. */
function isErrorCode(scenario: FakeScenario): scenario is AssistErrorCode {
  return scenario !== "ok" && !CLAMP_SCENARIOS.has(scenario);
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export interface FakeProviderOptions {
  /** Forces a scenario, ahead of the marker and the environment variable. */
  readonly scenario?: FakeScenario;
}

/**
 * Deterministic, offline, and shaped exactly like the real one — it runs its
 * fixtures through the same `assemble()` the Anthropic provider does, so the
 * clamping, the counting and the empty-answer rule are the ones that ship.
 */
export function createFakeProvider(
  options: FakeProviderOptions = {},
): AssistProvider {
  return {
    name: "fake",
    async run(
      request: AssistRequest,
      callOptions: AssistCallOptions = {},
    ): Promise<AssistResult> {
      // Cancellation is checked first and honoured literally: a panel that was
      // closed gets the same error here as it would from the real transport.
      if (callOptions.signal?.aborted) {
        throw new AssistError("cancelled", {
          detail: "The caller's signal was already aborted.",
        });
      }

      const scenario =
        options.scenario ??
        scenarioFromRequest(request) ??
        scenarioFromEnv() ??
        "ok";

      if (isErrorCode(scenario)) {
        throw new AssistError(scenario, {
          detail: `Fake provider: scenario "${scenario}".`,
          ...(scenario === "rate_limited" ? { retryAfterSeconds: 12 } : {}),
          ...(scenario === "refused" ? { category: "general_harms" } : {}),
        });
      }

      const seed = seedOf(request);
      const wanted = wantedFor(request);

      const payload =
        request.kind === "thumbnail_critique"
          ? critiqueFor(request)
          : withClampBait(
              suggestionsFor(
                request,
                scenario === "overflow" ? wanted + 1 : wanted,
              ),
              scenario,
              request,
            );

      return assemble(request, payload, {
        provider: "fake",
        model: "fixtures",
        // Deterministic, and in the range a real call actually takes, so a UI
        // built against the fake is built against a wait that exists.
        elapsedMs: 900 + (seed % 1_200),
        servedByFallback: false,
      });
    },
  };
}
