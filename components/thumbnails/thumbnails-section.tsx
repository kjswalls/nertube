"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import {
  recordThumbnailVariant,
  removeThumbnailVariant,
  shipThumbnail,
  type ThumbnailState,
} from "@/app/actions/thumbnails";
import { useVideoVersion } from "@/components/video-version";
import { useTimeZone } from "@/components/time-zone";
import { formatInstant } from "@/lib/calendar-dates";
import {
  describeSketchRejection,
  sketchExtensionFor,
  thumbnailVariantPath,
  THUMBNAIL_ROLES,
  uploadImage,
  type ThumbnailRole,
} from "@/lib/storage";
import { UNTITLED } from "@/components/preview/parts";
import { createClient } from "@/lib/supabase/client";

import { ThumbnailAssistProvider } from "./assist-target";
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
  const zone = useTimeZone();

  const [busy, setBusy] = useState<{ role: ThumbnailRole; kind: Busy } | null>(null);
  const [messages, setMessages] = useState<
    Partial<Record<ThumbnailRole, SlotMessage>>
  >({});
  const [dialog, setDialog] = useState<{
    from: ThumbnailRole;
    to: ThumbnailRole;
    /**
     * A sentence to start the reason from, when something proposed this swap.
     *
     * Only the critique panel ever sets it, and only ever as a *starting
     * point*: the textarea is editable, the log records what is confirmed, and
     * a swap nobody typed a reason for is still refused. See
     * `components/thumbnails/assist-target.tsx`.
     */
    suggestedReason?: string;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  /**
   * The control that opened the swap dialog, so focus has somewhere to go back
   * to when it closes.
   *
   * `Modal` records `document.activeElement` at mount, but the dialog's own
   * textarea has `autoFocus` and React applies that during the commit phase —
   * before the modal's effect runs — so what it recorded was the textarea
   * inside itself. On unmount that element is gone, `document.contains` is
   * false, and focus fell to `<body>` on Escape, on Cancel and on a successful
   * swap. `components/capture/capture-host.tsx` is the other caller and does
   * exactly this; the parameter exists for this hazard and is documented as
   * such in `components/modal.tsx`.
   */
  const opener = useRef<HTMLElement | null>(null);

  /**
   * Where focus goes after a swap that *worked*.
   *
   * The button it came from is the old live slot's, and shipping makes the new
   * one live — so the opener is either disabled ("Shipped") or has changed
   * meaning. The new live slot's heading is the thing that changed, and it is
   * made programmatically focusable for exactly this.
   */
  const landedRef = useRef<HTMLElement | null>(null);

  /** Each slot's outer element, by role — the target `landedRef` picks from. */
  const slotRefs = useRef(new Map<ThumbnailRole, HTMLElement>());

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
    // Only when the row was at this page's version before the write: these
    // writes carry no precondition, and a stale tab must stay stale so its
    // next save is refused rather than written over another tab's (M10
    // review; `advance` in `video-version.tsx`).
    version.advance(state.previousUpdatedAt, state.updatedAt);
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

  async function onShip(
    role: ThumbnailRole,
    from?: HTMLElement | null,
    suggestedReason?: string,
  ) {
    opener.current = from ?? null;

    // Something is already live: this is a swap, and a swap is explained.
    if (shippedRole !== null && shippedRole !== role) {
      setDialogError(null);
      setDialog({ from: shippedRole, to: role, suggestedReason });
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
      /*
        The row moved under us: another tab shipped something between this
        page's render and this click, so what looked like a first ship is a
        swap and needs a reason.

        The role is taken from the **server's answer**, not from `shippedRole`.
        That prop is null on every path that reaches here — `onShip` only calls
        the action when the page believes nothing is live — so testing it made
        this branch unreachable, and the dead-end was real: the slot printed
        "A swap needs a reason" with no textarea anywhere on screen, and
        clicking again repeated it forever. `router.refresh()` goes with it,
        because the section is still drawing `data-shipped=""` and no Live
        badge for a video that has one.
      */
      if (result.needsReason && result.currentRole) {
        setDialogError(result.error);
        setDialog({ from: result.currentRole, to: role });
        router.refresh();
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
    // The button that opened this is about to become "Shipped" and disabled,
    // so `Modal`'s own focus return has nowhere useful to go. The slot that
    // just went live is what changed; focus lands there.
    landedRef.current = slotRefs.current.get(role) ?? null;
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

  /**
   * Put focus where the swap landed, once the dialog has gone.
   *
   * Called from the dialog's unmount path rather than from `onConfirmSwap`,
   * because `Modal`'s own cleanup restores focus as it unmounts and would
   * otherwise win the race.
   */
  function restoreFocus() {
    const landed = landedRef.current;
    landedRef.current = null;
    if (landed && document.contains(landed)) {
      landed.focus();
      return;
    }
    const previous = opener.current;
    if (previous && document.contains(previous) && !previous.hasAttribute("disabled")) {
      previous.focus();
    }
  }

  /*
    What the critique panel is allowed to do, handed down rather than imported.

    The panel is mounted from the `assist` slot — an element built by a server
    component, which cannot be given props from here — so this is how it learns
    which slots have images, which one is live, and how to ship one. `ship` is
    `onShip`: the same function the button under each slot calls, so there is
    one path to `swap_thumbnail` and the critique is not a second one.

    Rebuilt on every render rather than memoised: every field in it is derived from
    props or state that change together, and the panel holds its own in-flight
    state, so a new object costs a re-render of a closed panel and nothing else.
  */
  const assistTarget = {
    variants: THUMBNAIL_ROLES.map((role) => ({
      role,
      hasAsset: byRole.get(role)?.hasAsset ?? false,
      live: shippedRole === role,
    })),
    hasConcept: (concept ?? "").trim() !== "",
    ship: (role: ThumbnailRole, suggestedReason: string, from: HTMLElement | null) =>
      void onShip(role, from, suggestedReason),
  };

  return (
    <ThumbnailAssistProvider target={assistTarget}>
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
            : `${ready} of 3 ready. Moving to Scheduled with fewer is allowed — the move says so and does not stop, because it is a warning and not a gate — but the point of three is that a swap takes minutes.`}
      </p>

      {/*
        The three slots get a heading of their own.

        They are siblings of the concept brief, not parts of it — but as h4s
        immediately after its h3 a screen-reader outline filed them *inside* the
        concept, which is the one blur this section's design rule forbids. One
        h3 here puts the assets beside the concept in the outline and gives the
        grid a name in the landmark list.
      */}
      <h3 id="variants-heading" className="text-sm font-semibold">
        The three variants
      </h3>

      <div
        data-testid="variant-grid"
        aria-labelledby="variants-heading"
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
                  ? `Live since ${formatInstant(liveEntry.swappedAt, zone) ?? liveEntry.swappedAt} — ${liveEntry.reason}`
                  : null
              }
              title={title}
              busy={busy?.role === role ? busy.kind : null}
              message={messages[role] ?? null}
              slotRef={(element) => {
                if (element) slotRefs.current.set(role, element);
                else slotRefs.current.delete(role);
              }}
              onFile={(file) => void onFile(role, file)}
              onShip={(button) => void onShip(role, button)}
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
        title={title.trim() === "" ? UNTITLED : title}
        channelName={channelName}
      />

      <SwapLog entries={swaps} />

      {dialog === null ? null : (
        <SwapDialog
          from={dialog.from}
          to={dialog.to}
          suggestedReason={dialog.suggestedReason}
          busy={dialogBusy}
          error={dialogError}
          /*
            What opened it. Without this `Modal` records the dialog's own
            textarea — `autoFocus` moves focus during the commit phase, before
            the modal's mount effect runs — and on close focus falls to
            `<body>`, on Escape, on Cancel and on a successful swap alike.
          */
          returnFocusRef={opener}
          onClosed={restoreFocus}
          onConfirm={(reason) => void onConfirmSwap(reason)}
          onCancel={() => {
            setDialog(null);
            setDialogError(null);
          }}
        />
      )}
    </section>
    </ThumbnailAssistProvider>
  );
}
