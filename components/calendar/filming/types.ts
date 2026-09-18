import type { StageKind } from "@/lib/defaults";

/**
 * What a filming day *is*, as far as anything that draws one is concerned.
 *
 * These types live under `components/` rather than in `lib/filming-data.ts`
 * because both sides of the boundary need them: the server reader fills them
 * in, the server actions hand them back, and the client components render them.
 * A client component may not import a module that reaches `next/headers`, so
 * putting the shapes where the reader lives would mean either a type-only
 * import that a future refactor can turn into a value import by accident, or a
 * second copy of the same four interfaces. This is the neutral ground.
 *
 * There is exactly one rule about the dates in here, and it is the milestone's
 * whole hazard: **`onDate` and `targetPublishDate` are `YYYY-MM-DD` calendar
 * days**, never instants. Everything that reads one goes through
 * `lib/calendar-dates.ts`.
 */

/** A video as a filming day renders it. */
export interface FilmingVideo {
  readonly id: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelSlug: string;
  /**
   * The stage the video is in **now**, not the stage it was in when it was
   * attached. This is what makes a past day truthful rather than stale — see
   * `summary.ts`.
   */
  readonly stageKind: StageKind | null;
  readonly stageName: string;
  /** Archived since. Still on the day, because it was still filmed that day. */
  readonly archived: boolean;
  /** `YYYY-MM-DD` or null. */
  readonly targetPublishDate: string | null;
}

/** A scheduled batch day, with everything it covers. */
export interface FilmingDay {
  readonly id: string;
  /** `YYYY-MM-DD`. A calendar day, never an instant. */
  readonly onDate: string;
  readonly notes: string | null;
  readonly videos: readonly FilmingVideo[];
}

/**
 * A video the schedule dialog can offer to attach — in practice, whatever is
 * sitting in Filming right now. The same shape as a video on a day, because it
 * is the same video, one decision earlier.
 */
export type FilmingCandidate = FilmingVideo;
