"use client";

import Link from "next/link";
import { useState, type DragEvent } from "react";

import type { BoardCard } from "./types";

/**
 * One card on the board.
 *
 * PLAN.md's card face is: *title, channel chip, target date, concept sketch
 * thumb, `done/total` for the current stage, days in stage (amber when >
 * `stale_days`), "TTH skipped" badge, `waiting_on` chip*. All of it is here
 * except the checklist ratio, which arrives with the checklists in M3 and
 * renders nothing at all until then — a "0/0" on every card would read as
 * "nothing to do".
 *
 * ## Why this is an `<article>` in an `<li>` with real buttons
 *
 * Dragging must not be the only way to move a card. A `draggable` div with a
 * key handler is a keyboard path for someone who already knows the keys and no
 * path at all for a screen reader, so every card carries two real `<button>`s
 * — "move back to X" / "move forward to Y" — which call the same server action
 * the drag does. The `j`/`k`/`[`/`]` shortcuts are a shortcut *for these
 * buttons*, not the only route to the behaviour.
 *
 * The card element itself is `tabIndex={-1}` rather than tabbable: it is a
 * programmatic focus target for `j`/`k` (so the selection is visible and the
 * screen reader follows it) while the natural tab order stays on the things
 * that actually do something — the title link and the two buttons.
 */
