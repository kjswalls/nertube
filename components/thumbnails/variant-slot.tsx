"use client";

import { useCallback, useId, useState, type ChangeEvent } from "react";

import { CONCEPT_SKETCH_ACCEPT, MAX_SKETCH_LABEL, type ThumbnailRole } from "@/lib/storage";

import { ROLE_LABEL, ROLE_NOTE } from "./roles";

/**
 * One of the three slots: the picture, what the role is for, and the three
 * things that can be done to it.
 *
 * ## The frame has three states and says which one it is in
 *
 * `url === null` collapses two genuinely different situations, and M3's
 * reviewers caught the concept sketch telling exactly this lie: a grey box that
 * says "no image yet" when in fact there *is* one and the app could not get at
 * it is unactionable — the person uploads it again and nothing changes, because
 * nothing was wrong with the upload. So:
 *
 * - **empty** — no path on the row. "No image yet" is true.
 * - **unreachable** — there is a path and no signed URL. The app could not sign
 *   one, or the object is gone.
 * - **broken** — a URL was signed and the browser could not decode what came
 *   back. Remembered as *which* URL failed (not a boolean) so a freshly signed
 *   one is tried rather than written off by the last one's failure — the same
 *   pattern as `app/videos/[id]/concept-sketch.tsx` and
 *   `components/preview/youtube-preview.tsx`.
 *
 * **`onError` alone is not enough, and that was a real hole.** On a
 * server-rendered load the browser fetches the signed URL and fires `error`
 * long before React attaches the handler, and React does not replay it — so an
 * expired signature, a missing object or a storage 5xx left the slot reporting
 * `ready` and painting a blank 16:9 rectangle with no text on it, which is
 * precisely what the three states exist to prevent. The ref callback below
 * reads the element as it mounts (`complete && naturalWidth === 0` is an image
 * that has finished and decoded nothing) and puts it in the same `broken`
 * state. `onError` stays, for failures that arrive after hydration.
 *
 * All three are the same 16:9 rectangle at the same size, so nothing on the
 * page moves as a slot fills.
 *
 * ## Why "Ship this one" is not disabled on an empty slot
 *
 * Because a disabled button is a refusal with no explanation, and because the
 * refusal is not this component's to make: `videos_shipped_role_has_asset` in
 * `0001_init.sql` is what decides that a shipped role has an image, and it
 * decides it in Postgres. Pressing the button asks, the database refuses, and
 * `shipThumbnail` turns the constraint into a sentence naming this slot. A
 * greyed-out button would be the application *claiming* the rule while quietly
 * not being the thing that enforces it.
 */
