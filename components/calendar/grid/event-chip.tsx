import Link from "next/link";

import { stripeClass } from "@/components/calendar/grid/channels";
import { calendarHref } from "@/components/calendar/grid/url";
import type {
  CalendarChannel,
  CalendarEvent,
} from "@/components/calendar/grid/types";
import { STATE_WORDS } from "@/components/calendar/grid/types";

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
 * - **The state** is a word, and it is the only thing on a publish chip that
 *   takes a colour: `late` — the date has passed and the video is neither
 *   scheduled nor live — is drawn in the over-limit tone. Planned, scheduled and
 *   published are quiet, because a video that is where it should be does not
 *   need attention.
 *
 * A filming chip has exactly one coloured state of its own, and it is the
 * mirror image: `tone === "attention"`, the day that has passed with videos
 * still in Filming. Two coloured states on the whole grid, one per event kind,
 * both meaning "this is asking for a decision".
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
    /*
      The one filming state that spends colour: the day has passed and videos
      are still in Filming — the batch day that did not happen. `summarise()`
      decided it where the day was read (`lib/calendar-data.ts`); this chip only
      draws the answer, so the grid and the day panel cannot disagree about
      which day is asking for a decision.

      Everything else is furniture, in exactly the dashed outline it had before.
      A calendar is the easiest place in an app to end up with a bag of
      highlighters.
    */
    const missed = event.tone === "attention";

    return (
      <Link
        href={calendarHref({ month, day: event.date })}
        data-testid="calendar-chip"
        data-kind="filming"
        data-date={event.date}
        data-tone={event.tone}
        title={`Filming day — ${event.headline}${event.notes ? ` — ${event.notes}` : ""}`}
        className={[
          "flex items-center gap-1 rounded-button border border-dashed px-1.5 py-0.5 text-[11px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-accent",
          // The phone's day list (see `MonthGrid`): a full-width row, 44px.
          "max-md:min-h-11 max-md:gap-2 max-md:px-3 max-md:text-[14px] max-md:leading-5",
          // 44px under a thumb at any width: a phone held sideways is wider
          // than `md` and gets the grid, with a finger (M10 review).
          "thumb:min-h-11",
          missed
            ? "border-attention/50 bg-attention/10 font-medium text-attention hover:bg-attention/20"
            : "border-border bg-background hover:bg-surface",
        ].join(" ")}
      >
        {/* The one piece of iconography on the grid. A filming day is not a
            video and must not read as one, so it carries a mark no chip ever
            does and the word itself. */}
        <span
          aria-hidden="true"
          className={[
            "font-mono text-[10px]",
            missed ? "text-attention" : "text-muted",
          ].join(" ")}
        >
          ●
        </span>
        <span className="min-w-0 truncate font-medium">Filming day</span>
        <span
          className={[
            "shrink-0 font-mono text-[10px]",
            missed ? "text-attention" : "text-muted",
          ].join(" ")}
        >
          {event.videoCount}
        </span>
        <span className="sr-only">
          {event.videoCount === 1
            ? ", 1 video linked"
            : `, ${event.videoCount} videos linked`}
          {missed
            ? `, ${event.pending === 1 ? "1 video is" : `${event.pending} videos are`} still to shoot and this day has passed`
            : ""}
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
      title={[event.title, channel?.name, event.stageName, state.tooltip]
        .filter(Boolean)
        .join(" · ")}
      className={[
        "flex items-center gap-1 rounded-button bg-surface py-0.5 pr-1.5 pl-1 text-[11px] leading-4 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent",
        // The phone's day list (see `MonthGrid`): a full-width row, 44px,
        // with the whole title — wrapped, never cut — on the page's ground.
        "max-md:min-h-11 max-md:gap-2 max-md:bg-background max-md:py-1.5 max-md:pr-3 max-md:pl-2.5 max-md:text-[15px] max-md:leading-5",
        // 44px under a thumb at any width (M10 review: landscape phones).
        "thumb:min-h-11",
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
      <span className="min-w-0 truncate font-display max-md:whitespace-normal">
        {event.title}
      </span>
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
