"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";

import { SaveStatus } from "@/components/autosave";
import { MAX_ITEM_LENGTH } from "@/lib/checklist";
import {
  DEFAULT_TEMPLATE_MINUTES,
  EstMinutesSchema,
  MAX_EST_MINUTES,
  formatMinutes,
  quickCount,
  stageMinutes,
  type TemplateItem,
} from "@/lib/checklist-templates";
import type { StageKind } from "@/lib/defaults";
import { NEEDS_A_BLOCK } from "@/lib/next-action";

import { TemplateRow } from "./template-row";
import { useTemplateEditor } from "./use-template-editor";

/** What the page knows about a stage, handed to its editor. */
export interface TemplateStage {
  readonly id: string;
  readonly name: string;
  readonly kind: StageKind | null;
  readonly isEnabled: boolean;
}

/**
 * One stage's template, with the cost of the stage beside it.
 *
 * ## Two numbers, and what they change
 *
 * The **total** is the sum of the estimates — the honest answer to "how long
 * does this stage take me" — and it moves as the estimates are edited, so a
 * change to a row is visibly a change to the stage. The **quick count** is how
 * many rows `/now` would list under "10 minutes or less": that filter reads
 * `est_minutes` off the video's copy of these rows, so an estimate typed here
 * is the number the filter compares for every video that enters the stage
 * from now on. Filming and Editing are the exception and say so — `/now` tags
 * their rows "needs a block" whatever the estimate claims (BRIEF.md principle
 * 4), so the count there is always none and the sentence explains why rather
 * than printing a zero.
 *
 * ## The boundary, said where the person is looking
 *
 * Every write here is future videos only. That is the product's decision
 * (PLAN.md open question 2), and the reason a person can edit a template on a
 * Tuesday without un-ticking Monday's work — but it is also the one thing
 * about this screen that is not obvious from looking at it, so the stage says
 * how many videos are in it *now* and keeping their lists, and a removal is
 * followed by a sentence saying exactly which videos it did not touch.
 */
