"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { updateVideo, type VideoState } from "@/app/actions/videos";
import {
  SaveStatus,
  useAutosave,
  useSaveQueue,
  type SaveOutcome,
} from "@/components/autosave";
import { useVideoVersion, type VideoVersion } from "@/components/video-version";
import {
  MAX_NOTES_LENGTH,
  MAX_URL_LENGTH,
  MAX_WAITING_ON_LENGTH,
} from "@/lib/video-fields";

import {
  VideoFilmingDay,
  type LinkableDay,
} from "@/components/calendar/filming/video-filming-day";

import { formatAge } from "./age";
import { StageSelect, type FlowStage } from "./stage-select";

/**
 * The rest of the detail page: the fields that are about a video's *flow*
 * rather than its packaging.
 *
 * PLAN.md's M2 line ends with *"target date, URL, notes, `waiting_on`, archive,
 * stage select. Autosave on blur through `updateVideo`."* — this is that list.
 * The packaging block (candidates, concept, hooks, the gate indicator, the skip
 * flow) is a sibling on the same page and is not here; the two share the page
 * and nothing else.
 *
 * ## Every field saves the same way
 *
 * On blur, through `useAutosave` in `components/autosave.tsx` — the one
 * autosave pattern on this page, shared with the packaging block above.
 * Nothing is sent when nothing changed, a failure keeps what was typed, and the
 * value is re-read from what the server confirmed rather than assumed.
 *
 * Two controls are not text and do not wait for a blur: the stage select and
 * the archive button save the moment they are used, because a click *is* the
 * decision and there is nothing to type afterwards.
 *
 * ## The one thing that is not a column write
 *
 * The stage select goes through `moveVideo` → the `move_video` RPC, exactly
 * like a drag on the board and exactly like `[` / `]`. `UPDATE (stage_id)` is
 * revoked from clients, so there is no other way for it to work — which is the
 * point: the TTH gate cannot be walked around by moving a video from the page
 * where the packaging fields live. See `stage-select.tsx`.
 */

export type { FlowStage };

export interface FlowFieldsProps {
  videoId: string;
  /** The working title, for the messages a filming-day change announces. */
  videoTitle: string;
  /** The channel's label for its filming-kind stage, for the day panel's note. */
  filmingName: string;
  /** The channel's slug, for the board revalidation a move triggers. */
  channelSlug: string;
  /** Enabled stages, in `position` order — the board's column order. */
  stages: readonly FlowStage[];
  currentStageId: string;
  currentStageName: string;
  /** `YYYY-MM-DD`, or "" for none — what a `<input type="date">` speaks. */
  targetPublishDate: string;
  /** Today as a calendar day, from the page's one clock read (M6). */
  today: string;
  /** The filming day this video is on, or null. */
  filmingDayId: string | null;
  /** The days it could be put on: upcoming, plus the one it is on. */
  filmingDays: readonly LinkableDay[];
  youtubeUrl: string;
  notes: string;
  waitingOn: string;
  /** ISO, paired with `waitingOn` by a CHECK. */
  waitingSince: string | null;
  /** `formatAge(waitingSince)`, computed on the server so hydration agrees. */
  waitingAgeLabel: string | null;
  /** ISO or null. Non-null means the card is off the board. */
  archivedAt: string | null;
  /** When the video actually went live, or null. */
  publishedAt: string | null;
  /** `published_at` formatted on the server, for the same reason. */
  publishedLabel: string | null;
}

/** The parts of the row that more than one control on this block renders. */
interface Shared {
  readonly archivedAt: string | null;
  readonly publishedAt: string | null;
  readonly publishedLabel: string | null;
  readonly waitingSince: string | null;
  readonly waitingAgeLabel: string | null;
}

