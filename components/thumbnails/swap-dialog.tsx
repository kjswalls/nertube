"use client";

import { useEffect, useId, useRef, useState } from "react";

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
 * ## A real `<dialog>`
 *
 * `showModal()` rather than a div with a high z-index: it makes the rest of the
 * page inert, traps focus, closes on Escape and announces itself as a dialog,
 * all from the platform and with no dependency. The one thing it does not do is
 * put the caret somewhere useful, so this does — in the box that has to be
 * typed in.
 */
export function SwapDialog({
  from,
  to,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  /** What is live now. Null never reaches here — the first ship is one click. */
  from: ThumbnailRole;
  to: ThumbnailRole;
  busy: boolean;
  /** What the server refused with, if it did. */
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const noticeId = useId();
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // Mounted only while it is open — the section renders it or does not — so
  // this runs once, on the way in.
  useEffect(() => {
    const node = ref.current;
    if (node && !node.open) node.showModal();
    reasonRef.current?.focus();
  }, []);

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
    <dialog
      ref={ref}
      data-testid="swap-dialog"
      aria-labelledby="swap-dialog-heading"
      // Escape, and the backdrop's own close, both land here.
      onClose={onCancel}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
    >
      <form
        method="dialog"
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          // The dialog's own submit would close it without asking anything.
          event.preventDefault();
          confirm();
        }}
      >
        <h3 id="swap-dialog-heading" className="text-base font-semibold">
          Swap {ROLE_LABEL[from].toLowerCase()} → {ROLE_LABEL[to].toLowerCase()}
        </h3>

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
          maxLength={MAX_SWAP_REASON_LENGTH}
          placeholder="CTR 2.1% against an expected 4% — the wild card is not reading at tile size"
          aria-describedby={noticeId}
          data-testid="swap-reason-input"
          onChange={(event) => {
            setReason(event.target.value);
            if (notice) setNotice(null);
          }}
          className="w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
            className="rounded-button border border-border bg-surface px-3 py-1.5 text-sm font-medium outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
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
    </dialog>
  );
}
