"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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
      onFocusCapture={onSelect}
      onClick={onSelect}
      className={[
        "relative flex flex-col gap-2 rounded-card border bg-surface py-card-y pr-card-x pl-4 transition",
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
          className="min-w-0 flex-1 text-[13px] leading-snug font-medium"
        >
          {row.label}
        </p>

        <span
          data-testid="now-age"
          title={`In ${row.stageName} for ${daysLabel}`}
          className="shrink-0 font-mono text-[11px] text-muted"
        >
          {daysLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-muted">
        {/* The video's own title is the user's words, so it is the reading face. */}
        <Link
          href={`/videos/${row.videoId}`}
          data-testid="now-video-link"
          className="min-w-0 truncate font-display text-[13px] text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        >
          {row.videoTitle}
        </Link>
        <span aria-hidden="true">·</span>
        <Link
          href={`/c/${row.channelSlug}/board`}
          className="rounded-full border border-border px-1.5 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
        >
          {row.channelName}
        </Link>
        <span data-testid="now-stage" className="rounded-full border border-border px-1.5 py-0.5">
          {row.stageName}
        </span>
        {row.needsABlock ? (
          <span
            data-testid="needs-a-block"
            title="Filming and editing need a real block of time, not ten spare minutes."
            className="rounded-full border border-border px-1.5 py-0.5"
          >
            needs a block
          </span>
        ) : row.payload.input === "tick" ? (
          /*
            The mono face is for *measured* values, and only a checklist row has
            one: `checklist_items.est_minutes`, seeded per row. Every other rule
            is built with `DEFAULT_EST_MINUTES` so the quick filter has a number
            to compare, and printing that here — "10 min" beside "Goes live
            1 Dec" — was the tool asserting a measurement it never made, in the
            one face that is supposed to guarantee it did.
          */
          <span data-testid="now-est" className="font-mono">
            {row.estMinutes} min
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
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="now-tick"
            data-now-primary
            checked={false}
            disabled={busy}
            onChange={() => onIntent({ kind: "tick" })}
            aria-label={`Done: ${payload.itemText}`}
            className="size-4 accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span className="text-[12px] text-muted">
            Tick it and the next item takes its place.
          </span>
        </div>
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
                "max-w-full truncate rounded-button border px-2 py-1 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
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
            className="rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
          >
            Unblocked
          </button>
          <button
            type="button"
            data-testid="now-still-waiting"
            disabled={busy}
            onClick={() => onIntent({ kind: "still-waiting" })}
            title="Leaves the block exactly as it is, and takes the row off this list until the page is reloaded."
            className="rounded-button px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
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
            className="rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
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
            className="rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
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
          className="self-start rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
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
  onSubmit,
}: {
  busy: boolean;
  initial: string;
  label: string;
  placeholder?: string;
  submitLabel?: string;
  type?: "text" | "url";
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

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        type={type}
        data-testid="now-text"
        data-now-primary
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !empty) {
            event.preventDefault();
            onSubmit(value);
          }
        }}
        className="min-w-0 flex-1 rounded-input border border-border bg-background px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <button
        type="button"
        data-testid="now-text-save"
        disabled={busy || empty}
        onClick={() => onSubmit(value)}
        className="shrink-0 rounded-button border border-border px-2 py-1 text-[12px] outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </div>
  );
}
