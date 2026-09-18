"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import {
  createFilmingDay,
  linkVideosToFilmingDay,
  unlinkVideoFromFilmingDay,
} from "@/app/actions/filming-days";
import { CALENDAR_PATH, calendarHref } from "@/components/calendar/grid/url";
import { useToast } from "@/components/toast";
import { formatDateColumn, monthKey, monthOf } from "@/lib/calendar-dates";

import { nextSaturday } from "./schedule-day-button";

/** A day this video could be put on, as the select lists it. */
export interface LinkableDay {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly onDate: string;
  readonly notes: string | null;
  /**
   * The date in words, **formatted on the server**.
   *
   * Not formatted here, and this is not a style preference — it is a bug this
   * component had. This is a client component, so a server-rendered route
   * renders it once in Node and again in the browser during hydration, and
   * `Intl.DateTimeFormat` is one API with two implementations: Node 22's CLDR
   * writes "Wed 30 Sept" where Chromium 141 writes "Wed, 30 Sept". React
   * reported that as a hydration failure and threw this subtree away on every
   * page load. The codebase's existing rule covers it — the board and the flow
   * fields already format dates on the server and pass strings down — and this
   * is that rule applied here.
   *
   * A day created *after* mount has no server to ask, so its label is formatted
   * in the browser. Nothing is hydrating by then, so there is nothing to
   * disagree with.
   */
  readonly label: string;
}

/**
 * "Which day is this one being filmed on?", asked from the video's own page.
 *
 * PLAN.md asks for linking to be quick **from both ends**: from the day (the
 * board's badge and the calendar) and from the video. This is the second end,
 * and it is one select plus one disclosure, because a video's relationship to a
 * filming day is a single fact.
 *
 * ## Why it is not part of the autosaved flow fields beside it
 *
 * Every other control in the Flow section writes a column on `videos` through
 * `updateVideo`. This one writes the same table — `filming_day_id` — but it is
 * deliberately not in that vocabulary: attaching a video is the *day's*
 * business (it is the thing that knows about `unique (user_id, on_date)`, about
 * creating a day that does not exist yet, and about what "already booked" means),
 * and putting `filmingDayId` into `VideoPatchSchema` as well would give the
 * column two write paths that disagree about all three. The result is one
 * action file, `app/actions/filming-days.ts`, reached from both ends.
 *
 * ## Three things it can do
 *
 * - **Put the video on an existing day**, from the select.
 * - **Take it off**, which is the same select's first option and a column going
 *   to NULL. Nothing else about the video changes.
 * - **Schedule a new day and attach it**, from the disclosure. A date that is
 *   already booked is not an error here either: the video is attached to the day
 *   that is already there and the line says so.
 */
