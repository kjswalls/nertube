import Link from "next/link";

import { FilmingDayPanel } from "@/components/calendar/filming/filming-day-panel";
import type { FilmingDay } from "@/components/calendar/filming/types";
import { stripeClass } from "@/components/calendar/grid/channels";
import { RevealOnPhone } from "@/components/calendar/grid/reveal-on-phone";
import { calendarHref } from "@/components/calendar/grid/url";
import type {
  CalendarChannel,
  CalendarEvent,
  PublishState,
} from "@/components/calendar/grid/types";
import { STATE_WORDS, eventKey } from "@/components/calendar/grid/types";
import {
  formatDateColumn,
  relativeDayLabel,
  type DateColumn,
} from "@/lib/calendar-dates";

/**
 * One day, in full — where the cell's "+N more" goes, and where a filming day
 * expands to the videos it is for.
 *
 * ## Why a panel under the grid and not a dialog
 *
 * Because it has to be reachable, and "reachable" has a specific meaning here:
 * a keyboard reaches it by tabbing to a link and pressing Enter, a screen
 * reader reaches it because it is ordinary content in the document, and a
 * *bookmark* reaches it because it is `?day=`. A dialog would need focus
 * management, an escape key, a client component and a second keyboard
 * mechanism — and `components/modal.tsx` already exists for the one case that
 * genuinely needs all of that, which is capture.
 *
 * The cell whose panel is open is outlined in the grid above, so the link
 * between the two is visible without scrolling back and forth.
 */
export function DayPanel({
  date,
  month,
  events,
  channels,
  filming,
  today,
}: {
  date: DateColumn;
  month: string;
  /** Everything on this date, already ordered by `packDay`. */
  events: readonly CalendarEvent[];
  channels: readonly CalendarChannel[];
  /**
   * Keyed by `filming_days.id`, straight from `lib/filming-data.ts` — the same
   * objects the board's dialog and `/videos/[id]` work with.
   */
  filming: ReadonlyMap<string, FilmingDay>;
  today: DateColumn;
}) {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const relative = relativeDayLabel(date, today);
  // Same rule as the grid: one channel needs no abbreviation of itself.
  const showTag = channels.length > 1;

  return (
    <section
      data-testid="calendar-day-panel"
      data-date={date}
      data-count={events.length}
      aria-labelledby="calendar-day-panel-heading"
      className="rounded-card border border-border bg-surface px-4 py-3"
    >
      <RevealOnPhone date={date} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="calendar-day-panel-heading"
          className="font-display text-[16px] font-semibold"
        >
          {formatDateColumn(date, "full")}
          {relative ? (
            <>
              {/*
                A real separator, not a margin. Accessible-name computation
                concatenates text nodes with nothing between them, so `ml-2`
                alone produced "Wednesday, 23 September 2026in 5 days" as this
                region's label.
              */}
              {" · "}
              <span className="text-[12px] font-normal text-muted">
                {relative}
              </span>
            </>
          ) : null}
        </h2>

        <Link
          href={calendarHref({ month })}
          data-testid="calendar-day-close"
          className="rounded-button border border-border px-2 py-1 text-[12px] outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent thumb:inline-flex thumb:min-h-11 thumb:items-center"
        >
          Close
        </Link>
      </div>

      {events.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          Nothing is planned for this day.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {events.map((event) => {
            if (event.kind === "filming") {
              const day = filming.get(event.filmingDayId);
              if (!day) return null;
              return (
                <li
                  key={eventKey(event)}
                  data-testid="calendar-day-filming"
                  data-filming-day={event.filmingDayId}
                  className="rounded-card border border-dashed border-border px-3 py-3"
                >
                  {/*
                    The real panel, not a read-only copy of it.

                    Until M6's integration this branch drew its own list of the
                    day's videos, which meant a filming day could be *seen* on
                    the calendar and only *changed* from the board's dialog —
                    two renderings of one object, already disagreeing about
                    archived videos. `FilmingDayPanel` is the one component, so
                    detaching a video, writing shoot notes, moving the shoot or
                    cancelling it all work from the day you are looking at.

                    It is a client island inside this server-rendered panel; it
                    is handed `day.label`, formatted on the server, because
                    `Intl` output differs between Node and Chromium.
                  */}
                  <FilmingDayPanel
                    day={day}
                    today={today}
                    testId="calendar-filming-day-panel"
                  />
                </li>
              );
            }

            return (
              <li key={eventKey(event)} data-testid="calendar-day-video">
                <VideoLine
                  href={`/videos/${event.videoId}`}
                  title={event.title}
                  channel={channelById.get(event.channelId)}
                  showTag={showTag}
                  trailing={event.stageName}
                  late={event.state === "late"}
                  state={event.state}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function VideoLine({
  href,
  title,
  channel,
  showTag,
  trailing,
  late = false,
  state,
}: {
  href: string;
  title: string;
  channel?: CalendarChannel;
  showTag: boolean;
  trailing: string | null;
  late?: boolean;
  state?: PublishState;
}) {
  return (
    <Link
      href={href}
      data-testid="calendar-day-line"
      data-state={state}
      className={[
        "flex items-baseline gap-2 rounded-button py-1 pr-2 pl-2 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:items-center",
        channel ? stripeClass(channel.stripe) : "",
      ].join(" ")}
    >
      {channel && showTag ? (
        // Hidden from assistive tech, exactly as `EventChip` hides it: the
        // channel's full name is in the accessible name below, so reading the
        // abbreviation as well says the same thing twice and the first time
        // meaninglessly.
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[10px] tracking-wide text-muted"
        >
          {channel.tag}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-display text-[14px]">
        {title}
      </span>
      {/* Everything the eye gets from the tag, the trailing stage and the tone,
          in words — the same clause the chip in the cell above carries. The
          panel is the view you open to see a day in full; it must not say less
          than the cell it expands. */}
      <span className="sr-only">
        {channel ? `, ${channel.name}` : ""}
        {trailing ? `, in ${trailing}` : ""}
        {state ? `, ${STATE_WORDS[state].spoken}` : ""}
      </span>
      {trailing ? (
        <span aria-hidden="true" className="shrink-0 text-[11px] text-muted">
          {trailing}
        </span>
      ) : null}
      {late ? (
        <span
          aria-hidden="true"
          className="shrink-0 text-[11px] font-medium text-over-limit"
        >
          late
        </span>
      ) : null}
    </Link>
  );
}
