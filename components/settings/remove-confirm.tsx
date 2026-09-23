"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The settings area's one "Remove? / Keep" control.
 *
 * Two editors remove rows behind a second click — an inert stage, a bucket —
 * and each drew its own pair of buttons. This is the one pair, and the reason
 * it is one component rather than two copies is the part that is easy to get
 * wrong twice: **where focus goes**. Pressing Remove replaces the button with
 * the question, so the element that had focus is gone; pressing Keep does the
 * reverse. Left alone, the browser drops focus on `<body>` both times and a
 * keyboard user starts again from the skip link (M7's review). So the
 * question's first button takes focus when it appears, and the Remove button
 * takes it back when the question is withdrawn.
 *
 * What happens after "yes" is the editor's: the row is gone, and the editor
 * knows which row is next (`useMoveFocus.requestField`).
 */
export function RemoveConfirm({
  state,
  onAsk,
  onConfirm,
  onKeep,
  confirmLabel,
  question,
  subject,
  testIdPrefix,
  busyLabel = "Removing…",
}: {
  state: "idle" | "confirm" | "busy";
  onAsk: () => void;
  onConfirm: () => void;
  onKeep: () => void;
  /** The "yes" button's text: "Yes, remove", "Remove and unfile them". */
  confirmLabel: string;
  /** What removal does, printed beside the two buttons. */
  question: ReactNode;
  /** What is being removed, for the Remove button's accessible name. */
  subject: string;
  /** `stage` → `stage-remove`, `stage-remove-yes`, `stage-remove-keep`. */
  testIdPrefix: string;
  busyLabel?: string;
}) {
  const removeButton = useRef<HTMLButtonElement | null>(null);
  const yesButton = useRef<HTMLButtonElement | null>(null);
  const previous = useRef(state);

  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state === "confirm" && was !== "confirm") yesButton.current?.focus();
    if (state === "idle" && was === "confirm") removeButton.current?.focus();
  }, [state]);

  if (state === "confirm") {
    return (
      <p
        data-testid={`${testIdPrefix}-remove-confirm`}
        className="flex flex-wrap items-center gap-2 text-[12px] leading-5"
      >
        <span className="text-muted">{question}</span>
        <button
          ref={yesButton}
          type="button"
          data-testid={`${testIdPrefix}-remove-yes`}
          onClick={onConfirm}
          className="rounded-button border border-attention/50 px-2 py-0.5 text-attention outline-none hover:bg-attention/10 focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3 thumb:text-[14px]"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-remove-keep`}
          onClick={onKeep}
          className="rounded-button border border-border px-2 py-0.5 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3 thumb:text-[14px]"
        >
          Keep
        </button>
      </p>
    );
  }

  return (
    <button
      ref={removeButton}
      type="button"
      data-testid={`${testIdPrefix}-remove`}
      disabled={state === "busy"}
      onClick={onAsk}
      className="text-[12px] text-muted underline decoration-border underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 thumb:min-h-11 thumb:px-2 thumb:text-[14px]"
    >
      {state === "busy" ? busyLabel : "Remove"}
      <span className="sr-only"> {subject}</span>
    </button>
  );
}
