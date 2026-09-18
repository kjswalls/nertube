"use client";

import { useId, useRef, useState, type RefObject } from "react";

import { Modal } from "@/components/modal";
import type { ThumbnailRole } from "@/lib/storage";

import {
  describeReasonRejection,
  MAX_SWAP_REASON_LENGTH,
  ROLE_LABEL,
} from "./roles";

/**
 * Changing which thumbnail is live, and the reason that goes in the log with
 * it.
 *
 * ## Why a reason is required at all
 *
 * The swap log is the only record of *why* a thumbnail changed, and the whole
 * post-publish loop (BRIEF.md principle 8) is a loop: you swap, you look again
 * a week later, and the useful question is whether swapping worked — which is
 * unanswerable if the entry says nothing. `thumbnail_swaps.reason` is `not null
 * check (reason <> '')`, so the database refuses a blank; a reason of `x`
 * satisfies that and tells a reader nothing, which is the hole
 * `MIN_SWAP_REASON_LENGTH` closes. Refused here before the round trip, and
 * refused again by `shipThumbnail` — one function, `describeReasonRejection`,
 * so the two cannot disagree about what counts.
 *
 * The **first** ship does not come through this dialog. There is nothing being
 * replaced and nothing to explain, so demanding a sentence would be friction
 * for its own sake (BRIEF.md principle 6: *if the tool adds friction, it
 * fails*). It is logged as `LAUNCH_REASON` and the section says so next to the
 * button.
 *
 * ## The modal is the application's modal
 *
 * This first landed as a native `<dialog>` with `showModal()`, which was a
 * second modal implementation in a codebase that already had one — and it had
 * the bug the first one exists to avoid. `lib/shortcuts.ts` keeps a single
 * `keydown` listener on `document`, and the only thing that silences the page
 * behind a dialog is an `exclusive` registration. A native `<dialog>` is inert
 * to clicks and focus, but its key events still reach `document`: pressing `c`
 * with focus on Cancel opened the capture box on top of the swap. So this uses
 * `components/modal.tsx`, the same shell the capture box uses, and gets the
 * focus trap, the focus return, Escape-from-inside-a-textarea and the quiet
 * page from the one place that implements them.
 */
export function SwapDialog({
  from,
  to,
  busy,
  error,
  returnFocusRef,
  onClosed,
  onConfirm,
  onCancel,
}: {
  /** What is live now. Null never reaches here — the first ship is one click. */
  from: ThumbnailRole;
  to: ThumbnailRole;
  busy: boolean;
  /** What the server refused with, if it did. */
  error: string | null;
  /**
   * The control this was opened from.
   *
   * Passed straight through to `Modal`. Without it the shell records
   * `document.activeElement` at mount — which, because the textarea below has
   * `autoFocus` and React applies that during the commit phase, is the
   * textarea inside this dialog. On unmount that element is gone and focus
   * falls to `<body>`. `components/modal.tsx` documents the hazard and this
   * parameter is the answer to it; this dialog simply was not passing one.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Run after the dialog has gone, for the caller to place focus itself. */
  onClosed?: () => void;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const noticeId = useId();
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  function confirm() {
    const rejection = describeReasonRejection(reason);
    if (rejection) {
      setNotice(rejection);
      reasonRef.current?.focus();
      return;
    }
    setNotice(null);
    onConfirm(reason.trim());
  }

  return (
    <Modal
      title={`Swap ${ROLE_LABEL[from].toLowerCase()} → ${ROLE_LABEL[to].toLowerCase()}`}
      testId="swap-dialog"
      returnFocusRef={returnFocusRef}
      onClosed={onClosed}
      onClose={onCancel}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <p className="text-xs text-muted">
          This writes one row in the swap log — the date, the two roles and this
          reason — and makes{" "}
          <strong className="font-medium">{ROLE_LABEL[to]}</strong> the live
          thumbnail. Both happen together or neither does. The log cannot be
          edited or deleted afterwards.
        </p>

        <label htmlFor="swap-reason" className="text-xs font-medium text-muted">
          Why are you swapping?
        </label>
        <textarea
          id="swap-reason"
          ref={reasonRef}
          value={reason}
          rows={3}
          // The dialog is opened by a click on "Ship this one", so the caret
          // has to be put where the typing goes; the shell only focuses the
          // first tab stop when nothing else asks.
          autoFocus
          maxLength={MAX_SWAP_REASON_LENGTH}
          placeholder="CTR 2.1% against an expected 4% — the wild card is not reading at tile size"
          aria-describedby={noticeId}
          data-testid="swap-reason-input"
          onChange={(event) => {
            setReason(event.target.value);
            if (notice) setNotice(null);
          }}
          className="w-full resize-y rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        <p
          id={noticeId}
          role="alert"
          data-testid="swap-notice"
          className="min-h-4 text-xs text-attention"
        >
          {notice ?? error ?? ""}
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            data-testid="swap-confirm"
            className="rounded-button border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Swapping…" : `Swap to ${ROLE_LABEL[to].toLowerCase()}`}
          </button>
          <button
            type="button"
            data-testid="swap-cancel"
            onClick={onCancel}
            className="rounded-button px-3 py-1.5 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
