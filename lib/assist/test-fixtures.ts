import type {
  AssistRequest,
  ChannelContext,
  ThumbnailCritiqueRequest,
  VideoContext,
} from "./types";

/**
 * Request builders shared by the four `lib/assist/*.test.ts` suites.
 *
 * It is a plain module rather than a `.test.ts` one because four test files
 * import it, and the alternative — a twelve-line builder copied four times —
 * is exactly the duplication seven milestones of reviews have policed. It
 * imports nothing but types, so it costs the shipped bundle nothing: no app
 * module imports it, and there is no runtime value in it to import.
 */

export const VOICE_GUIDE_ALPHA = `Write like someone who has actually done the
thing and is slightly tired of being asked about it. Short sentences. British
spelling. No hype, no "game changer", and never tell the viewer how to feel.
Numbers wherever a number is honest.`;

export const VOICE_GUIDE_BETA = `Exuberant, generous, a little chaotic. Long
sentences that pile on. American spelling. Jokes land before the point does, and
the enthusiasm is real rather than performed.`;

export function videoContext(over: Partial<VideoContext> = {}): VideoContext {
  return {
    title: "Editing my videos on a ten year old laptop",
    oneLineHook: "The bottleneck was never the machine.",
    notes: "Ran the last six edits on the 2015 MacBook. Proxy workflow, render times, what actually broke.",
    tags: ["editing", "gear"],
    thumbnailConcept: null,
    ...over,
  };
}

export function channelContext(over: Partial<ChannelContext> = {}): ChannelContext {
  return {
    name: "Sunday Softworks",
    voiceGuide: VOICE_GUIDE_ALPHA,
    pastTitles: [
      "I deleted my second monitor for a month",
      "The cheapest camera I would still buy",
    ],
    ...over,
  };
}

/** A titles request, the one the "Generate 20" pill makes. */
export function titlesRequest(over: {
  video?: Partial<VideoContext>;
  channel?: Partial<ChannelContext>;
  want?: number;
  existing?: readonly string[];
} = {}): AssistRequest {
  return {
    kind: "titles",
    video: videoContext(over.video),
    channel: channelContext(over.channel),
    ...(over.want === undefined ? {} : { want: over.want }),
    ...(over.existing === undefined ? {} : { existing: over.existing }),
  };
}

/** A hooks request. `existing` is required: the ask is "the ones missing". */
export function hooksRequest(over: {
  video?: Partial<VideoContext>;
  channel?: Partial<ChannelContext>;
  existing?: readonly string[];
} = {}): AssistRequest {
  return {
    kind: "hooks",
    video: videoContext(over.video),
    channel: channelContext(over.channel),
    existing: over.existing ?? [],
  };
}

/** A concepts request. */
export function conceptsRequest(over: {
  video?: Partial<VideoContext>;
  channel?: Partial<ChannelContext>;
} = {}): AssistRequest {
  return {
    kind: "concepts",
    video: videoContext(over.video),
    channel: channelContext(over.channel),
  };
}

/** A critique request with one-pixel PNGs standing in for real uploads. */
export function critiqueRequest(
  roles: ThumbnailCritiqueRequest["variants"][number]["role"][] = [
    "wild_card",
    "moderate",
    "safe",
  ],
): ThumbnailCritiqueRequest {
  return {
    kind: "thumbnail_critique",
    video: videoContext({ thumbnailConcept: "Face left, laptop open, one prop" }),
    channel: channelContext(),
    variants: roles.map((role) => ({
      role,
      mediaType: "image/png" as const,
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    })),
  };
}
