"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type RefObject } from "react";

import {
  createFilmingDay,
  linkVideosToFilmingDay,
  type FilmingDayState,
} from "@/app/actions/filming-days";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { formatDateColumn } from "@/lib/calendar-dates";

import { FilmingDayPanel } from "./filming-day-panel";
import { MAX_FILMING_NOTES_LENGTH, type FilmingCandidate } from "./types";

/**
 * Scheduling a batch filming day: the dialog the board's Filming badge opens.
 *
 * BRIEF.md principle 4 is a loop — *three or more videos sitting in Filming is
 * the signal to schedule a batch day* — and this is the part of it that turns
 * noticing into a booking. Everything the badge already knows arrives
 * pre-selected, so the shortest path through this box is: pick the Saturday,
 * press Enter.
 *
 * ## Two phases, because there are two answers
 *
 * **Compose.** A date, optional notes, and the videos to cover — every video
 * currently in Filming, in every channel, all ticked. Unticking is how you say
 * "not that one"; nothing else has to be done.
 *
 * **Scheduled.** What now exists, drawn by `FilmingDayPanel` — the same
 * component the calendar expands a day into, so the dialog and the calendar
 * cannot end up describing a day differently. From here the day can have videos
 * detached, notes written and the whole thing cancelled, which is what makes
 * the loop reversible without leaving the board.
 *
 * ## The date that is already taken
 *
 * `unique (user_id, on_date)` means one filming day per date — one creator, one
 * camera. So a second attempt on a date that already has one is **not** shown
 * as a failure: `createFilmingDay` catches the constraint, reads the existing
 * day back, and this dialog moves straight to the scheduled phase with that day
 * and an "add these N to it" button. The database error never reaches a human;
 * what reaches them is the day they forgot they had booked.
 */