export function StageTemplateEditor({
  stage,
  initial,
  occupied,
}: {
  stage: TemplateStage;
  initial: readonly TemplateItem[];
  /** Non-archived videos sitting in this stage right now. */
  occupied: number;
}) {
  const editor = useTemplateEditor({ stageId: stage.id, initial });
  const headingId = useId();

  const total = stageMinutes(editor.items);
  const quick = quickCount(editor.items, stage.kind);
  const needsBlock = stage.kind !== null && NEEDS_A_BLOCK.includes(stage.kind);

  return (
    <section
      data-testid="template-stage"
      data-stage-id={stage.id}
      data-stage-kind={stage.kind ?? ""}
      data-enabled={stage.isEnabled ? "true" : "false"}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-border bg-surface px-card-x py-card-y"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id={headingId}
          className="font-display text-[17px] leading-tight font-semibold tracking-tight"
        >
          {stage.name}
        </h2>

        {editor.items.length > 0 ? (
          <p
            data-testid="template-total"
            data-minutes={total}
            data-quick={quick}
            className="font-mono text-[12px] text-muted"
          >
            {editor.items.length} {editor.items.length === 1 ? "item" : "items"}
            {" · "}
            about {formatMinutes(total)}
            {" · "}
            {needsBlock
              ? "none fit ten minutes"
              : `${quick} of ${editor.items.length} fit ten minutes`}
          </p>
        ) : null}

        {!stage.isEnabled ? (
          <span
            data-testid="template-stage-off"
            className="rounded-button border border-border px-1.5 py-0.5 text-[11px] text-muted"
          >
            switched off
          </span>
        ) : null}
      </div>

      {/*
        What these rows are for, in one line. The occupancy is the part that
        is not obvious: a person editing Packaging while three videos sit in it
        needs to know those three are untouched, before they look.
      */}
      <p data-testid="template-occupied" data-count={occupied} className="text-[12px] leading-5 text-muted">
        {!stage.isEnabled
          ? `${stage.name} is switched off, so nothing can enter it and this list is not being copied. It stays here for when the lane comes back.`
          : occupied === 0
            ? `Nothing is in ${stage.name} right now. The next video to enter it gets this list.`
            : occupied === 1
              ? `One video is in ${stage.name} now and keeps the list it was given. The next one to enter gets this list.`
              : `${occupied} videos are in ${stage.name} now and keep the lists they were given. The next one to enter gets this list.`}
        {needsBlock ? (
          <>
            {" "}
            <Link href="/now" className="underline decoration-border underline-offset-2 hover:decoration-current">
              /now
            </Link>{" "}
            never lists {stage.name} items under &ldquo;10 minutes or less&rdquo;
            &mdash; {stage.name.toLowerCase()} needs a block, whatever an item
            claims.
          </>
        ) : null}
      </p>

      {editor.items.length === 0 ? (
        <p data-testid="template-empty" className="text-[13px] text-muted">
          No template. Videos entering {stage.name} get no checklist until one
          is written here.
        </p>
      ) : (
        <ol data-testid="template-rows" className="flex flex-col">
          {editor.items.map((item, index) => (
            <TemplateRow
              key={item.id}
              item={item}
              index={index}
              count={editor.items.length}
              stageKind={stage.kind}
              busy={editor.pending}
              onEdit={editor.edit}
              onRemove={editor.remove}
              onMove={editor.move}
            />
          ))}
        </ol>
      )}

      <AddTemplateItem onAdd={editor.add} />

      <SaveStatus
        state={editor.state}
        testId="template-save-status"
        idle={
          editor.lastRemoved !== null
            ? ""
            : occupied === 0
              ? `Saved on blur. Changes reach the next video to enter ${stage.name}.`
              : occupied === 1
                ? `Saved on blur. Changes reach the next video to enter ${stage.name}; the one already there keeps its list.`
                : `Saved on blur. Changes reach the next video to enter ${stage.name}; the ${occupied} already there keep theirs.`
        }
        onRetry={editor.retry}
      />

      {editor.lastRemoved !== null && editor.state.kind !== "error" ? (
        <p
          role="status"
          data-testid="template-removed-note"
          className="text-[12px] leading-5 text-muted"
        >
          Removed &ldquo;{editor.lastRemoved}&rdquo; from the template.{" "}
          {occupied === 0
            ? `Nothing is in ${stage.name} now; the next video to enter it will not get this item.`
            : occupied === 1
              ? `The video already in ${stage.name} keeps it; the next one to enter will not get it.`
              : `The ${occupied} videos already in ${stage.name} keep it; the next one to enter will not get it.`}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The add form. Two boxes, because a template row is not a template row
 * without an estimate: `est_minutes` is `not null` on the table, and the
 * ten-minute filter needs a number to compare. The minutes box starts at the
 * same ten a custom item on a video reads as when it has none.
 */
function AddTemplateItem({
  onAdd,
}: {
  onAdd: (text: string, estMinutes: number) => void;
}) {
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(String(DEFAULT_TEMPLATE_MINUTES));
  const [error, setError] = useState<string | null>(null);
  const textInput = useRef<HTMLInputElement | null>(null);
  const textId = useId();
  const minutesId = useId();

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === "") return;
    const raw = minutes.trim();
    const parsed = EstMinutesSchema.safeParse(raw === "" ? Number.NaN : Number(raw));
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError(null);
    onAdd(trimmed, parsed.data);
    setText("");
    textInput.current?.focus();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={textId} className="sr-only">
          New item
        </label>
        <input
          id={textId}
          ref={textInput}
          data-testid="template-add-text"
          type="text"
          value={text}
          maxLength={MAX_ITEM_LENGTH}
          onChange={(event) => setText(event.target.value)}
          placeholder="Add an item — it goes at the end"
          className="min-w-0 flex-1 rounded-input border border-border bg-surface px-2 py-1 font-display text-[14px] leading-5 outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
        />
        <label htmlFor={minutesId} className="sr-only">
          Minutes for the new item
        </label>
        <input
          id={minutesId}
          data-testid="template-add-minutes"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_EST_MINUTES}
          step={1}
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          aria-invalid={error ? true : undefined}
          className="w-16 rounded-input border border-border bg-surface px-2 py-1 text-right font-mono text-[12px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <span aria-hidden="true" className="font-mono text-[11px] text-muted">
          min
        </span>
        <button
          type="submit"
          data-testid="template-add-submit"
          disabled={text.trim() === ""}
          className="shrink-0 rounded-button border border-border px-2 py-1 text-[12px] font-medium outline-none enabled:hover:border-accent/50 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
        >
          Add
        </button>
      </div>
      {error ? (
        <p role="alert" data-testid="template-add-error" className="text-[12px] text-attention">
          {error}
        </p>
      ) : null}
    </form>
  );
}
