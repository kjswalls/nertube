import Link from "next/link";

import { stripeClass } from "@/components/calendar/grid/channels";
import { calendarHref } from "@/components/calendar/grid/url";
import type {
  CalendarChannel,
  CalendarEvent,
  PublishState,
} from "@/components/calendar/grid/types";

/**
 * One line in a day cell.
 *
 * ## What a chip has to say in about 140 pixels
 *
 * The working title, which channel it is on, and whether it is actually on
 * track. Three facts, one line, and only one of them is allowed to spend
 * colour.
 *
 * - **The channel** is the mono tag (`SS`) plus the line style of the stripe
 *   down the left edge. Two signals, neither of them a hue — see
 *   `components/calendar/grid/channels.ts` for the argument. The channel's full
 *   name is in the link's accessible name and in its tooltip, so nothing
 *   depends on decoding the abbreviation.
 * - **The title** is the video's own words, so it is set in the reading face,
 *   truncated with the full string in `title`.
 * - **The state** is a word, and it is the only place on this page that takes a
 *   colour: `late` — the date has passed and the video is neither scheduled nor
 *   live — is drawn in the over-limit tone. Planned, scheduled and published
 *   are quiet, because a video that is where it should be does not need
 *   attention.
 */
export function EventChip({
  event,
  channel,
  showTag,
  month,
}: {
  event: CalendarEvent;
  /** The channel a publish event belongs to; ignored for a filming day. */
  channel?: CalendarChannel;
  /**
   * Draw the channel tag at all.
   *
   * False on a one-channel account, where every chip would carry the same two
   * letters expanding to the only channel there is — a label that distinguishes
   * nothing, on the narrowest element in the product. The stripe stays (it
   * costs no width) and the channel is still in the accessible name.
   */
  showTag: boolean;
  /** Which month the chip is drawn in, so a link back keeps the view. */
  month: string;
}) {
  if (event.kind === "filming") {
    return (
      <Link
        href={calendarHref({ month, day: event.date })}
        data-testid="calendar-chip"
        data-kind="filming"
        data-date={event.date}
        title={
          event.notes
            ? `Filming day — ${event.notes}`
            : "Filming day — the block of time the camera is out"
        }
        className="flex items-center gap-1 rounded-button border border-border border-dashed bg-background px-1.5 py-0.5 text-[11px] leading-4 outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* The one piece of iconography on the grid. A filming day is not a
            video and must not read as one, so it carries a mark no chip ever
            does and the word itself. */}
        <span aria-hidden="true" className="font-mono text-[10px] text-muted">
          ●
        </span>
        <span className="min-w-0 truncate font-medium">Filming day</span>
        <span className="shrink-0 font-mono text-[10px] text-muted">
          {event.videoCount}
        </span>
        <span className="sr-only">
          {event.videoCount === 1
            ? ", 1 video linked"
            : `, ${event.videoCount} videos linked`}
        </span>
      </Link>
    );
  }

  const state = STATE_WORDS[event.state];

  return (
    <Link
      href={`/videos/${event.videoId}`}
      data-testid="calendar-chip"
      data-kind="publish"
      data-date={event.date}
      data-video={event.videoId}
      data-channel={channel?.id ?? ""}
      data-state={event.state}
      title={[
        event.title,
        channel?.name,
        event.stageName,
        state.tooltip,
      ]
        .filter(Boolean)
        .join(" · ")}
      className={[
        "flex items-center gap-1 rounded-button bg-surface py-0.5 pr-1.5 pl-1 text-[11px] leading-4 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent",
        channel ? stripeClass(channel.stripe) : "border-l-2 border-l-border",
      ].join(" ")}
    >
      {channel && showTag ? (
        <span
          aria-hidden="true"
          data-testid="calendar-chip-tag"
          className="shrink-0 font-mono text-[10px] tracking-wide text-muted"
        >
          {channel.tag}
        </span>
      ) : null}
      <span className="min-w-0 truncate font-display">{event.title}</span>
      {event.state === "late" ? (
        <span
          aria-hidden="true"
          className="shrink-0 text-[10px] font-medium text-over-limit"
        >
          late
        </span>
      ) : null}
      {/* The accessible name carries everything the eye gets from the tag, the
          stripe and the tone — a chip read aloud says which channel it is on
          and how it is doing, in words. */}
      <span className="sr-only">
        {channel ? `, ${channel.name}` : ""}
        {event.stageName ? `, in ${event.stageName}` : ""}
        {`, ${state.spoken}`}
      </span>
    </Link>
  );
}

const STATE_WORDS: Record<
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
