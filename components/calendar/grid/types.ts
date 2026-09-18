import type { DateColumn } from "@/lib/calendar-dates";

/**
 * What the month grid draws, described without a database or a `<div>` in
 * sight, so that the packing rules and the channel tags can be unit-tested.
 *
 * Two event kinds, because BRIEF.md's calendar is two different questions on
 * one grid: *when does this go out* (a target publish date, one per video) and
 * *when am I behind a camera* (a filming day, one per date, shared by every
 * video linked to it). PLAN.md calls the second "a distinct event type", and
 * that is what the discriminant here is for — they are not the same row with a
 * flag, they have different shapes and they are read differently.
 */

/** A channel, as a chip needs it. */
export interface CalendarChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /**
   * The short form printed on every chip: "SS", "NE". Two channels can share a
   * grid and a person has to be able to tell their rows apart *without* colour,
   * so this is the primary distinguisher and the stripe style beside it is the
   * secondary one. `tagsFor()` guarantees they are unique.
   */
  readonly tag: string;
  /**
   * Which of the four stripe styles this channel's chips carry. An index, not
   * a hue: see `docs/MILESTONES.md` on why channel identity spends no colour.
   */
  readonly stripe: number;
}

/**
 * How a video sits against its own target date — the "is it actually on track"
 * of the task, decided in one place so the chip, the day panel and the tooltip
 * cannot disagree.
 */
export type PublishState =
  /** Live. The date is history and the video is on YouTube. */
  | "published"
  /** Scheduled in YouTube Studio; the date is a promise the platform will keep. */
  | "scheduled"
  /** The date has passed and the video is neither scheduled nor live. */
  | "late"
  /** Ahead of its date, somewhere in the pipeline. */
  | "planned";

export interface PublishEvent {
  readonly kind: "publish";
  /** The date column it is drawn on: `videos.target_publish_date`. */
  readonly date: DateColumn;
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  /** The stage it is in right now, by name — renamed stages follow. */
  readonly stageName: string | null;
  readonly state: PublishState;
}

export interface FilmingEvent {
  readonly kind: "filming";
  /** `filming_days.on_date`. */
  readonly date: DateColumn;
  readonly filmingDayId: string;
  readonly notes: string | null;
  /** How many videos are linked to it right now. Zero is a real answer. */
  readonly videoCount: number;
  /**
   * What the day is now, from `components/calendar/filming/summary.ts` — the
   * same `summarise()` the day panel's headline comes from, called once where
   * the day is read rather than recomputed per chip.
   *
   * `attention` means exactly one thing: **the day has passed and videos are
   * still in Filming** — the batch day that did not happen. It is the one
   * filming state the milestone reserved colour for, and until M6's review the
   * grid never asked, so a shoot that silently did not happen was pixel-identical
   * to one that did on the view whose whole job is showing a month of days. That
   * is the opposite of BRIEF.md principle 5.
   */
  readonly tone: "quiet" | "attention";
  /** The same one-line headline the day panel prints, for the chip's title. */
  readonly headline: string;
  /** Still to shoot — what the attention tone is counting. */
  readonly pending: number;
}

export type CalendarEvent = PublishEvent | FilmingEvent;

/** A stable key for a React list and for a test to point at. */
export function eventKey(event: CalendarEvent): string {
  return event.kind === "publish"
    ? `publish:${event.videoId}`
    : `filming:${event.filmingDayId}`;
}

/**
 * The words a publish state is read out and hovered with.
 *
 * Here rather than beside the chip because the day panel says them too: M6's
 * review found the panel — the view you open to see a day *in full* — saying
 * strictly less about a video than the cell it expands, with no state word at
 * all except a visible "late". One table, two renderers.
 */
export const STATE_WORDS: Record<
  PublishState,
  { spoken: string; tooltip: string }
> = {
  late: {
    spoken: "late — this date has passed",
    tooltip: "late — the target date has passed and it is not scheduled",
  },
  planned: { spoken: "on track", tooltip: "on track" },
  scheduled: {
    spoken: "scheduled on YouTube",
    tooltip: "scheduled in YouTube Studio",
  },
  published: { spoken: "published", tooltip: "published" },
};
