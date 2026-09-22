"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ThumbnailRole } from "@/lib/storage";

/**
 * The seam between the critique panel and the thumbnails section.
 *
 * The same shape, and the same reason, as
 * `components/assist/packaging-assist.tsx`: the panel proposes, the section
 * writes. `components/thumbnails/thumbnails-section.tsx` owns every command on
 * this screen — upload, ship, remove — and shipping in particular is not an
 * ordinary update at all: `update (shipped_role)` is revoked from clients in
 * `0001_init.sql`, so it can only happen through `swap_thumbnail`, which writes
 * the log row and the role in one transaction. A panel that shipped a variant
 * on its own would either be a second path to that function or, worse, an
 * attempt at a path that does not exist.
 *
 * So accepting a verdict calls back into the section's own `onShip`, which is
 * the same function the "Ship this one" button under each slot calls, with the
 * same dialog, the same refusals and the same log row. The only thing the
 * critique adds is a *suggested reason* in the dialog's textarea — the model's
 * own sentence, which the person can edit or delete before confirming, because
 * the swap log is a record of what they decided and nothing should be able to
 * write in it without them reading it first.
 */

export interface ThumbnailAssistVariant {
  readonly role: ThumbnailRole;
  /** Whether there is an image in the slot. Nothing else can be judged. */
  readonly hasAsset: boolean;
  /** Whether this is the one that is live. */
  readonly live: boolean;
}

export interface ThumbnailAssistTarget {
  readonly variants: readonly ThumbnailAssistVariant[];
  /** Whether a written concept exists to judge against (BRIEF.md principle 2). */
  readonly hasConcept: boolean;
  /**
   * Ship a role, through the section's own path.
   *
   * `suggestedReason` reaches the swap dialog's textarea as a starting point,
   * never as a decision: the first ship does not open the dialog at all (there
   * is nothing being replaced, so `LAUNCH_REASON` is what the log records) and
   * every later one shows the sentence for editing before it is written.
   */
  ship(
    role: ThumbnailRole,
    suggestedReason: string,
    from: HTMLElement | null,
  ): void;
}

const TargetContext = createContext<ThumbnailAssistTarget | null>(null);

export function ThumbnailAssistProvider({
  target,
  children,
}: {
  target: ThumbnailAssistTarget;
  children: ReactNode;
}) {
  return (
    <TargetContext.Provider value={target}>{children}</TargetContext.Provider>
  );
}

/**
 * The variants, as something to act on.
 *
 * `null` outside the provider rather than a throw, for the same reason the
 * packaging one does it: the assist slot is optional, and a page that renders
 * the control without the section around it should show a control that says it
 * cannot work, not a crashed section.
 */
export function useThumbnailAssistTarget(): ThumbnailAssistTarget | null {
  return useContext(TargetContext);
}