export function VideoFilmingDay({
  videoId,
  videoTitle,
  today,
  currentDayId,
  days,
}: {
  videoId: string;
  videoTitle: string;
  /** `YYYY-MM-DD`, from the page's one clock read. */
  today: string;
  currentDayId: string | null;
  /** Upcoming days, plus the one it is on when that is in the past. */
  days: readonly LinkableDay[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, startBusy] = useTransition();

  const selectId = useId();
  const newDateId = useId();

  const [current, setCurrent] = useState<string | null>(currentDayId);
  const [known, setKnown] = useState<readonly LinkableDay[]>(days);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDate, setNewDate] = useState(() => nextSaturday(today));

  /**
   * How a day that did not come from the server gets its words. Called from
   * event handlers only — see the note on `LinkableDay.label`.
   */
  const labelFor = (onDate: string): string =>
    formatDateColumn(onDate, "weekday") ?? onDate;

  const currentDay = known.find((day) => day.id === current) ?? null;

  function choose(dayId: string): void {
    setError(null);
    startBusy(async () => {
      try {
        if (dayId === "") {
          const result = await unlinkVideoFromFilmingDay({ videoId });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setCurrent(null);
          toast.push({
            message: `“${videoTitle}” is no longer on a filming day.`,
          });
          router.refresh();
          return;
        }

        const result = await linkVideosToFilmingDay({
          dayId,
          videoIds: [videoId],
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setCurrent(result.day.id);
        toast.push({
          message: `“${videoTitle}” is on the filming day of ${labelFor(result.day.onDate)}.`,
        });
        router.refresh();
      } catch {
        // The POST never landed. Without this the rejection escapes the
        // transition and — the app has no `app/error.tsx` — Next replaces the
        // whole video page with its error screen. See the same `catch` in
        // `components/board/board.tsx`.
        setError(UNREACHABLE);
      }
    });
  }

  function scheduleNew(): void {
    setError(null);
    startBusy(async () => {
      try {
        const result = await createFilmingDay({
          onDate: newDate,
          videoIds: [videoId],
        });

        if (result.ok) {
          remember(result.day);
          setCreating(false);
          toast.push({
            message: `Filming day scheduled for ${labelFor(result.day.onDate)}, with “${videoTitle}” on it.`,
          });
          router.refresh();
          return;
        }

        if (result.kind === "exists") {
          /*
          One creator, one camera, one day per date. The date is already booked,
          so the useful thing to do with this click is attach the video to the
          day that is already there — which is what the person was asking for,
          spelled slightly differently.
        */
          const existing = result.day;
          const linked = await linkVideosToFilmingDay({
            dayId: existing.id,
            videoIds: [videoId],
          });
          if (!linked.ok) {
            setError(linked.error);
            return;
          }
          remember(linked.day);
          setCreating(false);
          toast.push({
            message: `You already had a filming day on ${labelFor(existing.onDate)} — “${videoTitle}” was added to it.`,
          });
          router.refresh();
          return;
        }

        setError(result.error);
      } catch {
        setError(UNREACHABLE);
      }
    });
  }

  /** Keep a day the select has never heard of, so it can name what it shows. */
  function remember(day: {
    id: string;
    onDate: string;
    notes: string | null;
  }): void {
    setKnown((previous) =>
      previous.some((candidate) => candidate.id === day.id)
        ? previous
        : [
            ...previous,
            {
              id: day.id,
              onDate: day.onDate,
              notes: day.notes,
              label: labelFor(day.onDate),
            },
          ].sort((a, b) =>
            a.onDate < b.onDate ? -1 : a.onDate > b.onDate ? 1 : 0,
          ),
    );
    setCurrent(day.id);
  }

  return (
    <div
      data-testid="video-filming-day"
      data-day-id={current ?? ""}
      className="flex flex-col gap-1"
    >
      <label htmlFor={selectId} className="text-xs font-medium text-muted">
        Filming day
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <select
          id={selectId}
          data-testid="filming-day-select"
          disabled={busy}
          value={current ?? ""}
          onChange={(event) => choose(event.target.value)}
          className="min-w-52 rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        >
          <option value="">Not on a filming day</option>
          {known.map((day) => (
            <option key={day.id} value={day.id}>
              {day.label}
            </option>
          ))}
        </select>

        {currentDay ? (
          <Link
            href={calendarLinkTo(currentDay.onDate)}
            data-testid="filming-day-open"
            className="rounded-button px-2 py-1 text-[12px] text-muted underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          >
            See the day
          </Link>
        ) : null}
      </div>

      {creating ? (
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={newDateId} className="text-[11px] text-muted">
              New filming day on
            </label>
            <input
              id={newDateId}
              data-testid="new-filming-day-date"
              type="date"
              value={newDate}
              disabled={busy}
              onChange={(event) => setNewDate(event.target.value)}
              className="rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
          <button
            type="button"
            data-testid="new-filming-day-save"
            disabled={busy}
            onClick={scheduleNew}
            className="rounded-button bg-foreground px-3 py-2 text-sm font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
          >
            Schedule and attach
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(false)}
            className="rounded-button px-2 py-2 text-[13px] text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="new-filming-day"
          disabled={busy}
          onClick={() => setCreating(true)}
          className="self-start rounded-button px-1 py-1 text-[12px] text-muted underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          Schedule a new day…
        </button>
      )}

      {error ? (
        <p
          role="alert"
          data-testid="video-filming-day-error"
          className="text-[12px] text-over-limit"
        >
          {error}
        </p>
      ) : null}

      <p className="text-[11px] text-muted">
        Filming is the one step that needs a real block of time. A day gathers
        videos from every channel — one creator, one camera.
      </p>
    </div>
  );
}

/**
 * The link to a filming day on the calendar.
 *
 * `onDate.slice(0, 7)` would work and was what this did. It is gone because
 * slicing a month out of a date string is a *second* answer to "which month is
 * this day in", and M6's whole discipline is that there is one — so the month
 * comes from `monthOf`, the URL from the calendar's own `calendarHref`, and a
 * day that somehow is not a date links to the month grid's fallback rather than
 * to `/calendar?month=2026-1`.
 */
function calendarLinkTo(onDate: string): string {
  const month = monthOf(onDate);
  return month === null
    ? CALENDAR_PATH
    : calendarHref({ month: monthKey(month), day: onDate });
}

/**
 * What a dropped connection says. The application's one sentence for it —
 * `components/board/board.tsx`, `components/post-publish/confirm-live.tsx` and
 * both other filming components use the same words, because it is the same
 * event: the POST never landed, so nothing changed.
 */
const UNREACHABLE =
  "Could not reach the server, so nothing was changed. Nothing you typed has been lost — try again.";
