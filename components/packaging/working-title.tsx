"use client";

import { useId } from "react";

import { MAX_TITLE_LENGTH, TITLE_WARN_LENGTH } from "@/lib/packaging";

/**
 * The working title, with a live character count.
 *
 * ## Why the warning does not block
 *
 * BRIEF.md's guidance is that a title should usually fit in about 55 characters
 * — that is where YouTube starts truncating on most surfaces, so past it the
 * end of the title is a gamble. It is guidance, not a constraint: a 58-character
 * title that lands is still a title that lands, and PLAN.md takes the same line
 * for AI-generated ones (*flag titles > 55 chars in the UI rather than
 * rejecting*). So the count turns amber and says what the number means, and the
 * field keeps accepting text. The only hard stop is `maxLength`, which is about
 * the column, not the craft.
 *
 * ## Why the count is live and the save is on blur
 *
 * They answer different questions. The count answers "how long is this
 * getting", which is only useful while typing. The save answers "is this the
 * title", which is only true once you stop — a title is written by deleting and
 * rewriting, and saving every keystroke would put a dozen half-titles through
 * `updated_at`, which the board's Idea column sorts by. Enter blurs, so the
 * keyboard path and the mouse path both end in exactly one save.
 */
export function WorkingTitle({
  anchorId,
  value,
  onChange,
  onCommit,
}: {
  /**
   * The input's `id` — `GATE_ANCHOR.title`, so the board's "Fix packaging"
   * link can land the caret here rather than merely scrolling past it.
   */
  anchorId: string;
  value: string;
  onChange: (next: string) => void;
  /** Blur or Enter: the block decides whether anything actually changed. */
  onCommit: () => void;
}) {
  const countId = useId();

  const length = value.length;
  const over = length > TITLE_WARN_LENGTH;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={anchorId} className="text-xs font-medium text-muted">
        Working title
      </label>

      <input
        id={anchorId}
        name="title"
        type="text"
        value={value}
        placeholder="Untitled"
        autoComplete="off"
        maxLength={MAX_TITLE_LENGTH}
        aria-describedby={countId}
        data-testid="working-title"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        // 16px so iOS does not zoom the page when the field is focused.
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
      />

      <p
        id={countId}
        data-testid="title-count"
        data-over={over ? "true" : "false"}
        className={[
          "text-xs",
          over ? "text-amber-700 dark:text-amber-400" : "text-muted",
        ].join(" ")}
      >
        {length}/{TITLE_WARN_LENGTH} characters
        {over
          ? ` — past ${TITLE_WARN_LENGTH}, YouTube may cut the end off. Worth knowing, not a rule.`
          : ""}
      </p>
    </div>
  );
}
