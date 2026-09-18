"use client";

import Link from "next/link";

import type { Idea } from "./types";

/**
 * One idea, as a row in the bank.
 *
 * Presentational on purpose: every decision it could make — is it selected, is
 * a write in flight, may it be promoted — is a prop, so the list above it is
 * the only place that holds state and this file can be read as a picture of the
 * row.
 *
 * ## What the row is for
 *
 * BRIEF.md: *the bank is where an idea waits until it earns promotion*. So the
 * row shows the four things that decide whether it has — the title, the
 * one-line hook, the tags and the two buckets — plus the one thing that argues
 * it never will: how long it has been sitting. Nothing else. There is no
 * checklist ratio and no target date here, because an idea has neither, and no
 * stage chip, because every row on this page is in the same stage.
 *
 * ## No colour
 *
 * A card on the board turns amber when it is stale, because a stalled video is
 * a problem. An old idea is not a problem — the bank is a bank, and an idea
 * that sat for a year before its moment came is the system working. So the age
 * is mono and muted like any other measured number, and the only colour on the
 * row is the accent on the one that is selected, which is an interaction rather
 * than a warning.
 */
export function IdeaRow({
  idea,
  selected,
  busy,
  promoteRefusal,
  onSelect,
  onPromote,
  onArchive,
  onRestore,
  registerRef,
}: {
  idea: Idea;
  selected: boolean;
  /** A write for this row is in flight; every button on it is inert. */
  busy: boolean;
  /**
   * Why Promote cannot run, or null. Not a boolean: a disabled button whose
   * reason is nowhere on the page is the M3 review finding this milestone is
   * also fixing in the sidebar.
   */
  promoteRefusal: string | null;
  onSelect: () => void;
  onPromote: () => void;
  onArchive: () => void;
  onRestore: () => void;
  registerRef: (id: string, element: HTMLLIElement | null) => void;
}) {
  const archived = idea.archivedAt !== null;
  // `capture_video` defaults the title to `''`, and the bank is where an
  // untitled capture is most likely to sit. It still has to be findable.
  const title = idea.title.trim() === "" ? "Untitled" : idea.title;

  return (
    <li
      ref={(element) => registerRef(idea.id, element)}
      data-testid="idea-row"
      data-video-id={idea.id}
      data-selected={selected ? "true" : "false"}
      data-archived={archived ? "true" : "false"}
      onClick={onSelect}
      className={[
        // The card metrics: 12px/13px padding, 8px radius, a 1px border and no
        // shadow — shadows are for overlays.
        "flex flex-col gap-2 rounded-card border bg-surface px-card-x py-card-y transition-colors",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
        archived ? "opacity-60" : "",
        busy ? "animate-pulse" : "",
      ].join(" ")}
      aria-current={selected ? "true" : undefined}
      aria-busy={busy || undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {/* The title is the user's own words, so it is the reading face. */}
          <h3 className="font-display text-[15px] leading-snug font-medium">
            <Link
              href={`/videos/${idea.id}`}
              data-testid="idea-open"
              className="outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              onFocus={onSelect}
            >
              {title}
            </Link>
          </h3>

          {idea.oneLineHook ? (
            <p
              data-testid="idea-hook"
              className="line-clamp-1 font-display text-[13px] leading-snug text-muted"
            >
              {idea.oneLineHook}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {archived ? (
            <button
              type="button"
              data-testid="idea-restore"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onRestore();
              }}
              className="rounded-button border border-border px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                data-testid="idea-promote"
                aria-keyshortcuts="p"
                disabled={busy || promoteRefusal !== null}
                title={
                  promoteRefusal ??
                  "Move it to Packaging, where the title, the thumbnail concept and the hook get decided. (p)"
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onPromote();
                }}
                className="rounded-button border border-accent px-2 py-1 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:border-border disabled:text-muted disabled:hover:bg-transparent"
              >
                Promote
              </button>
              <button
                type="button"
                data-testid="idea-archive"
                disabled={busy}
                title="Archive it: out of the bank and off the board, and restorable from Show archived."
                onClick={(event) => {
                  event.stopPropagation();
                  onArchive();
                }}
                className="rounded-button border border-border px-2 py-1 text-[12px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                Archive
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[11px] leading-4">
        {archived ? (
          <span
            data-testid="idea-archived-chip"
            className="rounded-full bg-attention/15 px-1.5 py-0.5 font-medium text-attention"
          >
            Archived
          </span>
        ) : null}

        {idea.verticalName ? (
          <span
            data-testid="idea-vertical"
            className="rounded-full border border-border px-1.5 py-0.5 text-muted"
          >
            <span className="sr-only">Vertical: </span>
            {idea.verticalName}
          </span>
        ) : null}

        {idea.horizontalName ? (
          <span
            data-testid="idea-horizontal"
            className="rounded-full border border-border px-1.5 py-0.5 text-muted"
          >
            <span className="sr-only">Horizontal: </span>
            {idea.horizontalName}
          </span>
        ) : null}

        {idea.tags.map((tag) => (
          <span
            key={tag}
            data-testid="idea-tag"
            className="rounded-full bg-background px-1.5 py-0.5 text-muted"
          >
            <span className="sr-only">Tag: </span>#{tag}
          </span>
        ))}

        {idea.ageLabel ? (
          <span
            data-testid="idea-age"
            title={
              idea.capturedLabel
                ? `Captured ${idea.capturedLabel}`
                : undefined
            }
            className="ml-auto rounded-full px-1.5 py-0.5 font-mono text-muted"
          >
            {idea.ageLabel} in the bank
          </span>
        ) : null}
      </div>
    </li>
  );
}
