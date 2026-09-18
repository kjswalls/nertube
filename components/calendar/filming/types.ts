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

/**
 * Room for a call sheet, not for a script.
 *
 * It lives here rather than beside the zod schema that enforces it because
 * `app/actions/filming-days.ts` is a `"use server"` module, and such a module
 * may only export async functions — a `export const` in it is a build error,
 * not a style choice. Both ends need the number: the schema refuses more than
 * this, and the textarea stops at it.
 */
export const MAX_FILMING_NOTES_LENGTH = 2_000;

/**
 * How many videos one write may attach to a day.
 *
 * A list posted from a browser, and a server action is an HTTP endpoint like
 * any other, so the array is bounded — far above a real day's shoot and far
 * below a runaway `in (...)`. It lives here, beside the notes length and for
 * the same reason: `app/actions/filming-days.ts` is a `"use server"` module and
 * may only export async functions, while both the zod schema that enforces the
 * bound and the dialog that has to stay under it need the number. Before M6's
 * review only the schema knew it, so a dialog with 57 boxes ticked by default
 * was refused with a sentence that named no limit and offered no way to get
 * under one.
 */
export const MAX_FILMING_DAY_VIDEOS = 50;

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
  /**
   * `targetPublishDate` in words, **formatted on the server**, or null.
   *
   * Same rule, and same bug, as `LinkableDay.label` in `video-filming-day.tsx`:
   * `Intl.DateTimeFormat` is one API with two implementations, and since M6's
   * integration a `FilmingDay` is rendered by a *server* component on
   * `/calendar` as well as by a client one in the dialog. A date formatted
   * during render would be formatted once by Node and once by Chromium, and
   * React would throw the subtree away. It is formatted once, where the row is
   * read.
   */
  readonly targetPublishLabel: string | null;
  /**
   * The filming day this video is already on, or null when it is waiting for
   * one.
   *
   * Carried on the video rather than counted separately because `/calendar` and
   * `/now` have to agree about what "waiting for a block of time" means (M6's
   * integration brief), and the honest version of that set is *in Filming and
   * not yet on a day*. Deriving it from the row the badge already reads keeps
   * it one query and one definition.
   */
  readonly filmingDayId: string | null;
  /**
   * That day in words — "Sat 1 May" — or null when the video is not on one.
   *
   * Formatted on the server for the reason `targetPublishLabel` gives, and
   * carried rather than looked up because the schedule dialog is a client
   * component that has to be able to say *which* day a candidate is already on
   * without a second read. M6's review found the dialog pre-ticking every
   * candidate, booked ones included, so one press of "Schedule the day" moved
   * videos off a shoot that was already arranged and emptied it. Naming the day
   * on the row is half that fix; the other half is that a booked candidate
   * starts unticked.
   */
  readonly filmingDayLabel: string | null;
}

/** A scheduled batch day, with everything it covers. */
export interface FilmingDay {
  readonly id: string;
  /** `YYYY-MM-DD`. A calendar day, never an instant. */
  readonly onDate: string;
  /**
   * `onDate` in words — "Saturday 3 October 2026" — formatted on the server.
   * See `FilmingVideo.targetPublishLabel`; the reason is the same one.
   */
  readonly label: string;
  readonly notes: string | null;
  readonly videos: readonly FilmingVideo[];
}

/**
 * A video the schedule dialog can offer to attach — in practice, whatever is
 * sitting in Filming right now. The same shape as a video on a day, because it
 * is the same video, one decision earlier.
 */
export type FilmingCandidate = FilmingVideo;
