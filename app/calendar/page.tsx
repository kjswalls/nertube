import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { DayPanel } from "@/components/calendar/grid/day-panel";
import { EmptyMonth, type NearestMonth } from "@/components/calendar/grid/empty-month";
import { MonthGrid } from "@/components/calendar/grid/month-grid";
import { MonthNav } from "@/components/calendar/grid/month-nav";
import { packDay } from "@/components/calendar/grid/density";
import { dayFromQuery, monthFromQuery } from "@/components/calendar/grid/url";
import { ScheduleFilmingDayButton } from "@/components/calendar/filming/schedule-day-button";
import { nearestMonths, readCalendarMonth } from "@/lib/calendar-data";
import { monthKey, monthOf, todayColumn } from "@/lib/calendar-dates";
import { readFilmingVideos } from "@/lib/filming-data";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const month = first((await searchParams).month);
  return { title: `${month ?? "calendar"} · calendar · NerTube` };
}

/**
 * `/calendar` — every channel's publishing rhythm on one month grid.
 *
 * BRIEF.md asks for this in one line ("target publish dates across channels,
 * plus scheduled batch-filming days as a distinct event type") and gives the
 * reason in another: *publishing is a rhythm, and filming is the one step that
 * needs a real block of time*. So the page is cross-channel by default — it is
 * the only view in the product that is — and a filming day is drawn as its own
 * kind of thing rather than as a video that happens to be about filming.
 *
 * ## Everything on this page is in its URL
 *
 * `?month=YYYY-MM` is the month; `?day=YYYY-MM-DD` is the day whose full list
 * is open. Both are read here, both are rendered on the server, and nothing
 * under `components/calendar/grid/` is a client component. The consequence that
 * matters: a month can be linked, bookmarked and shared, which is the
 * requirement, and the grid itself costs no hydration.
 *
 * Two client islands sit *inside* that server-rendered page, and only two, both
 * from `components/calendar/filming/`: the button that books a day, and the
 * panel a filming day expands into. They are interactive by nature — they
 * write — and they are the same components the board's badge and `/videos/[id]`
 * use rather than calendar-flavoured copies of them. Navigation is still
 * entirely links.
 *
 * A `?month=` that is not a month falls back to this month rather than 404ing —
 * there is nothing at `/calendar` that can be missing, and a link with a typo
 * in it should still land on a calendar.
 *
 * ## One clock, one calendar day
 *
 * The request reads `Date.now()` exactly once and turns it into a calendar day
 * exactly once, through `todayColumn` in `lib/calendar-dates.ts`. Every "is
 * this late", "is this today" and "which month is this" on the page descends
 * from that one value, so no two parts of the page can land on opposite sides
 * of midnight — and because the helper is UTC, the server's render and the
 * browser's hydration agree about which cell is today whatever zone either is
 * in. The cost of that choice is recorded in `docs/MILESTONES.md`.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  // The page's one clock read: a dynamic route (it reads cookies through
  // `requireUser`), so this runs once per request.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const today = todayColumn(now);
  const currentMonth = monthKey(monthOf(today) ?? { year: 1970, month: 1 });
  const month = monthFromQuery(first(query.month), now);
  const openDay = dayFromQuery(first(query.day));

  const { channels, events, filming, counts } = await readCalendarMonth(
    month,
    today,
  );

  /*
    What is waiting for a block of time.

    This is the same read the board's badge uses — `readFilmingVideos()` in
    `lib/filming-data.ts`, the one definition of "in Filming" — narrowed to the
    videos that are not on a day yet. It is here because of the disagreement
    M6's brief names: `/now` deliberately hides the filming and editing kinds
    behind its "10 minutes or less" filter, on the grounds that they need a real
    block, and the calendar is where a block gets booked. A creator who filters
    `/now` down to what they can do right now should be able to find the rest
    *here*, rather than nowhere.

    It is cross-channel and unscoped by month on purpose: a video waiting for a
    camera is not waiting in September, it is just waiting.
  */
  const waitingForADay = (await readFilmingVideos()).filter(
    (video) => video.filmingDayId === null,
  );

  const isEmpty = events.length === 0;
  let nearest: { previous: NearestMonth | null; next: NearestMonth | null } = {
    previous: null,
    next: null,
  };
  if (isEmpty) {
    // Only the empty state asks this question, so only the empty state pays
    // for it.
    nearest = await nearestMonths(month);
  }

  const openEvents = openDay
    ? packDay(events.filter((event) => event.date === openDay)).all
    : [];

  return (
    <AppShell section="calendar" gutter="reading" now={now}>
      <div className="flex flex-col gap-4">
        <MonthNav
          month={month}
          currentMonth={currentMonth}
          summary={summarise(counts, channels.length)}
        />

        {/*
          Booking a day from the calendar. The same control the board's badge
          became, in its `plain` tone: on the board it is a signal that has
          fired (three or more waiting) and it carries the attention colour; here
          it is an affordance on the page whose job is scheduling, so it is
          quiet furniture. One component, two tones — not a second dialog.
        */}
        {waitingForADay.length > 0 ? (
          <div
            data-testid="calendar-waiting-for-a-day"
            data-count={waitingForADay.length}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-4 py-3"
          >
            <p className="text-[13px] text-muted">
              <span className="font-medium text-foreground">
                {waitingForADay.length === 1
                  ? "1 video is"
                  : `${waitingForADay.length} videos are`}
              </span>{" "}
              waiting for a filming day. Filming needs a real block of time, so
              it does not show up on{" "}
              <Link
                href="/now"
                className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
              >
                What can I move right now?
              </Link>
              .
            </p>
            <ScheduleFilmingDayButton
              candidates={waitingForADay}
              today={today}
              label="Schedule a filming day"
              title="Book a batch day and put these videos on it."
            />
          </div>
        ) : null}

        {isEmpty ? (
          <EmptyMonth
            month={month}
            previous={nearest.previous}
            next={nearest.next}
            boardHref={
              channels[0] ? `/c/${channels[0].slug}/board` : null
            }
          />
        ) : null}

        <MonthGrid
          month={month}
          events={events}
          channels={channels}
          today={today}
          openDay={openDay}
        />

        {openDay ? (
          <DayPanel
            date={openDay}
            month={month}
            events={openEvents}
            channels={channels}
            filming={filming}
            today={today}
          />
        ) : null}

        {channels.length > 1 ? (
          /*
            The legend. Two channels on one grid means every chip carries a
            two-letter tag, and a tag nobody can expand is a puzzle — so the
            expansion is on the page, once, rather than repeated on forty
            chips. It is also the only place the stripe styles are explained.
          */
          <p
            data-testid="calendar-legend"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted"
          >
            <span className="sr-only">Channel tags used on this calendar:</span>
            {channels.map((channel) => (
              <span key={channel.id} className="flex items-baseline gap-1.5">
                <span className="font-mono text-[10px] tracking-wide">
                  {channel.tag}
                </span>
                {channel.name}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}

/**
 * What this month is holding, in one line under the heading.
 *
 * The two event types are counted separately and never summed: they are
 * different kinds of thing, and one number covering both would be a number with
 * no name. The sidebar's badge counts the first of them, by the same
 * definition, so the two cannot disagree on the current month.
 */
function summarise(
  counts: { videos: number; filmingDays: number },
  channelCount: number,
): string {
  if (counts.videos === 0 && counts.filmingDays === 0) {
    return "Nothing planned in this month.";
  }

  const parts: string[] = [];
  if (counts.videos === 0) {
    parts.push("No videos going out");
  } else {
    parts.push(
      counts.videos === 1 ? "1 video going out" : `${counts.videos} videos going out`,
    );
  }
  if (counts.filmingDays > 0) {
    parts.push(
      counts.filmingDays === 1
        ? "1 filming day"
        : `${counts.filmingDays} filming days`,
    );
  }

  // The cross-channel claim is only worth making when there is more than one
  // channel to be crossing.
  const scope = channelCount > 1 ? " Every channel, on one grid." : "";
  return `${parts.join(" · ")}.${scope}`;
}

/** `?x=a&x=b` is a valid URL; the calendar takes the first value. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
