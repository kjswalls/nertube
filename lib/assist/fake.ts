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
 * Four further scenarios exercise the clamp rather than the error path:
 * `overflow` returns one more suggestion than was asked for, `duplicate`
 * repeats what the video already has *alongside* new ones, `unusable` returns
 * a blank and an over-long entry, and `all_duplicates` returns nothing but
 * repeats — the case that used to resolve as a success with an empty list and
 * overwrite the answer the column was keeping.
 *
 * And the voice guide is load-bearing here too: it picks which of two
 * phrasings each shape is said in, and a word out of the guide is woven into
 * the rationales, so "edit the voice guide, press the button, see different
 * output" is demonstrable without a key. What that demonstrates is the
 * *fixture* conditioning on the guide; whether a model does is the one thing
 * only a key can show.
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
  | "unusable"
  /**
   * Return *only* what the video already has, so the clamp empties the answer
   * completely. The blocker this scenario exists to hold shut: that case used
   * to be a success with zero proposals, which also wiped `brainstorm_last`.
   */
  | "all_duplicates";

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
  "all_duplicates",
]);

/** The four that produce a *bad answer* rather than a failed call. */
const CLAMP_SCENARIOS: ReadonlySet<string> = new Set([
  "overflow",
  "duplicate",
  "unusable",
  "all_duplicates",
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

/**
 * A fixture line, and why it is that line.
 *
 * Two things here are deliberate, and both were review findings.
 *
 * **The reason belongs to the shape.** The rationales used to come from their
 * own pool, rotated independently, so a title about a number sat under "…and
 * the number gives it a spine" only by accident and the same eight sentences
 * repeated three times down a list of twenty. That is decoration, and the
 * panel's whole design argument is that the reason beside a title is the part
 * still useful after the panel closes. Pairing them means every fixture
 * rationale is at least true of the line above it.
 *
 * **Two phrasings, chosen by the voice guide.** BRIEF.md's one hard
 * requirement for this feature is that output is conditioned on the channel's
 * voice guide. A real model does that in the prompt; the fixtures cannot, and
 * what they used to do — start the same pool at a different index — is a
 * reordering, which looks like conditioning to a set assertion and is not.
 * Now the guide picks which way each shape is said, so two different guides
 * produce visibly different sentences rather than the same ones shuffled. It
 * is still a fixture and still proves nothing about a model; it is just no
 * longer pretending.
 */
interface FixtureShape {
  /** The same idea, said two ways. `voiceRegister` chooses. */
  readonly say: readonly [(topic: string) => string, (topic: string) => string];
  /** Why *this* line works. One sentence, true of it. */
  readonly reason: string;
}

const TITLE_SHAPES: readonly FixtureShape[] = [
  {
    say: [(t) => `I tried ${t} for 30 days`, (t) => `30 days of ${t}: the results`],
    reason: "A fixed span and a first-person claim: the viewer knows exactly what they are being offered.",
  },
  {
    say: [(t) => `The honest truth about ${t}`, (t) => `What ${t} is really like`],
    reason: "Promises candour, which only works on a channel that has earned it — and it has.",
  },
  {
    say: [
      (t) => `${t}: what nobody tells you first`,
      (t) => `The bit about ${t} that gets left out`,
    ],
    reason: "Curiosity without a lie: the viewer cannot guess the missing part from the title.",
  },
  {
    say: [
      (t) => `Why ${t} stopped working for me`,
      (t) => `${t} worked, until it didn't`,
    ],
    reason: "A reversal in six words — the failure is the story, and failure gets watched to the end.",
  },
  {
    say: [
      (t) => `${t} — the 3 things that actually matter`,
      (t) => `Only 3 things matter in ${t}`,
    ],
    reason: "The number gives it a spine and tells the viewer how long the payoff takes.",
  },
  {
    say: [
      (t) => `How I finally got ${t} right`,
      (t) => `${t}, and the version that finally worked`,
    ],
    reason: "\"Finally\" implies the failures came first, so the video has somewhere to start.",
  },
  {
    say: [
      (t) => `The cheapest way to do ${t}`,
      (t) => `${t} for almost nothing`,
    ],
    reason: "Names a cost, which is the objection most of this audience already has.",
  },
  {
    say: [(t) => `${t} without the burnout`, (t) => `${t} you can keep up`],
    reason: "Sells the result rather than the contents — what the viewer gets, not what is in it.",
  },
  {
    say: [
      (t) => `What ${t} taught me about my own work`,
      (t) => `${t} changed how I work`,
    ],
    reason: "Widens past the topic, so it reaches people who do not care about the topic yet.",
  },
  {
    say: [
      (t) => `${t} is easier than everyone says`,
      (t) => `Everyone overstates how hard ${t} is`,
    ],
    reason: "Contradicts a belief the viewer holds, and a contradiction is hard to scroll past.",
  },
  {
    say: [
      (t) => `The ${t} mistake I made for two years`,
      (t) => `Two years of getting ${t} wrong`,
    ],
    reason: "A specific span plus an admission: concrete enough to be believed, cheap enough to click.",
  },
  {
    say: [
      (t) => `${t}, explained in one afternoon`,
      (t) => `An afternoon is enough to learn ${t}`,
    ],
    reason: "Bounds the commitment, which is the quiet reason people do not start.",
  },
  {
    say: [(t) => `Stop overthinking ${t}`, (t) => `${t}: stop planning, start doing`],
    reason: "An instruction rather than a description — it addresses the viewer directly.",
  },
  {
    say: [
      (t) => `${t}: a system that survives a bad week`,
      (t) => `The ${t} routine that holds when life doesn't`,
    ],
    reason: "Promises durability, not enthusiasm, which is what the returning viewer wants.",
  },
  {
    say: [
      (t) => `The part of ${t} everyone skips`,
      (t) => `Nobody does this part of ${t}`,
    ],
    reason: "An information gap with a clear shape: one part, named in the video, not in the title.",
  },
  {
    say: [
      (t) => `${t} on a beginner's budget`,
      (t) => `Starting ${t} with what you already own`,
    ],
    reason: "Names its audience in three words, which keeps the wrong viewers out of the retention graph.",
  },
  {
    say: [
      (t) => `One change that fixed ${t} for me`,
      (t) => `${t} got easy after one change`,
    ],
    reason: "Singular and cheap: one change is a promise a ten-minute video can keep.",
  },
  {
    say: [
      (t) => `${t} after the novelty wears off`,
      (t) => `${t} six weeks in, when it stops being fun`,
    ],
    reason: "Speaks to the stage most of the audience is actually at, not the one they started at.",
  },
  {
    say: [
      (t) => `Everything I got wrong about ${t}`,
      (t) => `${t}: my mistakes, in order`,
    ],
    reason: "Mistakes are specific in a way advice is not, so the video has real content to show.",
  },
  {
    say: [
      (t) => `${t}: is it worth your Saturday?`,
      (t) => `Is ${t} worth a whole weekend?`,
    ],
    reason: "Poses the decision the viewer is already making, and promises an answer to it.",
  },
  {
    say: [(t) => `The quiet case against ${t}`, (t) => `Why I stopped recommending ${t}`],
    reason: "Goes against the channel's own grain, which is the kind of thing a subscriber clicks.",
  },
  {
    say: [
      (t) => `${t} when you have 20 minutes a day`,
      (t) => `20 minutes a day is enough for ${t}`,
    ],
    reason: "A number the viewer can check against their own evening before they click.",
  },
  {
    say: [
      (t) => `Six months of ${t}, honestly`,
      (t) => `${t}: the six-month ledger`,
    ],
    reason: "Long enough to be evidence rather than a first impression, and it says so.",
  },
  {
    say: [
      (t) => `${t} for people who hate ${t}`,
      (t) => `${t} when you don't enjoy ${t}`,
    ],
    reason: "The tension is in the contradiction, so the thumbnail can carry the other half.",
  },
];

const CONCEPT_SHAPES: readonly FixtureShape[] = [
  {
    say: [
      (t) =>
        `Mid-shot, straight to camera, unimpressed expression, holding the one object that stands for ${t}. Plain wall behind. Three words top-left: NOT WORTH IT.`,
      (t) =>
        `Straight to camera, flat expression, the one object that stands for ${t} held up beside the face. Empty wall. Three words, top-left, no more.`,
    ],
    reason: "One subject, one expression, three words — still legible as a 360px tile on a phone.",
  },
  {
    say: [
      (t) =>
        `Overhead of the desk mid-mess: two coffees, the notebook open on the ${t} page, hands in frame. No text — the mess is the message.`,
      (t) =>
        `Looking down at the desk as it actually is: cold coffee, the ${t} notes open, both hands working. Nothing written on the image.`,
    ],
    reason: "Adds the state the title leaves out, and carries it without any text at all.",
  },
  {
    say: [
      (t) =>
        `Split frame: left, the setup on day one; right, the same setup after a month of ${t}. One arrow between them, nothing else.`,
      (t) =>
        `Two halves, same framing: before ${t}, and a month later. One arrow, no caption.`,
    ],
    reason: "The comparison is the whole idea, and a before/after reads at any size.",
  },
  {
    say: [
      (t) =>
        `Tight on the face, caught mid-laugh, with ${t} visibly going wrong behind the shoulder and slightly out of focus.`,
      (t) =>
        `Close on the face mid-laugh; ${t} failing quietly over the shoulder, soft focus.`,
    ],
    reason: "Puts the emotion in front and the subject behind — it promises a story, not a tutorial.",
  },
  {
    say: [
      (t) =>
        `Wide, small in frame, standing in front of the whole ${t} setup with arms folded. Reads as scale at tile size.`,
      (t) =>
        `Pulled right back: one small figure, arms folded, the entire ${t} setup filling the rest of the frame.`,
    ],
    reason: "Scale is the one thing a wide shot does that a close-up cannot, and it survives shrinking.",
  },
  {
    say: [
      (t) =>
        `Hand entering frame holding a single index card with the number from the video on it, ${t} blurred behind.`,
      (t) =>
        `One hand, one index card, the video's number written on it in marker; ${t} out of focus behind.`,
    ],
    reason: "Filmable in the room you already film in, and the number does the work the title cannot.",
  },
];

const HOOK_SHAPES: readonly FixtureShape[] = [
  {
    say: [
      (t) =>
        `Three weeks in, ${t} had cost me two hundred pounds and a Saturday, and I nearly gave up on it. Here is what changed on the Sunday.`,
      (t) =>
        `By week three ${t} had taken two hundred pounds and a Saturday off me. I almost stopped. Then Sunday happened.`,
    ],
    reason: "Opens on a cost and a moment, then holds the turn back — sayable in two breaths.",
  },
  {
    say: [
      (t) =>
        `Everyone told me ${t} needed the expensive version. It does not, and I can prove it in about four minutes.`,
      (t) =>
        `I was told ${t} only works if you buy the expensive one. That is wrong, and four minutes is all it takes to show why.`,
    ],
    reason: "Names the objection in the first line and puts a clock on the answer.",
  },
  {
    say: [
      (t) =>
        `The first time I tried ${t}, I got it completely backwards — and the mistake is the useful part, so let me show you that first.`,
      (t) =>
        `My first go at ${t} was backwards from start to finish. The mistake is the useful bit, so we start there.`,
    ],
    reason: "No preamble and no greeting: it starts mid-stride, which is what survives the edit.",
  },
  {
    say: [
      (t) =>
        `If you only take one thing from this: ${t} works when it is boring, and stops the moment you make it clever.`,
      (t) =>
        `One thing, if you take nothing else: ${t} works while it is boring. Make it clever and it stops.`,
    ],
    reason: "Delivers the whole promise in a sentence, so nobody has to wait fifteen seconds for it.",
  },
  {
    say: [
      (t) =>
        `I have done ${t} every day since January. Here is the honest ledger — what it gave back, and what it quietly took.`,
      (t) =>
        `Every day since January, ${t}. This is the ledger: what came back, and what it cost without saying so.`,
    ],
    reason: "A concrete span in the first clause, and the second sets up both halves of the video.",
  },
];

/**
 * The comparative sentence for the recommended pick.
 *
 * Its own pool, and comparative in form, because it answers a different
 * question from the per-item reasons above: not "why does this work" but "why
 * this one out of these". A fixture cannot actually compare twenty lines, so
 * what it does is deterministic and says so by being under a panel that
 * already admits it came from fixtures — but it is at least an answer to the
 * question the label asks, which the picked item's own rationale was not.
 */
const PICK_REASONS: Record<string, readonly string[]> = {
  titles: [
    "It is the only one here that makes a promise the video can be held to, which is what separates a title from a slogan.",
    "The others describe the video; this one describes what the viewer gets, and that is the difference in the click.",
    "Shortest of the strong ones — it survives a phone's truncation with the promise intact, which none of the longer ones do.",
    "It is the one whose gap the thumbnail can fill; the rest already say both halves themselves.",
    "It names something specific where the others generalise, and specifics are what get believed.",
  ],
  concepts: [
    "It is the only one that adds something the title does not already say — the rest illustrate the words.",
    "At tile size this is the one still readable; the others lose their subject before they lose their colour.",
    "Cheapest to film of the ones that work, and it needs nothing that is not already on the desk.",
    "It leaves the title something to do, which is what makes the pair work rather than repeat.",
  ],
  hooks: [
    "It is the one that pays the title off first instead of explaining what the video will cover.",
    "The others open on a description; this one opens on a moment, which is what keeps the first ten seconds.",
    "Shortest to say out loud of the three, and a hook that fits one breath is the one that survives the edit.",
  ],
};

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

/**
 * Which of a shape's two phrasings this channel gets.
 *
 * A property of the *guide*, not of the request, so the same guide always
 * sounds the same way across titles, concepts and hooks, and two different
 * guides differ in what is said rather than only in what order. No guide is
 * its own case: an unwritten guide gets the plainer phrasing, which is also
 * what the panel says out loud ("no voice guide, so this is generic advice").
 */
function voiceRegister(guide: string | null): 0 | 1 {
  if (guide === null) return 0;
  return (hash(cleanLabel(guide).toLocaleLowerCase()) & 1) as 0 | 1;
}

function shapesFor(request: AssistRequest): readonly FixtureShape[] {
  return request.kind === "titles"
    ? TITLE_SHAPES
    : request.kind === "concepts"
      ? CONCEPT_SHAPES
      : HOOK_SHAPES;
}

function suggestionsFor(
  request: AssistRequest,
  count: number,
): SuggestionsPayload {
  const seed = seedOf(request);
  const topic = topicOf(request);
  const word = voiceWord(request.channel.voiceGuide);
  const register = voiceRegister(request.channel.voiceGuide);

  // One rotation, over pairs: the reason a proposal carries is the reason
  // written for the line above it, not whatever the eighth entry of a second
  // pool happened to be.
  const chosen = rotate(shapesFor(request), seed, count);
  const suggestions = chosen.map((shape, index) => ({
    text: shape.say[register](topic),
    rationale:
      word !== null && index % 3 === 0
        ? `${shape.reason} Keeps the channel's "${word}" register.`
        : shape.reason,
  }));

  const picks = PICK_REASONS[request.kind] ?? PICK_REASONS.titles;

  return {
    suggestions,
    recommended_index: seed % Math.max(1, count),
    recommended_reason: picks[(seed >>> 5) % picks.length],
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
  /*
    The recommendation comes out of the verdicts this fixture just wrote, not
    out of the seed.

    Picked from the seed it was independent of the judgements beside it, so
    roughly one critique in three recommended a variant whose own verdict said
    it does not read at tile size — a "would ship" badge printed directly above
    "Does not read at tile size", over a button that writes a real
    `swap_thumbnail`. `clampCritique` now refuses such a recommendation; a
    fixture that can still produce one is a fixture modelling an answer the app
    has decided is incoherent, which is not a useful thing to develop against.
  */
  const shippable = verdicts.filter(
    (verdict) => verdict.reads_at_tile_size && verdict.complements_title,
  );
  const readable = verdicts.filter((verdict) => verdict.reads_at_tile_size);
  const pool = shippable.length > 0 ? shippable : readable;
  const recommended = pool[seed % Math.max(1, pool.length)];
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
  if (scenario === "all_duplicates") {
    const existing =
      request.kind === "thumbnail_critique" ? [] : (request.existing ?? []);
    return {
      ...payload,
      suggestions: existing.map((text) => ({
        text,
        rationale: "A repeat of one you already have.",
      })),
      recommended_index: 0,
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
