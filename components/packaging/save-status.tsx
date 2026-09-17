"use client";

/**
 * The packaging block's one saved/failed line.
 *
 * M1 shipped this pattern on the working title (`app/videos/[id]/title-field.tsx`):
 * a polite `role="status"` while things are going well, `role="alert"` when a
 * save did not happen, and — the part that matters — **the typed value is never
 * reverted**. This is that same contract for a block with six fields instead of
 * one, which is why it is one region rather than six: six live regions in one
 * card announce over each other, and a save here is frequently two columns at
 * once (choosing a candidate writes the list and the title together), so a
 * per-field indicator would have to light up two places for one save anyway.
 *
 * The retry button exists because a list edit has no natural second chance. A
 * failed title save is retried by blurring the field again; a failed "remove
 * this hook" has no gesture to repeat, and the change is sitting in the editor
 * unsaved. Retry re-sends exactly the payload that failed.
 */
export type SaveState<Payload = unknown> =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  /**
   * The payload rides along in the state rather than in a ref, so the button
   * that re-sends it is rendered from the same value that decides whether to
   * render it at all. (A ref read during render is also a React lint error, and
   * for the usual reason: the button would not appear until something else
   * re-rendered the block.)
   */
  | { kind: "error"; message: string; payload: Payload };

export function SaveStatus<Payload>({
  state,
  onRetry,
}: {
  state: SaveState<Payload>;
  onRetry: (payload: Payload) => void;
}) {
  const failed = state.kind === "error";

  return (
    <p
      role={failed ? "alert" : "status"}
      data-testid="packaging-save-status"
      className={[
        "flex min-h-5 flex-wrap items-center gap-2 text-xs",
        failed ? "text-amber-700 dark:text-amber-400" : "text-muted",
      ].join(" ")}
    >
      <span>
        {state.kind === "saving"
          ? "Saving…"
          : state.kind === "saved"
            ? "Saved"
            : failed
              ? state.message
              : ""}
      </span>

      {state.kind === "error" ? (
        <button
          type="button"
          onClick={() => onRetry(state.payload)}
          data-testid="packaging-retry"
          className="rounded border border-border px-2 py-0.5 font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          Retry
        </button>
      ) : null}
    </p>
  );
}
