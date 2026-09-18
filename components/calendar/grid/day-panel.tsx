import Link from "next/link";

import { stripeClass } from "@/components/calendar/grid/channels";
import { calendarHref } from "@/components/calendar/grid/url";
import type {
  CalendarChannel,
  CalendarEvent,
} from "@/components/calendar/grid/types";
import { eventKey } from "@/components/calendar/grid/types";
import {
  formatDateColumn,
  relativeDayLabel,
  type DateColumn,
} from "@/lib/calendar-dates";

/** A filming day with the videos currently linked to it. */
export interface FilmingDayDetail {
  readonly filmingDayId: string;
  readonly notes: string | null;
  readonly videos: readonly {
    readonly id: string;
    readonly title: string;
    readonly channelId: string;
    readonly stageName: string | null;
  }[];
}

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
  /** Keyed by `filming_days.id`. */
  filming: ReadonlyMap<string, FilmingDayDetail>;
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="calendar-day-panel-heading"
          className="font-display text-[16px] font-semibold"
        >
          {formatDateColumn(date, "full")}
          {relative ? (
            <span className="ml-2 text-[12px] font-normal text-muted">
              {relative}
            </span>
          ) : null}
        </h2>

        <Link
          href={calendarHref({ month })}
          data-testid="calendar-day-close"
          className="rounded-button border border-border px-2 py-1 text-[12px] outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent"
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
              const detail = filming.get(event.filmingDayId);
              return (
                <li
                  key={eventKey(event)}
                  data-testid="calendar-day-filming"
                  data-filming-day={event.filmingDayId}
                  className="rounded-card border border-border border-dashed px-3 py-2"
                >
                  <p className="text-[13px] font-medium">
                    Filming day
                    <span className="ml-2 font-mono text-[11px] text-muted">
                      {event.videoCount}
                    </span>
                  </p>
                  {detail?.notes ? (
                    <p className="mt-1 font-display text-[13px] text-muted">
                      {detail.notes}
                    </p>
                  ) : null}

                  {detail && detail.videos.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {detail.videos.map((video) => (
                        <li key={video.id}>
                          <VideoLine
                            href={`/videos/${video.id}`}
                            title={video.title}
                            channel={channelById.get(video.channelId)}
                            showTag={showTag}
                            trailing={video.stageName}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[12px] text-muted">
                      No videos are linked to this day.
                    </p>
                  )}
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
  state?: string;
}) {
  return (
    <Link
      href={href}
      data-testid="calendar-day-line"
      data-state={state}
      className={[
        "flex items-baseline gap-2 rounded-button py-1 pr-2 pl-2 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent",
        channel ? stripeClass(channel.stripe) : "",
      ].join(" ")}
    >
      {channel && showTag ? (
        <span className="shrink-0 font-mono text-[10px] tracking-wide text-muted">
          {channel.tag}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-display text-[14px]">
        {title}
      </span>
      {channel ? <span className="sr-only">, {channel.name}</span> : null}
      {trailing ? (
        <span className="shrink-0 text-[11px] text-muted">{trailing}</span>
      ) : null}
      {late ? (
        <span className="shrink-0 text-[11px] font-medium text-over-limit">
          late
        </span>
      ) : null}
    </Link>
  );
}
