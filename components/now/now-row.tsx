"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { MetricsPair } from "@/components/post-publish/metrics-pair";
import type { NowIntent } from "@/components/now/intent";
import { formatAge } from "@/components/video-detail/age";
import { formatCtr } from "@/lib/metrics";
import { formatPublishDate, type NowRow as Row } from "@/lib/next-action";

/**
 * One line of `/now`: what the video is, what the one next action is, and the
 * control that finishes it.
 *
 * ## Completable in place
 *
 * PLAN.md's target is *every row done in ≤ 2 interactions without leaving the
 * page*, and the `input` discriminator on the row is what makes that possible
 * without a component per rule: eight rules, eight kinds of control, one
 * switch. Nothing here decides *what* the action is — that is
 * `lib/next-action.ts` — and nothing here writes; it produces a `NowIntent` and
 * the list performs it.
 *
 * ## The row is a list item, not a link
 *
 * The title links to `/videos/[id]` and the control is a control, and neither
 * is wrapped in the other. A row that was itself a link would make every
 * checkbox on this page a navigation hazard, and this is the page whose whole
 * promise is that you do not have to open the card.
 *
 * ## Colour
 *
 * Only what is in trouble is coloured. An Overdue row carries the over-limit
 * hue on its marker; a Waiting row carries attention; a Ready row carries
 * nothing at all, because most of the list is Ready and a list that is entirely
 * coloured says nothing. The section heading and `data-section` carry the same
 * fact for anyone not reading hues.
 */