export function FlowFields(props: FlowFieldsProps) {
  const router = useRouter();

  const version = useVideoVersion();

  /**
   * The parts of the row that more than one control renders — and which of the
   * two sources of them is currently the newer.
   *
   * `archived_at` is written by the archive button and read by the banner;
   * `waiting_since` is written by the waiting field and read by its age line;
   * `published_at` decides how the URL is presented, and is written *only* by
   * `move_video`.
   *
   * These used to be seeded into `useState` from the props and updated from
   * save answers alone. A `useState` initialiser does not re-run, so a
   * `router.refresh()` — which is exactly what the stage select does after a
   * move — updated the server-rendered chip and left this copy behind: moving a
   * video to Published from this very page left the URL block saying "Saved,
   * but not live: this video has not reached a Published stage yet" about a
   * video the user had just published. `published_at` is a column no save on
   * this block can change, so the client copy could never catch up at all.
   *
   * So the props are authoritative again. What is kept is only the *delta* a
   * save on this page produced, tagged with the props it was computed over: the
   * moment a fresh server render arrives, the tag stops matching and the new
   * props win.
   */
  const propsVersion = `${props.archivedAt}|${props.publishedAt}|${props.waitingSince}`;
  const [applied, setApplied] = useState<{ over: string; value: Shared } | null>(
    null,
  );

  const shared: Shared =
    applied && applied.over === propsVersion
      ? applied.value
      : {
          archivedAt: props.archivedAt,
          publishedAt: props.publishedAt,
          publishedLabel: props.publishedLabel,
          waitingSince: props.waitingSince,
          waitingAgeLabel: props.waitingAgeLabel,
        };

  /** Apply what an action just confirmed. Called from every save. */
  function absorb(video: VideoState): void {
    version.adopt(video.updatedAt);
    setApplied({
      over: propsVersion,
      value: {
        archivedAt: video.archivedAt,
        publishedAt: video.publishedAt,
        // Recomputed alongside the value it labels, rather than left pointing
        // at the old one: `absorb` used to update `publishedAt` and not
        // `publishedLabel`, so even the save path could leave the two out of
        // step.
        publishedLabel: formatPublishedDate(video.publishedAt),
        waitingSince: video.waitingSince,
        // Recomputed here rather than on the server because this is a save the
        // user just made: the clock is read inside an event handler, never while
        // rendering, so there is no hydration mismatch to have.
        waitingAgeLabel: formatAge(video.waitingSince, Date.now()),
      },
    });
  }

  return (
    <section
      data-testid="flow-fields"
      aria-labelledby="flow-fields-heading"
      className="flex flex-col gap-6 border-t border-border pt-6"
    >
      <h2 id="flow-fields-heading" className="text-sm font-semibold">
        Flow
      </h2>

      {shared.archivedAt === null ? null : <ArchivedBanner />}

      <StageSelect
        videoId={props.videoId}
        channelSlug={props.channelSlug}
        stages={props.stages}
        currentStageId={props.currentStageId}
        currentStageName={props.currentStageName}
        onMoved={() => router.refresh()}
      />

      <TargetDateField
        videoId={props.videoId}
        initial={props.targetPublishDate}
        onSaved={absorb}
      />

      {/*
        Which day this one is being filmed on (M6).

        It sits directly under the target date because the two are the video's
        two dates and a creator reads them together — *when is it shot* and
        *when does it go out*. It is the only control in this block that does
        not go through `updateVideo`: attaching a video is the filming day's
        business, and `components/calendar/filming/video-filming-day.tsx`
        explains why giving `filming_day_id` a second write path here would be
        a mistake.
      */}
      <VideoFilmingDay
        videoId={props.videoId}
        videoTitle={props.videoTitle}
        filmingName={props.filmingName}
        today={props.today}
        currentDayId={props.filmingDayId}
        days={props.filmingDays}
      />

      <WaitingOnField
        videoId={props.videoId}
        initial={props.waitingOn}
        ageLabel={shared.waitingAgeLabel}
        onSaved={absorb}
      />

      <YoutubeUrlField
        videoId={props.videoId}
        initial={props.youtubeUrl}
        publishedAt={shared.publishedAt}
        publishedLabel={shared.publishedLabel}
        onSaved={absorb}
      />

      <NotesField
        videoId={props.videoId}
        initial={props.notes}
        onSaved={absorb}
      />

      <ArchiveButton
        videoId={props.videoId}
        archivedAt={shared.archivedAt}
        onChanged={(video) => {
          absorb(video);
          // The board is a different route; this refreshes the page the user is
          // on so the banner and the header agree with the row.
          router.refresh();
        }}
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                             */
/* -------------------------------------------------------------------------- */

/** The label/hint pair every field wears, so they cannot drift apart. */
function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
      {children}
    </label>
  );
}

const INPUT_CLASS =
  // 16px text so iOS does not zoom the page when the field takes focus.
  "w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Turn one flow save into the `SaveOutcome` the autosave hook speaks.
 *
 * `key` is which column came back — the field re-reads its own value from the
 * server's answer, so an empty box that became NULL renders as an empty box
 * rather than as the string "null".
 */
