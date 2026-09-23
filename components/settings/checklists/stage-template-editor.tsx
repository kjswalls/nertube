"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { SaveStatus } from "@/components/autosave";
import { useMoveFocus } from "@/components/settings/move-button";
import { Refusal } from "@/components/settings/refusal";
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
import { cleanLabel } from "@/lib/text";

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
 *
 * "Future videos" means a video entering the stage **for the first time**.
 * `move_video` copies a template only when the stage is not yet in the
 * video's `checklist_seeded_stages` (0005), so a video that leaves and comes
 * back keeps the list it was first given, ticks included, and never sees the
 * edit unless "Reset from template" on its page re-copies it. The copy below
 * says so, because M7's review read the earlier wording as "every entry
 * copies" and proved it did not.
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

  // Focus follows a moved row, as it does in the other two editors: the
  // arrows are disabled while the write is on the wire, and a disabled button
  // drops focus on <body>.
  const focus = useMoveFocus({
    deps: [editor.items],
    inFlight: editor.pending,
    nameField: (itemId) => `[data-template-id="${itemId}"] [data-testid="template-text"]`,
  });
  const addTextId = useId();
  // An attribute selector, not `#id`: `useId` ids need escaping as a hash
  // selector, and `CSS.escape` does not exist where this also renders (Node).
  const addSelector = `[id="${addTextId}"]`;

  /*
    After a Retry lands, the button that was pressed is gone with the error
    it belonged to, so focus would fall on <body>. It goes to the text of the
    first row the retried operations touched, or to the add box. Asked for
    when Retry is pressed and consumed when the queue settles — on failure
    the Retry button is still there with focus on it, and the request is
    dropped rather than moved away from it.
  */
  const retryFocus = useRef<string | null>(null);
  useEffect(() => {
    if (editor.state.kind === "saving" || retryFocus.current === null) return;
    const wanted = retryFocus.current;
    retryFocus.current = null;
    if (editor.state.kind === "saved") {
      document.querySelector<HTMLElement>(wanted)?.focus();
    }
  }, [editor.state]);

  function retry(): void {
    const ops = editor.state.kind === "error" ? editor.state.payload : [];
    const first = ops.find((op) => op.kind !== "add");
    retryFocus.current =
      first && "id" in first
        ? `[data-template-id="${first.id}"] [data-testid="template-text"]`
        : addSelector;
    editor.retry();
  }

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
            ? `Nothing is in ${stage.name} right now. The next video to enter it for the first time gets this list; one that comes back keeps the list it was first given.`
            : occupied === 1
              ? `One video is in ${stage.name} now and keeps the list it was given. The next video to enter for the first time gets this list; one that comes back keeps its own, unless its page resets it from the template.`
              : `${occupied} videos are in ${stage.name} now and keep the lists they were given. The next video to enter for the first time gets this list; one that comes back keeps its own, unless its page resets it from the template.`}
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
              onRemove={(id) => {
                // The row goes with the button that removed it: focus moves
                // to the next row's text, or to the add box when it was last.
                const next = editor.items[index + 1] ?? editor.items[index - 1];
                focus.requestField(
                  next
                    ? `[data-template-id="${next.id}"] [data-testid="template-text"]`
                    : addSelector,
                );
                editor.remove(id);
              }}
              onMove={(id, direction) => {
                focus.requestFocus(id, direction);
                editor.move(id, direction);
              }}
              moveButtonRef={(direction) => focus.buttonRef(item.id, direction)}
            />
          ))}
        </ol>
      )}

      <AddTemplateItem textId={addTextId} stageName={stage.name} onAdd={editor.add} />

      <SaveStatus
        state={editor.state}
        testId="template-save-status"
        idle={
          editor.lastRemoved !== null
            ? ""
            : occupied === 0
              ? `Saved on blur. Changes reach the next video to enter ${stage.name} for the first time.`
              : occupied === 1
                ? `Saved on blur. Changes reach the next video to enter ${stage.name} for the first time; the one already there keeps its list.`
                : `Saved on blur. Changes reach the next video to enter ${stage.name} for the first time; the ${occupied} already there keep theirs.`
        }
        // A Retry with nothing to re-send is not a Retry: a refused operation
        // is final and is not in the payload.
        onRetry={editor.state.kind === "error" && editor.state.payload.length > 0 ? retry : undefined}
      />

      {editor.lastRemoved !== null && editor.state.kind !== "error" ? (
        <p
          role="status"
          data-testid="template-removed-note"
          className="text-[12px] leading-5 text-muted"
        >
          Removed &ldquo;{editor.lastRemoved}&rdquo; from the template.{" "}
          {occupied === 0
            ? `Nothing is in ${stage.name} now; the next video to enter it for the first time will not get this item.`
            : occupied === 1
              ? `The video already in ${stage.name} keeps it; the next one to enter for the first time will not get it.`
              : `The ${occupied} videos already in ${stage.name} keep it; the next one to enter for the first time will not get it.`}
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
  textId,
  stageName,
  onAdd,
}: {
  /** The text box's id, so the editor can send focus here after a removal. */
  textId: string;
  /** In the controls' names: nine add forms on one page are otherwise nine "Add"s. */
  stageName: string;
  onAdd: (text: string, estMinutes: number) => void;
}) {
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(String(DEFAULT_TEMPLATE_MINUTES));
  const [error, setError] = useState<string | null>(null);
  const textInput = useRef<HTMLInputElement | null>(null);
  const minutesId = useId();
  const errorId = useId();

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = cleanLabel(text);
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
    <form
      onSubmit={submit}
      // The browser's own constraint validation would stop a `0` at the
      // minutes box's `min` with a tooltip and no submit; the refusal is this
      // form's, in a sentence, so the native one is off — as it is on the
      // bucket add forms, which M7's channel slice found the same way.
      noValidate
      className="flex flex-col gap-1"
    >
      {/* Below `md` the new item's text takes its own line (M9 review). */}
      <div className="flex items-center gap-2 max-md:flex-wrap">
        <label htmlFor={textId} className="sr-only">
          New item for {stageName}
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
          className="min-w-0 flex-1 rounded-input border border-border bg-surface px-2 py-1 font-display text-[14px] leading-5 outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent max-md:basis-full max-md:text-base"
        />
        <label htmlFor={minutesId} className="sr-only">
          Minutes for the new {stageName} item
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
          aria-describedby={error ? errorId : undefined}
          className="w-16 rounded-input border border-border bg-surface px-2 py-1 text-right font-mono text-[12px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-accent max-md:text-base"
        />
        <span aria-hidden="true" className="font-mono text-[11px] text-muted">
          min
        </span>
        <button
          type="submit"
          data-testid="template-add-submit"
          disabled={cleanLabel(text) === ""}
          className="shrink-0 rounded-button border border-border px-2 py-1 text-[12px] font-medium outline-none enabled:hover:border-accent/50 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-4"
        >
          Add<span className="sr-only"> to {stageName}</span>
        </button>
      </div>
      {error ? <Refusal id={errorId} testId="template-add-error" message={error} /> : null}
    </form>
  );
}
