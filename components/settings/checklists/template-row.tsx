"use client";

import { useId, useState } from "react";

import { MAX_ITEM_LENGTH } from "@/lib/checklist";
import {
  EstMinutesSchema,
  MAX_EST_MINUTES,
  fitsTenMinutes,
  type TemplateItem,
} from "@/lib/checklist-templates";
import type { StageKind } from "@/lib/defaults";

import { isUnsaved } from "./use-template-editor";

/**
 * One row of a template: its words, its estimate, and where it goes.
 *
 * The text and the minutes are both edited in place and saved on blur (or
 * Enter), the way every field on `/videos/[id]` is — a template is prose the
 * person wrote, and prose is not saved per keystroke. Each input keeps its own
 * draft so a refused value (an estimate of zero, say) can be put back to the
 * row's value with the reason printed beside it, without the list losing a row
 * it never changed.
 *
 * The arrows are buttons rather than a drag handle: there is no drag-and-drop
 * library in this app, a template is at most nine rows, and an arrow is the
 * same gesture for a keyboard as for a mouse. The first row's "up" and the
 * last row's "down" are disabled rather than hidden, so the row's controls are
 * always in the same place.
 */
export function TemplateRow({
  item,
  index,
  count,
  stageKind,
  busy,
  onEdit,
  onRemove,
  onMove,
}: {
  item: TemplateItem;
  /** 0-based, in display order. */
  index: number;
  count: number;
  stageKind: StageKind | null;
  /** A write is in flight; the arrows wait, the text does not. */
  busy: boolean;
  onEdit: (id: string, patch: { text?: string; estMinutes?: number }) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
}) {
  const unsaved = isUnsaved(item);
  const quick = fitsTenMinutes(item.estMinutes, stageKind);
  const textId = useId();
  const minutesId = useId();

  /*
    Drafts, tagged with the value they were taken from. A server-confirmed
    change to the row (a Retry landing, another tab) replaces the draft; a
    draft that differs only because the person is mid-edit is left alone.
  */
  const [textDraft, setTextDraft] = useState(item.text);
  const [textBase, setTextBase] = useState(item.text);
  if (item.text !== textBase) {
    setTextBase(item.text);
    setTextDraft(item.text);
  }

  const [minutesDraft, setMinutesDraft] = useState(String(item.estMinutes));
  const [minutesBase, setMinutesBase] = useState(item.estMinutes);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  if (item.estMinutes !== minutesBase) {
    setMinutesBase(item.estMinutes);
    setMinutesDraft(String(item.estMinutes));
    setMinutesError(null);
  }

  function commitText(): void {
    const next = textDraft.trim();
    if (next === "") {
      // An emptied row is not an edit — it is a removal, and that is a button.
      setTextDraft(item.text);
      return;
    }
    if (next !== textDraft) setTextDraft(next);
    if (next === item.text) return;
    onEdit(item.id, { text: next });
  }

  function commitMinutes(): void {
    const raw = minutesDraft.trim();
    const parsed = EstMinutesSchema.safeParse(raw === "" ? Number.NaN : Number(raw));
    if (!parsed.success) {
      setMinutesError(parsed.error.issues[0].message);
      setMinutesDraft(String(item.estMinutes));
      return;
    }
    setMinutesError(null);
    if (parsed.data === item.estMinutes) return;
    onEdit(item.id, { estMinutes: parsed.data });
  }

  return (
    <li
      data-testid="template-row"
      data-template-id={item.id}
      data-position={index + 1}
      data-minutes={item.estMinutes}
      data-quick={quick ? "true" : "false"}
      data-unsaved={unsaved ? "true" : "false"}
      className="flex flex-col gap-1 border-t border-border py-2 first:border-t-0"
    >
      <div className="flex items-start gap-2">
        {/* The position, as a measured thing: where in the procedure this is. */}
        <span
          aria-hidden="true"
          className="w-5 shrink-0 pt-1.5 text-right font-mono text-[11px] text-muted"
        >
          {index + 1}
        </span>

        <label htmlFor={textId} className="sr-only">
          Text of item {index + 1}
        </label>
        <input
          id={textId}
          data-testid="template-text"
          type="text"
          value={textDraft}
          maxLength={MAX_ITEM_LENGTH}
          disabled={unsaved}
          onChange={(event) => setTextDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setTextDraft(item.text);
              event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 rounded-input border border-border bg-surface px-2 py-1 font-display text-[14px] leading-5 outline-none disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-accent"
        />

        <div className="flex shrink-0 items-center gap-1">
          <label htmlFor={minutesId} className="sr-only">
            Minutes for item {index + 1}
          </label>
          <input
            id={minutesId}
            data-testid="template-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_EST_MINUTES}
            step={1}
            value={minutesDraft}
            disabled={unsaved}
            aria-invalid={minutesError ? true : undefined}
            onChange={(event) => setMinutesDraft(event.target.value)}
            onBlur={commitMinutes}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="w-16 rounded-input border border-border bg-surface px-2 py-1 text-right font-mono text-[12px] leading-5 outline-none disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span aria-hidden="true" className="font-mono text-[11px] text-muted">
            min
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid="template-up"
            disabled={unsaved || busy || index === 0}
            onClick={() => onMove(item.id, "up")}
            className="rounded-button border border-transparent px-1.5 py-1 text-[12px] leading-4 text-muted outline-none enabled:hover:border-border enabled:hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden="true">↑</span>
            <span className="sr-only">Move item {index + 1} up</span>
          </button>
          <button
            type="button"
            data-testid="template-down"
            disabled={unsaved || busy || index === count - 1}
            onClick={() => onMove(item.id, "down")}
            className="rounded-button border border-transparent px-1.5 py-1 text-[12px] leading-4 text-muted outline-none enabled:hover:border-border enabled:hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden="true">↓</span>
            <span className="sr-only">Move item {index + 1} down</span>
          </button>
          <button
            type="button"
            data-testid="template-remove"
            disabled={unsaved}
            onClick={() => onRemove(item.id)}
            title="Remove from the template. Videos already in this stage keep it."
            className="rounded-button border border-transparent px-1.5 py-1 text-[12px] leading-4 text-muted outline-none enabled:hover:border-border enabled:hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Remove item {index + 1}</span>
          </button>
        </div>
      </div>

      {minutesError ? (
        <p
          role="alert"
          data-testid="template-minutes-error"
          className="pl-7 text-[12px] text-attention"
        >
          {minutesError}
        </p>
      ) : null}
    </li>
  );
}