export function NowRowItem({
  row,
  now,
  selected,
  busy,
  onSelect,
  onIntent,
  registerRef,
}: {
  row: Row;
  /** The page's one clock read, so every age agrees with every other. */
  now: number;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onIntent: (intent: NowIntent) => void;
  /** Lets the list scroll to a row and focus its primary control. */
  registerRef: (videoId: string, element: HTMLLIElement | null) => void;
}) {
  const daysLabel =
    row.daysInStage === 0
      ? "today"
      : row.daysInStage === 1
        ? "1 day"
        : `${row.daysInStage} days`;

  return (
    <li
      ref={(element) => registerRef(row.videoId, element)}
      data-testid="now-row"
      data-video-id={row.videoId}
      data-section={row.section}
      data-input={row.input}
      data-rule={row.rule}
      data-selected={selected ? "true" : "false"}
      aria-current={selected ? "true" : undefined}
      aria-busy={busy || undefined}
      // Focusable by script only, so `j`/`k` can move focus here the way the
      // board and the idea bank do — without the row joining the tab order.
      tabIndex={-1}
      onFocusCapture={onSelect}
      onClick={onSelect}
      className={[
        "relative flex flex-col gap-2 rounded-card border bg-surface py-card-y pr-card-x pl-4 outline-none transition",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
        busy ? "animate-pulse" : "",
      ].join(" ")}
    >
      {/* Signal one: a shape at the edge, present only when something is wrong. */}
      {row.section === "ready" ? null : (
        <span
          aria-hidden="true"
          className={[
            "absolute top-3 bottom-3 left-0 w-[3px] rounded-full",
            row.section === "overdue" ? "bg-over-limit" : "bg-attention",
          ].join(" ")}
        />
      )}

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* The action, in the tool's own voice — this is not the user's text. */}
        <p
          data-testid="now-label"
          className="min-w-0 flex-1 text-[13px] leading-snug font-medium max-md:text-[15px]"
        >
          {row.label}
        </p>

        <span
          data-testid="now-age"
          title={`In ${row.stageName} for ${daysLabel}`}
          className="shrink-0 font-mono text-[11px] text-muted max-md:text-[12px]"
        >
          {daysLabel}
        </span>
      </div>

      {/*
        On a phone the title takes a line of its own and may use two, and the
        chips go under it: at 358px a truncated title beside three chips was a
        dozen characters of the one thing in the row the user wrote, and the
        separator dot was left hanging at the end of a line. The chips grow to
        24px there, which is WCAG 2.5.8's floor for a target that is not the
        row's own control.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-muted max-md:gap-y-1.5 max-md:text-[12px]">
        {/* The video's own title is the user's words, so it is the reading face. */}
        <Link
          href={`/videos/${row.videoId}`}
          data-testid="now-video-link"
          className="min-w-0 truncate font-display text-[13px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent max-md:line-clamp-2 max-md:basis-full max-md:py-0.5 max-md:text-[15px] max-md:leading-snug max-md:whitespace-normal thumb:py-1"
        >
          {row.videoTitle}
        </Link>
        <span aria-hidden="true" className="max-md:hidden">
          ·
        </span>
        <Link
          href={`/c/${row.channelSlug}/board`}
          className="rounded-full border border-border px-1.5 py-0.5 outline-none max-md:px-2 max-md:py-1 thumb:px-2 thumb:py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
        >
          {row.channelName}
        </Link>
        <span data-testid="now-stage" className="rounded-full border border-border px-1.5 py-0.5 max-md:px-2 max-md:py-1">
          {row.stageName}
        </span>
        {row.needsABlock ? (
          /*
            M6: for a video sitting in Filming this is not just a label, it is a
            pointer. `/now`'s quick filter hides these rows because ten spare
            minutes will not shoot anything, and the calendar is where the block
            actually gets booked — so the two views agree about the set that is
            waiting, and each says where the other is. Editing needs a block too
            but not a *camera day*, so only the filming rows link: a chip
            offering to schedule an edit onto a shoot would be a promise the
            product does not keep.
          */
          row.stageKind === "filming" ? (
            <Link
              href="/calendar"
              data-testid="needs-a-block"
              data-stage-kind={row.stageKind}
              title="Filming needs a real block of time, not ten spare minutes. Book a batch day on the calendar."
              className="rounded-full border border-border px-1.5 py-0.5 outline-none max-md:px-2 max-md:py-1 thumb:px-2 thumb:py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
            >
              needs a block
            </Link>
          ) : (
            <span
              data-testid="needs-a-block"
              data-stage-kind={row.stageKind}
              title="Filming and editing need a real block of time, not ten spare minutes."
              className="rounded-full border border-border px-1.5 py-0.5 max-md:px-2 max-md:py-1"
            >
              needs a block
            </span>
          )
        ) : row.payload.input === "tick" && row.payload.estMinutes !== null ? (
          /*
            The mono face is for *measured* values, and only a checklist row has
            one: `checklist_items.est_minutes`, seeded per row. Every other rule
            is built with `DEFAULT_EST_MINUTES` so the quick filter has a number
            to compare, and printing that here — "10 min" beside "Goes live
            1 Dec" — was the tool asserting a measurement it never made, in the
            one face that is supposed to guarantee it did. The same holds for a
            checklist row with no estimate of its own (a custom item): the
            filter still reads it as ten, but nothing is printed (M9 review).
          */
          <span data-testid="now-est" className="font-mono">
            {row.payload.estMinutes} min
          </span>
        ) : null}
      </div>

      <RowControl row={row} now={now} busy={busy} onIntent={onIntent} />
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The eight controls                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A row's buttons, sized for a thumb.
 *
 * `/now` is the view a phone opens (BRIEF.md principle 3: *"I have 10 minutes —
 * what can I move right now?"*), so every control a row offers is 44px tall
 * wherever a finger is the likely pointer (`thumb:` in `app/globals.css`), and
 * the desktop keeps the 26px density a mouse is happy with.
 */
const THUMB = "thumb:min-h-11 thumb:px-3 thumb:text-sm";

function RowControl({
  row,
  now,
  busy,
  onIntent,
}: {
  row: Row;
  now: number;
  busy: boolean;
  onIntent: (intent: NowIntent) => void;
}) {
  const payload = row.payload;

  switch (payload.input) {
    case "tick":
      return (
        /*
          A `<label>`, so the sentence beside the box is part of the target: on
          a phone the 16px box alone was the whole of it, and it sat under a
          label wrapped five words to a line (M3's review, finding 32). The
          checkbox keeps its own `aria-label`, which wins over the wrapping
          label for its name, so a screen reader still hears which item it
          ticks. `self-start`, so the target is the box and the sentence and not
          the empty width of the row beside them.
        */
        <label
          data-testid="now-tick-target"
          className="flex cursor-pointer items-center gap-2 self-start rounded-button thumb:min-h-11 thumb:pr-2"
        >
          <input
            type="checkbox"
            data-testid="now-tick"
            data-now-primary
            checked={false}
            disabled={busy}
            onChange={() => onIntent({ kind: "tick" })}
            aria-label={`Done: ${payload.itemText}`}
            className="size-4 shrink-0 accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-accent thumb:size-5"
          />
          <span className="text-[12px] text-muted max-md:text-[13px]">
            Tick it and the next item takes its place.
          </span>
        </label>
      );

    case "text":
      return (
        <SingleLine
          busy={busy}
          initial={payload.value}
          placeholder={
            payload.field === "title"
              ? "The working title — it can change later"
              : "What the thumbnail shows. In words."
          }
          label={payload.field === "title" ? "Working title" : "Thumbnail concept"}
          // A concept is a sentence or two: it wraps, so it can be read back
          // before Save (M10 review; `thumbnail-concept.tsx` has the reason).
          multiline={payload.field === "thumbnail_concept"}
          onSubmit={(value) => onIntent({ kind: "text", value })}
        />
      );

    case "choice":
      return payload.hooks.length === 0 ? (
        <p className="text-[12px] text-muted">
          No hooks are written yet, so there is nothing to choose between.{" "}
          <Link
            href={`/videos/${row.videoId}#packaging-hooks`}
            data-now-primary
            className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Write one on the video
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose a hook">
          {payload.hooks.map((hook, index) => (
            <button
              key={hook.id}
              type="button"
              data-testid="now-hook"
              {...(index === 0 ? { "data-now-primary": true } : {})}
              disabled={busy}
              aria-pressed={hook.chosen}
              onClick={() => onIntent({ kind: "choose-hook", hookId: hook.id })}
              className={[
                "max-w-full truncate rounded-button border px-2 py-1 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent max-md:whitespace-normal",
                THUMB,
                hook.chosen
                  ? "border-accent text-foreground"
                  : "border-border text-muted hover:border-accent hover:text-foreground",
              ].join(" ")}
            >
              {hook.text}
            </button>
          ))}
        </div>
      );

    case "metrics_pair":
      return (
        <MetricsPair
          /*
            The same component the video page's Publish section renders — one
            component for the pair, in one place, per BRIEF.md. The note about
            new viewers is left off here: a row is a line, not a page, and the
            action leaves that column alone when the key is absent.
          */
          values={{
            impressions: payload.impressions,
            ctr: payload.ctr,
            views: null,
            newViewersNote: null,
          }}
          density="row"
          busy={busy}
          onSubmit={({ impressions, ctr, views }) =>
            onIntent({ kind: "metrics", impressions, ctr, views })
          }
          primaryRef={(element) => {
            // The `x` key's target for this row; `data-now-primary` is set on
            // the element itself so the list's one query finds it.
            element?.setAttribute("data-now-primary", "true");
          }}
        />
      );

    case "url":
      return (
        <div className="flex flex-col gap-1">
          <SingleLine
            busy={busy}
            initial={payload.value}
            type="url"
            label="YouTube URL"
            placeholder="https://www.youtube.com/watch?v=…"
            submitLabel="Confirm live"
            onSubmit={(value) => onIntent({ kind: "confirm-live", url: value })}
          />
          <p className="text-[11px] text-muted">
            {payload.due
              ? `Records the URL and moves it into ${payload.publishedStageName}, dated ${
                  payload.targetPublishDate
                    ? formatPublishDate(payload.targetPublishDate)
                    : "today"
                }.`
              : "Not due yet — but if it went live early, the URL is all this needs."}
          </p>
        </div>
      );

    case "clear_waiting":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="now-unblocked"
            data-now-primary
            disabled={busy}
            onClick={() => onIntent({ kind: "unblocked" })}
            className={`rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent ${THUMB}`}
          >
            Unblocked
          </button>
          <button
            type="button"
            data-testid="now-still-waiting"
            disabled={busy}
            onClick={() => onIntent({ kind: "still-waiting" })}
            title="Leaves the block exactly as it is, and takes the row off this list until the page is reloaded."
            className={`rounded-button px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent ${THUMB}`}
          >
            Still waiting
          </button>
          {formatAge(payload.waitingSince, now) ? (
            <span data-testid="waiting-age" className="font-mono text-[11px] text-muted">
              {formatAge(payload.waitingSince, now)}
            </span>
          ) : null}
        </div>
      );

    case "swap":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="now-keep-thumbnail"
            data-now-primary
            disabled={busy}
            onClick={() => onIntent({ kind: "keep-thumbnail" })}
            className={`rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent ${THUMB}`}
          >
            Keep it
          </button>
          {/*
            The other answer. Swapping needs a role that has an asset, a reason
            and an append-only log row, so it happens where the assets are: the
            video's Thumbnails section, which M4 built. This is a link rather
            than a dialog on purpose — the decision the prompt is asking about
            is *which of the three wins in a feed*, and that is a question you
            answer by looking at them.
          */}
          <Link
            href={`/videos/${row.videoId}?section=thumbnails`}
            data-testid="now-swap-open"
            className={`rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent ${THUMB}`}
          >
            Swap thumbnail…
          </Link>
          {/*
            The bar, and what kind of bar it is.

            The mono face is reserved for measured values, and a derived median
            printed bare in it reads as a fact about the channel. The video
            page's prompt has always distinguished "the 5% this channel
            expects" from "the 5.2% median of its last three logged videos";
            this is the same distinction in the space a row has. The
            qualification is outside the mono span because it is prose, not a
            measurement.
          */}
          <span className="text-[11px] text-muted">
            expected{" "}
            <span className="font-mono">{formatCtr(payload.expectation)}%</span>
            {payload.expectationSource === "median"
              ? ` (median of ${payload.expectationSample})`
              : ""}
          </span>
        </div>
      );

    case "move":
      return (
        <button
          type="button"
          data-testid="now-move"
          data-now-primary
          disabled={busy}
          onClick={() => onIntent({ kind: "move" })}
          className={`self-start rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent ${THUMB}`}
        >
          Move to {payload.toStageName}
        </button>
      );
  }
}