function flowSaver(
  videoId: string,
  key: keyof Pick<
    VideoState,
    "targetPublishDate" | "youtubeUrl" | "notes" | "waitingOn"
  >,
  onSaved: (video: VideoState) => void,
  version: VideoVersion,
): (next: string) => Promise<SaveOutcome<string>> {
  return async (next) => {
    // The version this patch was computed against, so a row that something else
    // has changed in the meantime is reported rather than overwritten. See
    // `components/video-version.tsx`.
    const expected = version.peek();

    const result = await updateVideo({
      videoId,
      ...(expected === undefined ? {} : { expectedUpdatedAt: expected }),
      [key]: next,
    });
    if (!result.ok) {
      return { ok: false, error: result.error, conflict: result.conflict };
    }

    onSaved(result.video);
    return { ok: true, value: result.video[key] ?? "" };
  };
}

/**
 * `published_at` as a date, in UTC with a fixed locale — the same formatting
 * the server render uses, so a label recomputed after a save reads identically
 * to one that came down with the page.
 */
function formatPublishedDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/* -------------------------------------------------------------------------- */
/* Target publish date                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The target publish date: a plain `<input type="date">`, and a button to empty
 * it.
 *
 * No date-picker library. The native control is the one the operating system
 * already knows how to show — including the phone keyboard PLAN.md's mobile
 * capture path cares about — it is keyboard-accessible for free, and it cannot
 * produce anything but `YYYY-MM-DD`, which is exactly what a `date` column
 * holds. (The action re-checks that anyway: a server action is a POST endpoint
 * like any other.)
 *
 * **Clearing is a first-class action.** "Not scheduled yet" is the normal state
 * of most of the board — the date sorts every column, and `nulls last` is where
 * an unplanned video belongs. Chrome and Firefox do offer their own clear
 * affordance inside the control, but it is small, it is not the same in any two
 * browsers and it is invisible to a description of the page, so there is a real
 * button that says what it does.
 *
 * Saved on change *and* on blur: picking a date from the calendar overlay is
 * the whole interaction, and waiting for a blur after it would leave a decision
 * unsaved on screen. `commit` is a no-op when nothing changed, so the two
 * cannot double-save.
 */
