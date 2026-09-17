"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * The refusal toast.
 *
 * PLAN.md: *a refused drop snaps back with a toast naming the missing field, a
 * "Fix packaging" link (detail scrolled to that field) and a "Skip gate…"
 * link*. In M1 the detail page is a stub, so both links point at it and the
 * `#packaging` fragment is the anchor M2's packaging block will carry — a link
 * to a page being built this milestone, not an invented route.
 *
 * `role="alert"` rather than a polite live region: the user just tried to do
 * something and it did not happen, so the announcement should interrupt. It is
 * dismissible and it also times out, because a toast that stays forever
 * eventually gets ignored.
 */
export interface BoardToast {
  /** Changes on every new toast so a repeat of the same message re-announces. */
  readonly key: number;
  readonly message: string;
  /** When set, the toast offers the packaging links for this video. */
  readonly videoId: string | null;
}

export function BoardToastRegion({
  toast,
  onDismiss,
}: {
  toast: BoardToast | null;
  onDismiss: () => void;
}) {
  const key = toast?.key ?? null;

  useEffect(() => {
    if (key === null) return;
    const timer = window.setTimeout(onDismiss, 12_000);
    return () => window.clearTimeout(timer);
  }, [key, onDismiss]);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="alert"
        data-testid="board-toast"
        className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-red-500/60 bg-background px-3 py-2 text-sm shadow-lg"
      >
        <p className="min-w-0 flex-1">{toast.message}</p>

        {toast.videoId ? (
          <>
            <Link
              href={`/videos/${toast.videoId}#packaging`}
              className="shrink-0 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
            >
              Fix packaging
            </Link>
            <Link
              href={`/videos/${toast.videoId}#packaging-skip`}
              className="shrink-0 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
            >
              Skip gate…
            </Link>
          </>
        ) : null}

        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded px-1 text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          <span aria-hidden="true">×</span>
          <span className="sr-only">Dismiss</span>
        </button>
      </div>
    </div>
  );
}
