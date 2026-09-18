"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import {
  deleteFilmingDay,
  unlinkVideoFromFilmingDay,
  updateFilmingDay,
} from "@/app/actions/filming-days";
import { SaveStatus, useAutosave } from "@/components/autosave";
import { useToast } from "@/components/toast";
import { relativeDayLabel } from "@/lib/calendar-dates";

import { STATUS_LABEL, statusOf, summarise } from "./summary";
import { MAX_FILMING_NOTES_LENGTH, type FilmingDay } from "./types";

/**
 * What a filming day *contains*, drawn once and used from both places a day is
 * looked at: expanded from its event on the calendar, and inside the schedule
 * dialog the board's badge opens.
 *
 * One component for both, because they are the same object and the second copy
 * is where "the calendar says three videos and the dialog says two" comes from.
 *
 * ## What it shows, and why that is the honest version
 *
 * Every video the day covers, **with the stage it is in now**. A video filmed
 * on Saturday is in Editing by Sunday — the normal case, not an error — and a
 * day that hid it would be claiming an empty shoot. `summary.ts` turns the
 * stages into the one-line headline above the list; this file only draws it.
 *
 * ## The two destructive things, and how they differ
 *
 * - **Detach** takes one video off the day. Nothing else about the video
 *   changes, and a video without a day is the normal state of most of the
 *   board, so it happens on one click with a toast that says what happened.
 * - **Cancel this day** deletes the day itself. It asks first — and what it
 *   says while asking is the part that matters: the videos are *unlinked, not
 *   deleted*, which is the foreign key's `on delete set null` doing it rather
 *   than anything in this file. The count in the confirmation is read from the
 *   day, so it is the real number.
 *
 * ## Where focus goes, and why every write has to say
 *
 * Every control here is `disabled` while a write is in flight, and two of them
 * are *replaced* by the control that comes next ("Move this day…" by the date
 * box, "Cancel this day…" by the confirmation). Both of those drop focus on
 * `<body>`, where M6's review found it staying: Tab then restarts at the top of
 * the document, and the destructive path was the worst case — the confirmation
 * was a plain `<p>`, so activating the delete control announced nothing at all.
 *
 * So each write names its own landing place, and the confirmation is a
 * `role="status"` so it is spoken whether or not focus reaches it.
 *
 * ## A dropped connection changes nothing and says so
 *
 * Every action call is wrapped. Without the `catch`, an aborted POST escaped as
 * an unhandled rejection and — the app has no `app/error.tsx` — Next replaced
 * the whole route with its error page, taking the panel and anything composed
 * around it with it. `DayNotes` below already degraded correctly, because
 * `useAutosave` catches; this is the rest of the file brought up to it.
 */