export function VideoCard({
  card,
  channelName,
  staleDays,
  selected,
  pending,
  dragging,
  previousStageName,
  nextStageName,
  registerRef,
  onSelect,
  onMoveBack,
  onMoveForward,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  channelName: string;
  staleDays: number;
  selected: boolean;
  /** A move is in flight for this card. */
  pending: boolean;
  dragging: boolean;
  /** Name of the previous enabled core stage, or null when there is none. */
  previousStageName: string | null;
  nextStageName: string | null;
  registerRef: (id: string, element: HTMLElement | null) => void;
  onSelect: () => void;
  onMoveBack: () => void;
  onMoveForward: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
}) {
  const title = card.title.trim() === "" ? "Untitled" : card.title;
  const stale = card.daysInStage > staleDays;

  /*
    Which signed URL failed to load, if any. Compared against the current one
    rather than held as a boolean, so a re-upload (a new URL) clears the failure
    by itself and a card that once failed is not stuck empty forever.
  */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const showSketch =
    card.thumbnailConceptUrl !== null &&
    card.thumbnailConceptUrl !== brokenUrl;

  const daysLabel =
    card.daysInStage === 0
      ? "today"
      : card.daysInStage === 1
        ? "1 day"
        : `${card.daysInStage} days`;

  return (
    <article
      ref={(element) => registerRef(card.id, element)}
      data-testid="board-card"
      data-video-id={card.id}
      data-stale={stale ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onFocus={onSelect}
      onClick={onSelect}
      tabIndex={-1}
      aria-current={selected ? "true" : undefined}
      aria-busy={pending || undefined}
      aria-label={`${title} — ${channelName}`}
      className={[
        "group flex flex-col gap-2 rounded-md border bg-background p-2 text-left outline-none transition",
        selected
          ? "border-foreground ring-2 ring-foreground"
          : "border-border hover:border-foreground/40",
        dragging ? "opacity-40" : "",
        pending ? "animate-pulse" : "",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        {/*
          The concept sketch thumb.

          The wrapper is always the same 56x32 box, whether it holds a picture,
          nothing, or a picture that would not load — so a board of a hundred
          cards has one layout no matter how many sketches exist or how many
          signed URLs have expired. `showSketch` is false in all three failing
          cases and the box quietly stays dashed and empty; there is no broken
          image icon and no alt text shouting about a missing file, because a
          missing sketch is not an error on a kanban board.

          Sized in the markup as well as in CSS (`width`/`height` attributes) so
          the browser reserves the box before the bytes arrive, and `lazy` so a
          long column does not fetch a hundred images to show ten.
        */}
        <div
          data-slot="thumbnail-concept"
          data-has-concept-sketch={card.thumbnailConceptPath ? "true" : "false"}
          data-showing-sketch={showSketch ? "true" : "false"}
          aria-hidden="true"
          title={
            card.thumbnailConceptPath
              ? "Concept sketch (reference) uploaded — not the written thumbnail concept the gate reads"
              : "No concept sketch"
          }
          className={[
            "mt-0.5 h-8 w-14 shrink-0 overflow-hidden rounded border",
            showSketch
              ? "border-border"
              : card.thumbnailConceptPath
                ? "border-dashed border-foreground/40 bg-surface"
                : "border-dashed border-border bg-surface/50",
          ].join(" ")}
        >
          {showSketch ? (
            /*
              A plain <img>: the src is a signed URL on a host that comes from
              an environment variable and carries a token that expires within
              the hour, so next/image's `remotePatterns` cannot describe it and
              its optimiser would cache private bytes past the signature.
              `aria-hidden` on the wrapper is why the alt is empty — the card's
              own label already names the video.
            */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.thumbnailConceptUrl ?? undefined}
              alt=""
              width={56}
              height={32}
              loading="lazy"
              decoding="async"
              draggable={false}
              data-testid="card-sketch"
              onError={() => setBrokenUrl(card.thumbnailConceptUrl)}
              className="h-full w-full object-cover"
            />
          ) : null}
        </div>

        <h3 className="min-w-0 flex-1 text-sm leading-snug font-medium">
          <Link
            href={`/videos/${card.id}`}
            draggable={false}
            className="line-clamp-3 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-foreground/40"
          >
            {title}
          </Link>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[11px] leading-4">
        <span className="rounded-full border border-border px-1.5 py-0.5 text-muted">
          {channelName}
        </span>

        {card.targetPublishLabel ? (
          <span
            data-slot="target-date"
            data-testid="target-date"
            className="rounded-full border border-border px-1.5 py-0.5 text-muted"
          >
            <span className="sr-only">Target publish date: </span>
            {card.targetPublishLabel}
          </span>
        ) : null}

        <span
          data-slot="days-in-stage"
          data-testid="days-in-stage"
          data-stale={stale ? "true" : "false"}
          className={[
            "rounded-full px-1.5 py-0.5 tabular-nums",
            stale
              ? "bg-amber-100 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              : "text-muted",
          ].join(" ")}
          title={
            stale
              ? `In this stage for ${daysLabel} — past the ${staleDays}-day staleness mark`
              : `In this stage for ${daysLabel}`
          }
        >
          {stale ? `Stale · ${daysLabel} in stage` : `${daysLabel} in stage`}
        </span>

        {card.packagingSkipped ? (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            TTH skipped
          </span>
        ) : null}

        {card.waitingOn ? (
          <span className="rounded-full border border-border px-1.5 py-0.5 text-muted">
            <span className="sr-only">Waiting on: </span>
            Waiting: {card.waitingOn}
          </span>
        ) : null}

        {/*
          The checklist ratio (`done/total` for the current stage) belongs here
          and arrives with the checklists in M3. Nothing is rendered for it
          until then: `checklist_items` are snapshot-copied on stage entry, so
          a card would show "0/0" today, which reads as "nothing to do" rather
          than as "not built yet".
        */}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-move="back"
          disabled={previousStageName === null || pending}
          onClick={(event) => {
            event.stopPropagation();
            onMoveBack();
          }}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted outline-none enabled:hover:border-foreground/40 enabled:hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          <span aria-hidden="true">←</span>
          <span className="sr-only">
            {previousStageName === null
              ? `“${title}” cannot move back`
              : `Move “${title}” back to ${previousStageName}`}
          </span>
        </button>

        <button
          type="button"
          data-move="forward"
          disabled={nextStageName === null || pending}
          onClick={(event) => {
            event.stopPropagation();
            onMoveForward();
          }}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted outline-none enabled:hover:border-foreground/40 enabled:hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          <span aria-hidden="true">→</span>
          <span className="sr-only">
            {nextStageName === null
              ? `“${title}” cannot move forward`
              : `Move “${title}” forward to ${nextStageName}`}
          </span>
        </button>

        {pending ? (
          <span className="text-[11px] text-muted">Moving…</span>
        ) : null}
      </div>
    </article>
  );
}
