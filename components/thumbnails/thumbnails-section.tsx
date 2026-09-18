"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import {
  recordThumbnailVariant,
  removeThumbnailVariant,
  shipThumbnail,
  type ThumbnailState,
} from "@/app/actions/thumbnails";
import { useVideoVersion } from "@/components/video-version";
import {
  describeSketchRejection,
  sketchExtensionFor,
  thumbnailVariantPath,
  THUMBNAIL_ROLES,
  uploadImage,
  type ThumbnailRole,
} from "@/lib/storage";
import { createClient } from "@/lib/supabase/client";

import { ConceptBrief } from "./concept-brief";
import { FeedStrip } from "./feed-strip";
import { LAUNCH_REASON, ROLE_LABEL } from "./roles";
import { SwapDialog } from "./swap-dialog";
import { SwapLog, type SwapEntry } from "./swap-log";
import { VariantSlot } from "./variant-slot";

/**
 * The Thumbnails section: the concept it is working from, the three variants,
 * which one is live, and the log of every time that changed.
 *
 * ## The one decision this component makes
 *
 * Everything on this screen is a *command* — upload this file, ship this
 * variant, clear this slot — and not an edit. There is no draft to hold, no
 * field to debounce and nothing to merge, so this deliberately does **not**
 * use the page's save queue (`components/autosave.tsx`): it runs the action,
 * takes the server's answer, and calls `router.refresh()` so the next render
 * comes from the row. M2 and M3 produced seven blockers between them in
 * optimistic-save code, and every one of them was a disagreement between a
 * local copy of state and the row. The cheapest way not to have an eighth is
 * not to keep a local copy.
 *
 * What is kept locally is only what the server does not know about: which
 * button is busy, what the last refusal said, and whether the swap dialog is
 * open.
 *
 * ## The two halves of shipping
 *
 * The **first** ship is one click — there is nothing being replaced, so there
 * is nothing to explain, and `LAUNCH_REASON` is what the log records. Every
 * change after that opens the dialog and needs a typed reason, because the log
 * is the only record of why a thumbnail changed and "why" is the thing the
 * post-publish loop is actually asking.
 *
 * Both go through `swap_thumbnail`, which writes the log row and the new
 * `shipped_role` in one transaction. `UPDATE (shipped_role)` is revoked from
 * clients in `0001_init.sql`, so that is not a choice this component makes —
 * it is the only door.
 */

export interface ThumbnailVariantView {
  readonly role: ThumbnailRole;
  /** A signed, cache-busted URL, or null when there is none *or* signing failed. */
  readonly url: string | null;
  /** Whether the row names an object at all. Different from having a URL. */
  readonly hasAsset: boolean;
}

type Busy = null | "uploading" | "saving" | "shipping" | "removing";

interface SlotMessage {
  readonly text: string;
  readonly tone: "error" | "info";
}

