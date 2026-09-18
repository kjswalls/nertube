"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import {
  MAX_ITEM_LENGTH,
  estMinutesOf,
  evidenceFor,
  isChecked,
  type ChecklistItem,
  type EvidenceFacts,
} from "@/lib/checklist";

import { isPending } from "./use-checklist";

/**
 * The stage's list, open.
 *
 * Three things are deliberate about how a row reads:
 *
 * - **The tick is a real checkbox in a real label.** Its accessible name is the
 *   item's text and nothing else, so "tick the third item" is the same gesture
 *   for a mouse, a keyboard and a screen reader, and the row is not a div with
 *   a click handler pretending.
 * - **The estimate and the evidence are measurements**, so they are in the mono
 *   face with the rest of what this app has counted, and they sit to the right
 *   of the words rather than inside them.
 * - **Nothing here is coloured except a rule being broken.** The next action
 *   gets a 3px accent marker — a shape, the same signal the sidebar uses for
 *   "you are here" — and a title that is over 55 characters gets the one red in
 *   the product. A row that is simply not done yet gets nothing at all.
 */
export function ChecklistList({
  items,
  facts,
  nextId,
  onToggle,
  onDelete,
  onAdd,
}: {
  items: readonly ChecklistItem[];
  /** What the video's own fields measure, for the evidence column. */
  facts: EvidenceFacts;
  /** The first unticked row, which is the one the strip is naming. */
  nextId: string | null;
  onToggle: (id: string, checked: boolean) => void;
  onDelete: (id: string) => void;
  onAdd: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p data-testid="checklist-empty" className="text-[12px] text-muted">
          This stage has no checklist. Add what this one actually needs, or
          reset it from the channel&apos;s template.
        </p>
      ) : (
        <ul data-testid="checklist-items" className="flex flex-col">
          {items.map((item) => (
            <Row
              key={item.id}
              item={item}
              facts={facts}
              isNext={item.id === nextId}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}

      <AddItem onAdd={onAdd} />
    </div>
  );
}

function Row({
  item,
  facts,
  isNext,
  onToggle,
  onDelete,
}: {
  item: ChecklistItem;
  facts: EvidenceFacts;
  isNext: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const checked = isChecked(item);
  const evidence = evidenceFor(item.text, facts);
  // A row the server has never heard of: it has a client-side id, so ticking or
  // deleting it would name nothing. It is on screen, and it is not yet a row.
  const unsaved = isPending(item);

  return (
    <li
      data-testid="checklist-item"
      data-item-id={item.id}
      data-checked={checked ? "true" : "false"}
      data-next={isNext ? "true" : "false"}
      data-unsaved={unsaved ? "true" : "false"}
      className={[
        "flex items-start gap-2 border-l-[3px] py-1.5 pl-2",
        isNext ? "border-l-accent" : "border-l-transparent",
      ].join(" ")}
    >
      <label className="flex min-w-0 flex-1 items-start gap-2 text-[13px] leading-5">
        <input
          type="checkbox"
          checked={checked}
          disabled={unsaved}
          onChange={(event) => onToggle(item.id, event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <span
          className={[
            "min-w-0 flex-1",
            checked ? "text-muted line-through decoration-muted/60" : "",
          ].join(" ")}
        >
          {item.text}
        </span>
      </label>

      <span
        data-testid="checklist-minutes"
        className="shrink-0 pt-0.5 font-mono text-[11px] text-muted"
        title={`About ${estMinutesOf(item)} minutes`}
      >
        {estMinutesOf(item)}m
      </span>

      {evidence ? (
        <span
          data-testid="checklist-evidence"
          data-over-limit={evidence.overLimit ? "true" : "false"}
          title={evidence.detail}
          className={[
            "shrink-0 rounded-button border px-1.5 pt-px font-mono text-[11px]",
            evidence.overLimit
              ? "border-over-limit/40 text-over-limit"
              : "border-border text-muted",
          ].join(" ")}
        >
          {evidence.label}
        </span>
      ) : null}

      <button
        type="button"
        data-testid="checklist-delete"
        disabled={unsaved}
        onClick={() => onDelete(item.id)}
        className="shrink-0 rounded-button border border-transparent px-1 text-[12px] leading-5 text-muted outline-none enabled:hover:border-border enabled:hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span aria-hidden="true">×</span>
        <span className="sr-only">Delete “{item.text}”</span>
      </button>
    </li>
  );
}

/**
 * The one-line box that puts a custom item at the top.
 *
 * It is never disabled while a write is in flight. The queue underneath takes
 * whatever arrives and sends it in order, and the whole point of the feature is
 * that the thing you just thought of goes to the top *now* — a box that greys
 * out for the length of a round trip is a box that loses the thought.
 */
function AddItem({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  // Generated rather than written: a second list on one page (a future `/now`
  // row, a second stage) would otherwise put two elements on one id, and the
  // label would point at whichever one the browser found first.
  const inputId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === "") return;
    onAdd(trimmed);
    setText("");
    input.current?.focus();
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <label className="sr-only" htmlFor={inputId}>
        Add a checklist item
      </label>
      <input
        id={inputId}
        ref={input}
        data-testid="checklist-add-input"
        value={text}
        maxLength={MAX_ITEM_LENGTH}
        onChange={(event) => setText(event.target.value)}
        placeholder="Add an item — it goes to the top"
        className="min-w-0 flex-1 rounded-input border border-border bg-surface px-2 py-1 text-[13px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
      />
      <button
        type="submit"
        data-testid="checklist-add-submit"
        disabled={text.trim() === ""}
        className="shrink-0 rounded-button border border-border px-2 py-1 text-[12px] font-medium outline-none enabled:hover:border-accent/50 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
      >
        Add
      </button>
    </form>
  );
}