export function FilmingDayPanel({
  day: dayProp,
  today,
  onChanged,
  testId = "filming-day-panel",
}: {
  day: FilmingDay;
  /** `YYYY-MM-DD`, from the server's one clock read. */
  today: string;
  /** The day after a change, or `null` when it has just been deleted. */
  onChanged?: (day: FilmingDay | null) => void;
  testId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  /*
    Unique per *instance*, not per day. Since M6's integration the same day can
    legitimately be on screen twice — expanded under the calendar grid, and
    again inside the schedule dialog when somebody picks a date that is already
    booked — and an id built from `day.id` would then be in the document twice,
    pointing a `<label>` at whichever came first.
  */
  const panelId = useId();

  /*
    The props are authoritative; what is kept here is only the delta a write on
    this panel produced, tagged with the props it was computed over. The moment
    a fresh server render arrives the tag stops matching and the new props win.
    This is the pattern `components/video-detail/flow-fields.tsx` arrived at
    after a `useState` initialiser left a client copy behind a `router.refresh`.
  */
  const propsVersion = `${dayProp.id}|${dayProp.onDate}|${dayProp.notes ?? ""}|${dayProp.videos
    .map((video) => video.id)
    .join(",")}`;
  const [applied, setApplied] = useState<{
    over: string;
    day: FilmingDay;
  } | null>(null);
  const day = applied && applied.over === propsVersion ? applied.day : dayProp;

  function absorb(next: FilmingDay): void {
    setApplied({ over: propsVersion, day: next });
  }

  const summary = summarise(day.videos, { onDate: day.onDate, today });
  /*
    Formatted on the server and carried on the day — not computed here. Since
    M6's integration this panel is rendered inside `/calendar`'s server-rendered
    day panel as well as inside the client-only schedule dialog, and
    `Intl.DateTimeFormat` disagrees with itself across Node and Chromium ("Wed
    30 Sept" against "Wed, 30 Sept"). Formatting during render would reintroduce
    the exact hydration failure `video-filming-day.tsx` already had to fix.
    `relativeDayLabel` is safe to call here: it is whole-day arithmetic over two
    `YYYY-MM-DD` strings with no locale data in it at all.
  */
  const dateLabel = day.label;
  const relative = relativeDayLabel(day.onDate, today);

  function detach(videoId: string, title: string, index: number): void {
    setError(null);
    startBusy(async () => {
      try {
        const result = await unlinkVideoFromFilmingDay({
          videoId,
          dayId: day.id,
        });
        if (!result.ok) {
          setError(result.error);
          // The row is still there, so the button that was pressed is too.
          wantFocus.current = { kind: "detach", index };
          return;
        }
        if (result.day) absorb(result.day);
        onChanged?.(result.day);
        toast.push({ message: `Took “${title}” off ${dateLabel}.` });
        // The row that has taken this one's place, or the last one left, or —
        // when the list has just emptied — the first control below it.
        wantFocus.current = { kind: "detach", index };
        router.refresh();
      } catch {
        setError(UNREACHABLE);
        wantFocus.current = { kind: "detach", index };
      }
    });
  }

  /**
   * The shoot moved to the Sunday.
   *
   * One column on one row, and the links come with it — which is the whole
   * reason this exists rather than "cancel and book again": cancelling unlinks
   * every video by design, and re-attaching four of them by hand to fix a typo
   * is exactly the friction BRIEF.md principle 6 is about.
   *
   * A date that is already booked is refused rather than merged, and the
   * refusal says what to do instead. That is `updateFilmingDay`'s answer, not a
   * second opinion formed here.
   */
  function moveDay(): void {
    if (moving === null) return;
    setError(null);
    const onDate = moving;
    startBusy(async () => {
      try {
        const result = await updateFilmingDay({ dayId: day.id, onDate });
        if (!result.ok) {
          setError(result.error);
          // The date box is still on screen and still holds what was typed.
          wantFocus.current = { kind: "move-date" };
          return;
        }
        absorb(result.day);
        onChanged?.(result.day);
        setMoving(null);
        toast.push({
          message: `Moved the filming day to ${result.day.label}.`,
        });
        // "Move it" has just been replaced by "Move this day…" again.
        wantFocus.current = { kind: "move" };
        router.refresh();
      } catch {
        setError(UNREACHABLE);
        wantFocus.current = { kind: "move-date" };
      }
    });
  }

  function cancelDay(): void {
    setError(null);
    startBusy(async () => {
      try {
        const result = await deleteFilmingDay({ dayId: day.id });
        if (!result.ok) {
          setError(result.error);
          // The confirmation is still up; the button that was pressed is still
          // the useful one.
          wantFocus.current = { kind: "cancel-yes" };
          return;
        }
        setConfirming(false);
        onChanged?.(null);
        toast.push({
          message:
            result.unlinked === 0
              ? `Cancelled the filming day on ${dateLabel}.`
              : `Cancelled ${dateLabel}. ${
                  result.unlinked === 1
                    ? "1 video is"
                    : `${result.unlinked} videos are`
                } no longer attached to a day — nothing was deleted.`,
        });
        router.refresh();
      } catch {
        setError(UNREACHABLE);
        wantFocus.current = { kind: "cancel-yes" };
      }
    });
  }

  /*
    The landing place the last write asked for, applied once the transition has
    committed and the node it names exists. The same shape `components/board`
    uses to put focus back on a card that has just been re-created in another
    column — a ref rather than state, because wanting focus is not something to
    re-render over.
  */
  const wantFocus = useRef<FocusRequest | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  /*
    Declared here, above the effect, because every write to the ref has to be:
    the React compiler's `react-hooks/immutability` rule refuses a mutation
    that appears after the effect reading it, and the controls below are JSX.
    One function, four callers, no second mechanism.
  */
  function requestFocus(next: FocusRequest): void {
    wantFocus.current = next;
  }
  useEffect(() => {
    if (busy) return;
    const wanted = wantFocus.current;
    if (!wanted) return;
    wantFocus.current = null;
    const root = rootRef.current;
    if (!root) return;
    // Something inside has kept focus — leave it there rather than taking the
    // caret off whatever the person moved to while the write was in flight.
    if (root.contains(document.activeElement)) return;
    focusFor(root, wanted)?.focus();
    // `moving` and `confirming` are here because two of the landing places are
    // asked for by a *state* change rather than by a write: "Move this day…"
    // and "Cancel this day…" replace themselves with the control that comes
    // next, and neither touches `busy` or `day`.
  }, [busy, day, moving, confirming]);

  return (
    <section
      ref={rootRef}
      data-testid={testId}
      data-day-id={day.id}
      data-on-date={day.onDate}
      data-tone={summary.tone}
      data-video-count={summary.total}
      className="flex flex-col gap-4"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-display text-[17px] leading-tight font-semibold tracking-tight">
            {dateLabel}
            {/*
              A real separator inside the heading, not the flex gap. Accessible
              names concatenate text nodes with nothing between them, so the
              gap alone read as "Monday, 28 September 2026in 10 days".
            */}
            {relative ? (
              <span className="font-mono text-[11px] font-normal text-muted">
                {" · "}
                {relative}
              </span>
            ) : null}
          </h3>
        </div>

        {/*
          The one line that says what this day is now. It carries colour only in
          the single case that is asking for a decision — a day that has passed
          with videos still in Filming. Everything else is furniture.
        */}
        <p
          data-testid="filming-day-headline"
          className={[
            "text-[12px] leading-5",
            summary.tone === "attention"
              ? "font-medium text-attention"
              : "text-muted",
          ].join(" ")}
        >
          {summary.headline}
        </p>
      </header>

      {day.videos.length > 0 ? (
        <ul data-testid="filming-day-videos" className="flex flex-col gap-1.5">
          {day.videos.map((video, index) => {
            const status = statusOf(video);
            return (
              <li
                key={video.id}
                data-testid="filming-day-video"
                data-video-id={video.id}
                data-status={status}
                className="flex items-start justify-between gap-3 rounded-input border border-border bg-background px-2.5 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/videos/${video.id}`}
                    className="truncate font-display text-[14px] leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {video.title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                    <span>{video.channelName}</span>
                    <span aria-hidden="true">·</span>
                    {/*
                      The stage the video is in now, and what that means for
                      this day. The stage's own name, because a channel may have
                      renamed it; the status word beside it, because "Editing"
                      alone does not say whether the shoot happened.
                    */}
                    <span>
                      {video.stageName}
                      <span className="text-muted/80">
                        {" "}
                        — {STATUS_LABEL[status]}
                      </span>
                    </span>
                    {video.targetPublishLabel ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          publishes {video.targetPublishLabel}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>

                <button
                  type="button"
                  data-testid="filming-day-detach"
                  disabled={busy}
                  onClick={() => detach(video.id, video.title, index)}
                  title={`Take “${video.title}” off this filming day. The video itself is untouched.`}
                  className="shrink-0 rounded-button px-2 py-1 text-[11px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                >
                  Detach
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">
          Nothing is attached to this day. Videos can be added from the board’s
          Filming column or from a video’s own page.
        </p>
      )}

      <DayNotes day={day} onSaved={absorb} />

      {error ? (
        <p
          role="alert"
          data-testid="filming-day-error"
          className="text-[12px] text-over-limit"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {moving === null ? (
          <button
            type="button"
            data-testid="move-day"
            disabled={busy || confirming}
            onClick={() => {
              setMoving(day.onDate);
              // The date box replaces this button; focus follows it there.
              requestFocus({ kind: "move-date" });
            }}
            className="rounded-button border border-border bg-background px-2.5 py-1 text-[12px] outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            Move this day…
          </button>
        ) : (
          <>
            <label htmlFor={`${panelId}-move`} className="sr-only">
              Move this filming day to
            </label>
            <input
              id={`${panelId}-move`}
              data-testid="move-day-date"
              type="date"
              value={moving}
              disabled={busy}
              onChange={(event) => setMoving(event.target.value)}
              className="rounded-input border border-border bg-background px-2.5 py-1 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <button
              type="button"
              data-testid="move-day-save"
              disabled={busy || moving === day.onDate}
              onClick={moveDay}
              className="rounded-button border border-border bg-background px-2.5 py-1 text-[12px] font-medium outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              Move it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMoving(null);
                requestFocus({ kind: "move" });
              }}
              className="rounded-button px-2 py-1 text-[12px] text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
            >
              Keep the date
            </button>
          </>
        )}

        {confirming ? (
          <>
            <p
              // Spoken whether or not focus reaches it. Activating "Cancel this
              // day…" unmounts that button, so without this a screen-reader
              // user heard nothing at all: the control vanished and the
              // question — which names how many videos come loose — was a plain
              // paragraph nobody was pointed at.
              role="status"
              data-testid="cancel-day-confirm"
              className="text-[12px] text-muted"
            >
              {summary.total === 0
                ? "Cancel this day?"
                : `Cancel this day? ${
                    summary.total === 1 ? "1 video" : `${summary.total} videos`
                  } will be unlinked — none of them is deleted.`}
            </p>
            <button
              type="button"
              data-testid="cancel-day-yes"
              disabled={busy}
              onClick={cancelDay}
              className="rounded-button border border-over-limit/50 px-2.5 py-1 text-[12px] font-medium text-over-limit outline-none transition-colors hover:bg-over-limit/10 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              Yes, cancel it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                requestFocus({ kind: "cancel" });
              }}
              className="rounded-button px-2 py-1 text-[12px] text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="cancel-day"
            disabled={busy || moving !== null}
            onClick={() => {
              setConfirming(true);
              // The confirmation replaces this button. Focus goes to the
              // answer, not to `<body>`.
              requestFocus({ kind: "cancel-yes" });
            }}
            className="rounded-button border border-border px-2.5 py-1 text-[12px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            Cancel this day…
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The call sheet: what to remember on the day. Saved on blur through the
 * application's one autosave hook, exactly like every text field on
 * `/videos/[id]` — there is no second save mechanism here.
 */
function DayNotes({
  day,
  onSaved,
}: {
  day: FilmingDay;
  onSaved: (day: FilmingDay) => void;
}) {
  const fieldId = useId();

  const autosave = useAutosave({
    initial: day.notes ?? "",
    save: async (next) => {
      const result = await updateFilmingDay({ dayId: day.id, notes: next });
      if (!result.ok) return { ok: false, error: result.error };
      onSaved(result.day);
      return { ok: true, value: result.day.notes ?? "" };
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="text-xs font-medium text-muted">
        Shoot notes
      </label>
      <textarea
        id={fieldId}
        data-testid="filming-day-notes"
        rows={2}
        maxLength={MAX_FILMING_NOTES_LENGTH}
        value={autosave.value}
        onChange={(event) => autosave.setValue(event.target.value)}
        onBlur={autosave.commit}
        placeholder="Shirt changes, lighting, which set."
        className="w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <SaveStatus state={autosave.state} testId="filming-day-notes-status" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Focus                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where the next commit should put the caret.
 *
 * A request rather than an element, because the element it names may not exist
 * yet: the write that asks for it is the write that is about to re-create the
 * list. `index` is the row the detach was pressed on — the row that takes its
 * place is the one to land on, which is what a person expects after removing an
 * item from a list.
 */
type FocusRequest =
  | { kind: "detach"; index: number }
  | { kind: "move" }
  | { kind: "move-date" }
  | { kind: "cancel" }
  | { kind: "cancel-yes" };

/** The element a request names, or the nearest honest substitute. */
function focusFor(root: HTMLElement, wanted: FocusRequest): HTMLElement | null {
  const pick = (testId: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(
      `[data-testid="${testId}"]:not([disabled])`,
    );

  if (wanted.kind === "detach") {
    const buttons = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-testid="filming-day-detach"]:not([disabled])',
      ),
    );
    if (buttons.length > 0) {
      return buttons[Math.min(wanted.index, buttons.length - 1)];
    }
    // The list has just emptied. The first control below it is the honest
    // landing place — "Move this day…" — rather than `<body>`.
    return pick("move-day") ?? pick("cancel-day");
  }

  if (wanted.kind === "move-date") return pick("move-day-date");
  if (wanted.kind === "move") return pick("move-day");
  if (wanted.kind === "cancel-yes") return pick("cancel-day-yes");
  return pick("cancel-day");
}

/**
 * What a dropped connection says here.
 *
 * Word for word the sentence `components/board/board.tsx` and
 * `components/post-publish/confirm-live.tsx` use, because it is the same event:
 * the POST never landed, so nothing changed and nothing typed is gone.
 */
const UNREACHABLE =
  "Could not reach the server, so nothing was changed. Nothing you typed has been lost — try again.";