function TargetDateField({
  videoId,
  initial,
  onSaved,
}: {
  videoId: string;
  initial: string;
  onSaved: (video: VideoState) => void;
}) {
  const inputId = useId();
  const version = useVideoVersion();
  const field = useAutosave({
    initial,
    save: flowSaver(videoId, "targetPublishDate", onSaved, version),
  });

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={inputId}>Target publish date</FieldLabel>

      <div className="flex items-center gap-2">
        <input
          id={inputId}
          name="targetPublishDate"
          type="date"
          data-testid="target-date"
          value={field.value}
          /*
            On change *and* on blur, which is what the two doc comments have
            always claimed and what neither of them did. Picking a date from the
            native overlay is the whole interaction and the control keeps focus
            afterwards, so a blur-only save left a decision sitting unsaved on
            screen with the status line saying nothing — and `NULL` still in the
            column after navigating away. `commit` returns early when the value
            already matches what has been sent, so the pair cannot double-save.
          */
          onChange={(event) => {
            field.setValue(event.target.value);
            field.commit();
          }}
          onBlur={field.commit}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          data-testid="target-date-clear"
          // Nothing to clear is a disabled button rather than a hidden one:
          // the control does not move around as the field is used.
          disabled={field.value === "" || field.pending}
          onClick={() => {
            field.setValue("");
            field.commit();
          }}
          className="shrink-0 rounded-button border border-border px-3 py-2 text-sm outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      <SaveStatus
        state={field.state}
        testId="target-date-status"
        idle={
          field.value === ""
            ? "No date yet — it sorts to the end of its column."
            : ""
        }
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* waiting_on                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * "Waiting on": blocked on someone or something else.
 *
 * One of the three genuinely *stored* inputs `/now` reads (PLAN.md open
 * question 3 — everything else on that page is derived), so it is stored
 * faithfully: the text as typed, `NULL` when empty rather than `''`, and paired
 * with `waiting_since` so the age is a fact rather than a guess.
 *
 * The age is the reason the field is worth having. "Waiting on the editor" is
 * information; "waiting on the editor for three weeks" is a decision. Rewording
 * the text does not restart that clock — see `updateVideo`.
 */
function WaitingOnField({
  videoId,
  initial,
  ageLabel,
  onSaved,
}: {
  videoId: string;
  initial: string;
  ageLabel: string | null;
  onSaved: (video: VideoState) => void;
}) {
  const inputId = useId();
  const version = useVideoVersion();
  const field = useAutosave({
    initial,
    save: flowSaver(videoId, "waitingOn", onSaved, version),
  });

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={inputId}>Waiting on</FieldLabel>

      <div className="flex items-center gap-2">
        <input
          id={inputId}
          name="waitingOn"
          type="text"
          data-testid="waiting-on"
          value={field.value}
          placeholder="the editor, a delivery, a quiet evening…"
          autoComplete="off"
          maxLength={MAX_WAITING_ON_LENGTH}
          onChange={(event) => field.setValue(event.target.value)}
          onBlur={field.commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Blur does the saving, so Enter and clicking away are one path.
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className={INPUT_CLASS}
        />
        <button
          type="button"
          data-testid="waiting-on-clear"
          disabled={field.value === "" || field.pending}
          onClick={() => {
            field.setValue("");
            field.commit();
          }}
          className="shrink-0 rounded-button border border-border px-3 py-2 text-sm outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          Unblocked
        </button>
      </div>

      <SaveStatus
        state={field.state}
        testId="waiting-on-status"
        idle={
          field.value === ""
            ? "Nothing is blocking this one."
            : ageLabel
              ? `Blocked for ${ageLabel}.`
              : ""
        }
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Final YouTube URL                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The final YouTube URL.
 *
 * Validated as a link (`http`/`https`, parseable) because it ends up in an
 * `href`, but not pinned to a list of YouTube hostnames: `youtu.be`, a Studio
 * link and a members-only link are all things a creator legitimately pastes,
 * and refusing the address the site actually gave them helps nobody.
 *
 * ## It must not look live before it is
 *
 * `published_at` is set by `move_video` on first entry to a Published stage,
 * and it is the only thing that knows whether this video exists on YouTube. A
 * URL can be pasted long before that — from a scheduled upload, from Studio —
 * and if the page rendered it as an ordinary "Watch on YouTube" link the
 * creator would click it, get a 404 and have no way to tell whether the link is
 * wrong or the video simply is not out yet.
 *
 * So the link is only a link once `published_at` is set. Before that the value
 * is shown as text, with the reason. Nothing is hidden and nothing is refused —
 * it just does not claim more than it knows.
 */
function YoutubeUrlField({
  videoId,
  initial,
  publishedAt,
  publishedLabel,
  onSaved,
}: {
  videoId: string;
  initial: string;
  publishedAt: string | null;
  publishedLabel: string | null;
  onSaved: (video: VideoState) => void;
}) {
  const inputId = useId();
  const version = useVideoVersion();
  const field = useAutosave({
    initial,
    save: flowSaver(videoId, "youtubeUrl", onSaved, version),
  });

  const published = publishedAt !== null;
  const hasUrl = field.value.trim() !== "";

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={inputId}>Final YouTube URL</FieldLabel>

      <input
        id={inputId}
        name="youtubeUrl"
        type="url"
        inputMode="url"
        data-testid="youtube-url"
        value={field.value}
        placeholder="https://www.youtube.com/watch?v=…"
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_URL_LENGTH}
        onChange={(event) => field.setValue(event.target.value)}
        onBlur={field.commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        className={INPUT_CLASS}
      />

      {hasUrl ? (
        published ? (
          <p data-testid="youtube-live" className="text-xs text-muted">
            <a
              href={field.value}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Watch on YouTube
            </a>
            {publishedLabel ? ` · published ${publishedLabel}` : null}
          </p>
        ) : (
          <p data-testid="youtube-not-live" className="text-xs text-muted">
            Saved, but not live: this video has not reached a Published stage
            yet, so the link is a note to yourself rather than somewhere to go.
          </p>
        )
      ) : null}

      <SaveStatus
        state={field.state}
        testId="youtube-url-status"
        idle={hasUrl ? "" : "Filled in once the video is actually up."}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Free-form notes: the B-roll list, the sponsor read, which lens.
 *
 * PLAN.md says *"rich text/markdown"*, and this is a `<textarea>`. That is the
 * reading, not a shortcut: markdown **is** text, and what the brief asks for is
 * somewhere to put a sponsor read at 11pm. A rich-text editor is a runtime
 * dependency this build does not have a budget for (the ceiling is
 * supabase-js, ssr, zod, next, react), it is a second source of truth for what
 * a note "really" is, and it would store markup that nothing in the app renders
 * — `/now`, the board and the ideas list all treat this column as plain text.
 *
 * Generously sized, because the thing that actually goes in here is a list of
 * shots, and a three-line box makes people write three lines.
 */
function NotesField({
  videoId,
  initial,
  onSaved,
}: {
  videoId: string;
  initial: string;
  onSaved: (video: VideoState) => void;
}) {
  const inputId = useId();
  const version = useVideoVersion();
  const field = useAutosave({
    initial,
    save: flowSaver(videoId, "notes", onSaved, version),
  });

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={inputId}>Notes</FieldLabel>

      <textarea
        id={inputId}
        name="notes"
        rows={12}
        data-testid="notes"
        value={field.value}
        placeholder={"B-roll list, sponsor read, gear notes.\nMarkdown is kept exactly as you type it."}
        maxLength={MAX_NOTES_LENGTH}
        onChange={(event) => field.setValue(event.target.value)}
        onBlur={field.commit}
        // `text-base`, not `text-sm`: iOS Safari zooms the page when a focused
        // field is under 16px, and a sponsor read typed at 11pm on a phone is
        // exactly what this box is for. `INPUT_CLASS` already says 16px; this
        // used to override it back down.
        className={`${INPUT_CLASS} min-h-48 resize-y font-mono leading-relaxed`}
      />

      <SaveStatus
        state={field.state}
        testId="notes-status"
        idle="Plain text. Markdown is stored as written, not rendered."
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Archive                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The banner an archived video wears.
 *
 * Its own element rather than a line in the status area: this is a fact about
 * the whole row — it is why the card is not on the board — and it has to be the
 * first thing read on the page, not a footnote under the last field.
 */
function ArchivedBanner() {
  return (
    <p
      data-testid="archived-banner"
      className="rounded-input border border-attention/60 bg-attention/[0.07] px-3 py-2 text-sm"
    >
      <strong className="font-semibold">Archived.</strong> This video is off the
      board. Nothing has been deleted — its stage, dates and notes are all still
      here, and “Restore” puts the card back where it was.
    </p>
  );
}

/**
 * Archive / restore.
 *
 * Archiving writes `archived_at` and nothing else. The board's queries already
 * end in `.is("archived_at", null)`, so the card leaves the board on the next
 * render and comes back on restore — in the same column, because the stage was
 * never touched. There is no confirmation step: it is one click to undo, and a
 * dialog in front of a reversible action is a dialog people learn to dismiss
 * without reading.
 */
function ArchiveButton({
  videoId,
  archivedAt,
  onChanged,
}: {
  videoId: string;
  archivedAt: string | null;
  onChanged: (video: VideoState) => void;
}) {
  const archived = archivedAt !== null;

  /*
    The same queue every other field on this page uses, with a boolean for a
    patch. A click is the whole decision, so there is no blur to wait for and
    `useAutosave`'s typing machinery would be in the way — but the parts that
    matter are the ones that must not be hand-rolled a third time: the caught
    rejection, the retry payload, and one status element with one politeness.
  */
  const version = useVideoVersion();

  const { state, pending, send } = useSaveQueue<boolean>({
    save: async (next) => {
      const expected = version.peek();
      const result = await updateVideo({
        videoId,
        ...(expected === undefined ? {} : { expectedUpdatedAt: expected }),
        archived: next,
      });
      if (!result.ok) {
        return { ok: false, error: result.error, conflict: result.conflict };
      }
      onChanged(result.video);
      return { ok: true };
    },
  });

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="archive-toggle"
          data-archived={archived ? "true" : "false"}
          disabled={pending}
          onClick={() => send(!archived)}
          className="rounded-button border border-border px-3 py-2 text-sm outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          {pending
            ? archived
              ? "Restoring…"
              : "Archiving…"
            : archived
              ? "Restore to the board"
              : "Archive"}
        </button>

        <p className="text-xs text-muted">
          {archived
            ? "Archived videos keep everything; they are just not on the board."
            : "Takes it off the board without deleting anything."}
        </p>
      </div>

      <SaveStatus state={state} testId="archive-status" onRetry={send} />
    </div>
  );
}