export function ThumbnailsSection({
  videoId,
  userId,
  title,
  channelName,
  concept,
  conceptHref,
  variants,
  shippedRole,
  swaps,
  assist,
}: {
  videoId: string;
  /** The signed-in user: the first segment of every path they may write. */
  userId: string;
  title: string;
  channelName: string;
  concept: string | null;
  conceptHref: string;
  variants: readonly ThumbnailVariantView[];
  shippedRole: ThumbnailRole | null;
  /** Newest first, as the server read them. */
  swaps: readonly SwapEntry[];
  /** The inert M8 assist pill, rendered by the server. */
  assist?: ReactNode;
}) {
  const router = useRouter();
  const version = useVideoVersion();

  const [busy, setBusy] = useState<{ role: ThumbnailRole; kind: Busy } | null>(null);
  const [messages, setMessages] = useState<
    Partial<Record<ThumbnailRole, SlotMessage>>
  >({});
  const [dialog, setDialog] = useState<{ from: ThumbnailRole; to: ThumbnailRole } | null>(
    null,
  );
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const byRole = new Map(variants.map((variant) => [variant.role, variant]));
  const ready = variants.filter((variant) => variant.hasAsset).length;

  function say(role: ThumbnailRole, message: SlotMessage | null) {
    setMessages((previous) => ({ ...previous, [role]: message ?? undefined }));
  }

  /**
   * Take the answer a write came back with.
   *
   * `version.adopt` first: every action here stamps `updated_at`, and the page
   * holds one version token for the whole row. A write that did not report its
   * stamp would leave the token one version stale and the *next* packaging save
   * would be refused as a conflict that never happened.
   */
  function adopt(state: ThumbnailState) {
    version.adopt(state.updatedAt);
    router.refresh();
  }

  async function onFile(role: ThumbnailRole, file: File) {
    say(role, null);

    const label = ROLE_LABEL[role];
    // Courtesy, not security: this runs in a browser and the real boundary is
    // the `thumbnails owner rw` policy on `storage.objects`. It exists so the
    // honest mistake — a PDF, a 40 MB export — is refused instantly instead of
    // by an upload that spends a minute first.
    const rejection = describeSketchRejection(file, `A ${label.toLowerCase()} thumbnail`);
    const extension = sketchExtensionFor(file.type);
    if (rejection || !extension) {
      say(role, {
        text: rejection ?? "That file is not an image this app can store.",
        tone: "error",
      });
      return;
    }

    const path = thumbnailVariantPath(userId, videoId, role, extension);

    // Upload first, record second. If the recording fails the object is an
    // orphan at a *stable* path, so the next successful upload of the same
    // format lands on it and it stops being one; recorded first, the row would
    // point at bytes that may never arrive.
    setBusy({ role, kind: "uploading" });
    const { error: uploadError } = await uploadImage(createClient(), path, file);
    if (uploadError) {
      setBusy(null);
      say(role, { text: `The upload did not finish: ${uploadError}`, tone: "error" });
      return;
    }

    setBusy({ role, kind: "saving" });
    let result;
    try {
      result = await recordThumbnailVariant({ videoId, role, path });
    } catch {
      setBusy(null);
      say(role, {
        text: "The image uploaded, but the server could not be reached to record it. Choose the file again to finish.",
        tone: "error",
      });
      return;
    }
    setBusy(null);

    if (!result.ok) {
      say(role, { text: result.error, tone: "error" });
      return;
    }

    say(role, { text: `${label} saved`, tone: "info" });
    adopt(result);
  }

  async function onShip(role: ThumbnailRole) {
    // Something is already live: this is a swap, and a swap is explained.
    if (shippedRole !== null && shippedRole !== role) {
      setDialogError(null);
      setDialog({ from: shippedRole, to: role });
      return;
    }

    say(role, null);
    setBusy({ role, kind: "shipping" });

    let result;
    try {
      result = await shipThumbnail({ videoId, role });
    } catch {
      setBusy(null);
      say(role, { text: "The server could not be reached. Try again.", tone: "error" });
      return;
    }
    setBusy(null);

    if (!result.ok) {
      // The row moved under us and something is live after all — ask for the
      // reason rather than reporting a refusal the person cannot act on.
      if (result.needsReason && shippedRole !== null) {
        setDialogError(result.error);
        setDialog({ from: shippedRole, to: role });
        return;
      }
      say(role, { text: result.error, tone: "error" });
      return;
    }

    say(role, { text: `${ROLE_LABEL[role]} is live`, tone: "info" });
    adopt(result);
  }

  async function onConfirmSwap(reason: string) {
    if (dialog === null) return;
    const role = dialog.to;

    setDialogBusy(true);
    setDialogError(null);

    let result;
    try {
      result = await shipThumbnail({ videoId, role, reason });
    } catch {
      setDialogBusy(false);
      setDialogError("The server could not be reached. Try again.");
      return;
    }
    setDialogBusy(false);

    if (!result.ok) {
      setDialogError(result.error);
      return;
    }

    setDialog(null);
    say(role, { text: `${ROLE_LABEL[role]} is live`, tone: "info" });
    adopt(result);
  }

  async function onRemove(role: ThumbnailRole) {
    say(role, null);
    setBusy({ role, kind: "removing" });

    let result;
    try {
      result = await removeThumbnailVariant({ videoId, role });
    } catch {
      setBusy(null);
      say(role, { text: "The server could not be reached. Try again.", tone: "error" });
      return;
    }
    setBusy(null);

    if (!result.ok) {
      say(role, { text: result.error, tone: "error" });
      return;
    }

    say(role, { text: `${ROLE_LABEL[role]} removed`, tone: "info" });
    adopt(result);
  }

  /** The most recent log entry that made a role live — its "why", on the slot. */
  const liveEntry = swaps.find((entry) => entry.toRole === shippedRole) ?? null;

  return (
    <section
      aria-labelledby="thumbnails-heading"
      data-testid="thumbnails-section"
      data-ready={ready}
      data-shipped={shippedRole ?? ""}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="thumbnails-heading" className="text-lg font-semibold">
            Thumbnail assets
          </h2>
          <p className="max-w-prose text-xs text-muted">
            Three bets on one concept — a wild card, a moderate and a safe
            fallback — all ready before the video goes live, so a bad first
            hour costs a swap rather than a day making a new image.
          </p>
        </div>
        {assist}
      </div>

      <ConceptBrief concept={concept} conceptHref={conceptHref} />

      <p
        data-testid="thumbnails-readiness"
        className={[
          "text-sm",
          ready === 3 ? "text-muted" : "text-attention",
        ].join(" ")}
      >
        {ready === 0
          ? "No variants yet. All three are meant to exist before launch."
          : ready === 3
            ? "All three ready."
            : `${ready} of 3 ready. Moving to Scheduled with fewer is allowed — it is a warning, not a gate — but the point of three is that a swap takes minutes.`}
      </p>

      <div
        data-testid="variant-grid"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {THUMBNAIL_ROLES.map((role) => {
          const variant = byRole.get(role);
          const live = shippedRole === role;
          return (
            <VariantSlot
              key={role}
              role={role}
              url={variant?.url ?? null}
              hasAsset={variant?.hasAsset ?? false}
              live={live}
              liveNote={
                live && liveEntry
                  ? `Live since ${new Date(liveEntry.swappedAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      timeZone: "UTC",
                    })} — ${liveEntry.reason}`
                  : null
              }
              title={title}
              busy={busy?.role === role ? busy.kind : null}
              message={messages[role] ?? null}
              onFile={(file) => void onFile(role, file)}
              onShip={() => void onShip(role)}
              onRemove={() => void onRemove(role)}
            />
          );
        })}
      </div>

      <p className="text-xs text-muted">
        {shippedRole === null
          ? `Nothing is live yet. The first one you ship is logged as “${LAUNCH_REASON}”; every change after that asks for a reason.`
          : "Changing the live thumbnail asks for a reason, and writes it to the log below together with the change itself."}
      </p>

      <FeedStrip
        variants={THUMBNAIL_ROLES.map((role) => ({
          role,
          url: byRole.get(role)?.url ?? null,
          hasAsset: byRole.get(role)?.hasAsset ?? false,
          live: shippedRole === role,
        }))}
        title={title.trim() === "" ? "Untitled — the working title shows here" : title}
        channelName={channelName}
      />

      <SwapLog entries={swaps} />

      {dialog === null ? null : (
        <SwapDialog
          from={dialog.from}
          to={dialog.to}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={(reason) => void onConfirmSwap(reason)}
          onCancel={() => {
            setDialog(null);
            setDialogError(null);
          }}
        />
      )}
    </section>
  );
}