export function ScheduleDayDialog({
  candidates,
  defaultDate,
  today,
  returnFocusRef,
  onClose,
}: {
  /** Everything in Filming right now — all ticked to begin with. */
  candidates: readonly FilmingCandidate[];
  /** `YYYY-MM-DD` the date box opens on. Computed by the opener, not here. */
  defaultDate: string;
  /** `YYYY-MM-DD`, the server's one clock read. */
  today: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, startBusy] = useTransition();

  const dateId = useId();
  const notesId = useId();

  const [date, setDate] = useState(defaultDate);
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(candidates.map((candidate) => candidate.id)),
  );
  const [error, setError] = useState<string | null>(null);

  /** Set once a day exists — the second phase. */
  const [day, setDay] = useState<FilmingDayState | null>(null);
  /** "You already had one on that date", when that is how we got here. */
  const [notice, setNotice] = useState<string | null>(null);

  /** The videos that are ticked and not already on the day being looked at. */
  const outstanding = candidates.filter(
    (candidate) =>
      selected.has(candidate.id) &&
      !(day?.videos ?? []).some((video) => video.id === candidate.id),
  );

  function toggle(id: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function schedule(): void {
    setError(null);
    startBusy(async () => {
      const result = await createFilmingDay({
        onDate: date,
        notes,
        videoIds: [...selected],
      });

      if (result.ok) {
        setDay(result.day);
        setNotice(result.warning ?? null);
        toast.push({
          message: `Filming day scheduled for ${formatDateColumn(result.day.onDate, "weekday") ?? result.day.onDate}${
            result.linked === 0
              ? ""
              : `, covering ${result.linked === 1 ? "1 video" : `${result.linked} videos`}`
          }.`,
        });
        router.refresh();
        return;
      }

      if (result.kind === "exists") {
        // Not an error: the day they asked for is the day they already have.
        setDay(result.day);
        setNotice(
          `You already have a filming day on ${formatDateColumn(result.day.onDate, "weekday") ?? result.day.onDate}. Add to it instead of starting a second one.`,
        );
        return;
      }

      setError(result.error);
    });
  }

  function addOutstanding(): void {
    if (!day) return;
    setError(null);
    const ids = outstanding.map((candidate) => candidate.id);
    startBusy(async () => {
      const result = await linkVideosToFilmingDay({ dayId: day.id, videoIds: ids });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDay(result.day);
      setNotice(result.warning ?? null);
      toast.push({
        message: `${result.linked === 1 ? "1 video" : `${result.linked} videos`} added to ${
          formatDateColumn(result.day.onDate, "weekday") ?? result.day.onDate
        }.`,
      });
      router.refresh();
    });
  }

  return (
    <Modal
      title={day ? "Filming day" : "Schedule a batch filming day"}
      testId="schedule-day-dialog"
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {day === null ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            schedule();
          }}
        >
          <p className="text-xs text-muted">
            One day, one camera: there can only be one filming day per date, and
            it gathers videos from every channel.
          </p>

          <div className="flex flex-col gap-1">
            <label htmlFor={dateId} className="text-xs font-medium text-muted">
              Date
            </label>
            {/*
              The native date control, for the reason `/videos/[id]` gives: no
              picker library, the operating system's own control, keyboard
              accessible for free, and it cannot produce anything but
              `YYYY-MM-DD` — which is exactly what a `date` column holds. The
              action re-checks it anyway.
            */}
            <input
              id={dateId}
              data-testid="filming-day-date"
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={notesId} className="text-xs font-medium text-muted">
              Shoot notes <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id={notesId}
              data-testid="filming-day-notes-new"
              rows={2}
              maxLength={MAX_FILMING_NOTES_LENGTH}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Shirt changes, lighting, which set."
              className="w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-muted">
              Videos to shoot
              <span className="ml-2 font-mono text-[11px]">
                {selected.size}/{candidates.length}
              </span>
            </legend>

            {candidates.length === 0 ? (
              <p className="text-[12px] text-muted">
                Nothing is in Filming right now. The day can be scheduled empty
                and filled from a video’s own page later.
              </p>
            ) : (
              <ul
                data-testid="filming-candidates"
                className="flex max-h-56 flex-col gap-1 overflow-y-auto"
              >
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <label className="flex items-start gap-2 rounded-input border border-border bg-background px-2.5 py-2">
                      <input
                        type="checkbox"
                        data-testid="filming-candidate"
                        data-video-id={candidate.id}
                        checked={selected.has(candidate.id)}
                        onChange={() => toggle(candidate.id)}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-display text-[14px] leading-snug">
                          {candidate.title}
                        </span>
                        <span className="text-[11px] text-muted">
                          {candidate.channelName}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          {error ? (
            <p
              role="alert"
              data-testid="schedule-day-error"
              className="text-[12px] text-over-limit"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="schedule-day-submit"
              disabled={busy}
              // The application's primary button: solid ink, no hue. The
              // accent means "this needs attention" everywhere else in the
              // product, and a save button is not that.
              className="min-h-11 rounded-button bg-foreground px-4 py-2 text-sm font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              {busy ? "Scheduling…" : "Schedule the day"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-button px-2 py-1.5 text-[13px] text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
            >
              Not now
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          {notice ? (
            <p
              data-testid="filming-day-notice"
              role="status"
              className="rounded-input border border-attention/40 bg-attention/10 px-2.5 py-2 text-[12px] text-attention"
            >
              {notice}
            </p>
          ) : null}

          {/* The same panel the calendar expands a day into. */}
          <FilmingDayPanel
            day={day}
            today={today}
            onChanged={(next) => {
              if (next === null) {
                // The day has just been cancelled; there is nothing left to
                // show, so the dialog goes with it.
                onClose();
                return;
              }
              setDay(next);
            }}
          />

          {error ? (
            <p
              role="alert"
              data-testid="schedule-day-error"
              className="text-[12px] text-over-limit"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {outstanding.length > 0 ? (
              <button
                type="button"
                data-testid="add-to-existing-day"
                disabled={busy}
                onClick={addOutstanding}
                className="min-h-11 rounded-button bg-foreground px-4 py-2 text-sm font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
              >
                {busy
                  ? "Adding…"
                  : `Add ${outstanding.length === 1 ? "this video" : `these ${outstanding.length} videos`} to it`}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="schedule-day-done"
              onClick={onClose}
              className="rounded-button border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