/**
 * A single-line field that saves on Enter, with a button for the mouse.
 *
 * Not `useAutosave`: that hook saves on *blur*, which is right for a form a
 * person is working through and wrong for a list they are working *down*.
 * Tabbing off a row here would commit a half-typed title.
 */
function SingleLine({
  busy,
  initial,
  label,
  placeholder,
  submitLabel = "Save",
  type = "text",
  multiline = false,
  onSubmit,
}: {
  busy: boolean;
  initial: string;
  label: string;
  placeholder?: string;
  submitLabel?: string;
  type?: "text" | "url";
  /**
   * A one-row textarea that grows with its text instead of scrolling
   * sideways inside a one-line box. Still one line of meaning: Enter saves,
   * and a pasted line break becomes a space. Below `md` it takes the row and
   * Save goes under it.
   */
  multiline?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const lastInitial = useRef(initial);

  // A re-rank that leaves this row in place with a new stored value (another
  // tab, a reload) has to win over what is in the box — but only when it
  // actually changed, so typing is never interrupted.
  useEffect(() => {
    if (lastInitial.current !== initial) {
      lastInitial.current = initial;
      setValue(initial);
    }
  }, [initial]);

  const empty = value.trim() === "";

  const fieldClass =
    "min-w-0 flex-1 basis-40 rounded-input border border-border bg-background px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:min-h-11 thumb:text-base";
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter") {
      // Never a line break, in either field.
      event.preventDefault();
      if (!empty) onSubmit(value);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {multiline ? (
        <textarea
          rows={1}
          data-testid="now-text"
          data-now-primary
          aria-label={label}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value.replace(/[\r\n]+/g, " "))}
          onKeyDown={onKeyDown}
          className={`${fieldClass} resize-none leading-snug field-sizing-content max-md:basis-full`}
        />
      ) : (
        <input
          type={type}
          data-testid="now-text"
          data-now-primary
          aria-label={label}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          className={fieldClass}
        />
      )}
      <button
        type="button"
        data-testid="now-text-save"
        disabled={busy || empty}
        onClick={() => onSubmit(value)}
        className={`shrink-0 rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${THUMB}`}
      >
        {submitLabel}
      </button>
    </div>
  );
}