export function VariantSlot({
  role,
  url,
  hasAsset,
  live,
  liveNote,
  title,
  busy,
  message,
  onFile,
  onShip,
  onRemove,
  slotRef,
}: {
  role: ThumbnailRole;
  /** A signed, cache-busted URL, or null — see the three states above. */
  url: string | null;
  /** Whether the row names an image at all. Not the same as having a URL. */
  hasAsset: boolean;
  live: boolean;
  /** For the live slot: when it went live and why, from the log. */
  liveNote: string | null;
  /** The video's title, for alt text. */
  title: string;
  busy: null | "uploading" | "saving" | "shipping" | "removing";
  /** This slot's own status line: an error, or what just happened. */
  message: { text: string; tone: "error" | "info" } | null;
  onFile: (file: File) => void;
  /** The button is handed back so the swap dialog can return focus to it. */
  onShip: (button: HTMLElement | null) => void;
  onRemove: () => void;
  /** Registers this slot's outer element, so a finished swap can focus it. */
  slotRef?: (element: HTMLElement | null) => void;
}) {
  const inputId = useId();
  const headingId = useId();
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  /*
    Catch an image that failed *before* React got here.

    A ref callback runs on mount with the real element, which is the first
    moment this component can ask the question at all. `complete` with a
    `naturalWidth` of 0 is the browser saying "I finished with this and there
    is no picture", which is exactly the blank-rectangle case. Keyed on the
    current `url` so a re-signed URL is not written off by the previous one.
  */
  const watchImage = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element || url === null) return;
      if (element.complete && element.naturalWidth === 0) setBrokenUrl(url);
    },
    [url],
  );

  const broken = url !== null && brokenUrl === url;
  const showing = url !== null && !broken;
  const state = showing ? "ready" : hasAsset ? (broken ? "broken" : "unreachable") : "empty";
  const label = ROLE_LABEL[role];

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    // Cleared so choosing the *same* file again still fires `change` — the
    // obvious thing to do after a refusal.
    input.value = "";
    if (file) onFile(file);
  }

  return (
    <section
      ref={slotRef}
      aria-labelledby={headingId}
      data-testid="variant-slot"
      data-role={role}
      data-state={state}
      data-live={live ? "true" : "false"}
      /* Not a tab stop — it is only ever focused programmatically, when a swap
         lands and the button that started it has become "Shipped". */
      tabIndex={-1}
      className={[
        "flex min-w-0 flex-col gap-2 rounded-card border p-3",
        live ? "border-accent bg-surface" : "border-border bg-surface/50",
      ].join(" ")}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 id={headingId} className="text-sm font-medium">
          {label}
        </h4>
        {live ? (
          <span
            data-testid="variant-live-badge"
            className="rounded-full border border-accent px-2 py-0.5 text-[11px] font-medium text-accent"
          >
            Live
          </span>
        ) : null}
      </div>

      {/* One box, one size, whatever is inside it — 16:9 because that is the
          only shape YouTube ever serves a thumbnail at, so a variant that is
          the wrong shape is visible here rather than at upload time. */}
      <div
        data-testid="variant-frame"
        className={[
          "aspect-video w-full overflow-hidden rounded-input border",
          showing ? "border-border bg-background" : "border-dashed border-border bg-background/50",
        ].join(" ")}
      >
        {showing ? (
          /* A plain <img> and not next/image: the source is a signed URL on a
             host that comes from an environment variable, carrying a token that
             expires within the hour, so `remotePatterns` cannot describe it and
             the optimiser would cache private bytes past the signature. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={`${label} thumbnail for ${title.trim() === "" ? "this video" : title}`}
            data-testid="variant-image"
            loading="lazy"
            decoding="async"
            ref={watchImage}
            onError={() => setBrokenUrl(url)}
            className="h-full w-full object-cover"
          />
        ) : (
          <p
            data-testid="variant-empty"
            data-state={state}
            className={[
              "flex h-full w-full items-center justify-center px-3 text-center text-xs",
              state === "empty" ? "text-muted" : "text-attention",
            ].join(" ")}
          >
            {state === "empty"
              ? "No image yet"
              : state === "broken"
                ? "This image would not load. Reload the page first — the link to it expires. If it still will not load, upload the file again."
                : "This image could not be reached — the app could not sign a URL for it."}
          </p>
        )}
      </div>

      {/* Labelled for what it is: the role's description, identical on every
          video. Unlabelled it read as a note about *this* image, which is a
          different thing — the per-variant sentence a person writes is the swap
          reason, and that is the line below. */}
      <p className="text-xs text-muted">
        <span className="font-medium text-foreground">What this slot is for: </span>
        {ROLE_NOTE[role]}
      </p>

      {live && liveNote ? (
        <p data-testid="variant-live-note" className="text-xs text-foreground">
          {liveNote}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-xs font-medium text-muted">
          {hasAsset ? `Replace the ${label.toLowerCase()}` : `Upload the ${label.toLowerCase()}`}
        </label>
        <input
          id={inputId}
          type="file"
          accept={CONCEPT_SKETCH_ACCEPT}
          disabled={busy !== null}
          onChange={pick}
          data-testid="variant-file"
          className="w-full text-xs file:mr-2 file:min-h-11 file:rounded-input file:border file:border-border file:bg-surface file:px-2 file:py-2 file:text-xs file:text-foreground"
        />
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          data-testid="variant-ship"
          /*
            PLAN.md's M4 line says "shipped radio"; this is three buttons, one
            per slot — see the deviation recorded in docs/MILESTONES.md. What a
            radio group would have given for free is a distinct accessible name
            per option, and three buttons all reading "Ship this one" is a
            screen-reader elements list with three identical entries. The name
            is spelled out here; the visible label stays short because the slot
            it sits in is already headed with the role.
          */
          aria-label={live ? undefined : `Ship the ${label.toLowerCase()}`}
          disabled={busy !== null || live}
          onClick={(event) => onShip(event.currentTarget)}
          className="rounded-button border border-border bg-background px-2.5 py-1.5 text-xs font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 thumb:min-h-11"
        >
          {live ? "Shipped" : "Ship this one"}
        </button>

        {hasAsset ? (
          <button
            type="button"
            data-testid="variant-remove"
            disabled={busy !== null}
            onClick={onRemove}
            className="rounded-button px-2 py-1.5 text-xs text-muted underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 thumb:min-h-11"
          >
            Remove
          </button>
        ) : null}
      </div>

      {/*
        One region, one role, for the life of the slot.

        This used to be a single node whose `role` flipped between `status` and
        `alert` on the same update that changed its text. A live region that is
        created, or has its role changed, in the same update is announced
        unreliably — assistive technology has to have been watching the region
        under its final role before the mutation — and the refusals routed
        through it ("Safe has no image yet — upload one before shipping it.")
        are the ones that matter most. So the visible line is always
        `role="status"`, and a second, always-present `role="alert"` node beside
        it carries the refusals. Urgency is in the words and the colour, which
        is where it was always readable anyway.
      */}
      <p
        role="status"
        aria-live="polite"
        data-testid="variant-status"
        className={[
          "min-h-4 text-xs",
          message?.tone === "error" ? "text-attention" : "text-muted",
        ].join(" ")}
      >
        {busy === "uploading"
          ? "Uploading…"
          : busy === "saving"
            ? "Saving…"
            : busy === "shipping"
              ? "Shipping…"
              : busy === "removing"
                ? "Removing…"
                : (message?.text ?? "")}
      </p>

      <p
        role="alert"
        data-testid="variant-alert"
        className="sr-only"
      >
        {message?.tone === "error" ? message.text : ""}
      </p>

      <p className="text-[11px] text-muted">
        PNG, JPEG, WebP, GIF or AVIF, up to {MAX_SKETCH_LABEL}. A new file
        replaces this slot.
      </p>
    </section>
  );
}
