"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode, type RefObject } from "react";

import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

import { CaptureForm, type CaptureChannel } from "./capture-form";

/**
 * The capture box as a dialog, and the confirmation that outlives it.
 *
 * Extracted in M9 from `CaptureHost`, which is the `c` key and the sidebar's
 * Capture button, so that an empty view can open *the same box* — same form,
 * same toast, same "Open it" link — from a button of its own. Before this the
 * only ways in were a key a phone does not have and a button in the sidebar
 * that a person looking at an empty page has not been told about.
 */
export function CaptureDialog({
  channels,
  initialChannelId,
  preferLastUsed,
  returnFocusRef,
  onClose,
  onSaved,
  onClosed,
}: {
  channels: readonly CaptureChannel[];
  initialChannelId: string;
  preferLastUsed: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** After the write landed and the toast was pushed. */
  onSaved?: (saved: { id: string; title: string; channelName: string }) => void;
  onClosed?: () => void;
}) {
  const toast = useToast();

  return (
    <Modal
      title="Capture an idea"
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      onClosed={onClosed}
    >
      <CaptureForm
        channels={channels}
        initialChannelId={initialChannelId}
        preferLastUsed={preferLastUsed}
        variant="modal"
        onSaved={(result) => {
          onClose();
          // The modal closes on save, so the confirmation has to outlive it
          // — and it goes through the application's one toast mechanism
          // rather than a second line of its own. It says *where* the idea
          // went, because `1..9` can have retargeted it.
          toast.push({
            message: `Captured “${result.title}” in ${result.channelName}.`,
            /*
              M8: where the assist lives, one press away — and deliberately
              not in the box above.

              BRIEF.md principle 6 is that friction reduction *is* the
              product, and capture is the shortest path in the app: one
              field, Enter, gone. A model call takes ten to forty seconds,
              so an assist on that path would turn the fastest thing here
              into the slowest. It also could not be built honestly:
              `app/actions/assist.ts` takes a video id and nothing else,
              precisely so a browser can never hand the key a prompt of its
              own — and at capture time there is no row yet. So the idea is
              written first, and the confirmation carries the way to the
              four controls that can now do something with it.
            */
            links: [{ label: "Open it", href: `/videos/${result.id}` }],
          });
          onSaved?.(result);
        }}
      />
    </Modal>
  );
}

/**
 * "Capture the first idea", as the one action on an empty view.
 *
 * A link first and a dialog second, exactly like the matrix's empty cell: it
 * really is `<a href="/capture?c=<slug>">`, so it works before hydration,
 * with no JavaScript, and on a middle-click; a plain click opens the capture
 * box here instead, because the empty view is about to stop being empty and
 * the person should watch it happen rather than come back to it.
 *
 * After a save the route is refreshed (the view drew "empty" on the server)
 * and focus is put on the video that just arrived, found by the
 * `data-video-id` the board's card and the bank's row both carry. The link
 * that opened the dialog is gone by then — it was the empty state — so
 * `Modal`'s own focus return would land on `<body>`, which is the M5 matrix
 * cell's problem and the same fix.
 */
export function CaptureLink({
  channels,
  channelId,
  className,
  testId,
  children,
}: {
  /** Every channel the box may file into; `1..9` retargets among them. */
  channels: readonly CaptureChannel[];
  /**
   * The view's own channel, when it has one (a board, a bank). Without it the
   * box opens on the last-used channel, the way `c` does away from a channel
   * route.
   */
  channelId?: string;
  className: string;
  testId?: string;
  children: ReactNode;
}) {
  const channel =
    channels.find((candidate) => candidate.id === channelId) ?? channels[0];
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const captured = useRef<string | null>(null);
  const router = useRouter();

  // Nothing to capture into: the caller should be offering `/c/new` instead.
  if (!channel) return null;

  function focusArrival(videoId: string): void {
    const deadline = Date.now() + 3000;
    const tick = () => {
      // Nobody has taken focus since the dialog closed: it is on `<body>`, on
      // a node the refresh detached, or still on the link that opened the box.
      // Anything else is a choice somebody made, and it is left alone.
      const active = document.activeElement;
      const stillOurs =
        active === null ||
        active === document.body ||
        !active.isConnected ||
        (active instanceof HTMLElement && active.dataset.captureLink === "true");
      if (!stillOurs) return;
      const arrival = document.querySelector<HTMLElement>(
        `[data-video-id="${CSS.escape(videoId)}"]`,
      );
      const target =
        arrival?.matches("a[href], button, [tabindex]")
          ? arrival
          : arrival?.querySelector<HTMLElement>("a[href], button, [tabindex]");
      if (target) {
        target.focus();
        return;
      }
      if (Date.now() < deadline) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return (
    <>
      <a
        href={`/capture?c=${encodeURIComponent(channel.slug)}`}
        data-testid={testId}
        data-capture-link="true"
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          returnFocus.current = event.currentTarget;
          setOpen(true);
        }}
        className={className}
      >
        {children}
      </a>

      {open ? (
        <CaptureDialog
          channels={channels}
          initialChannelId={channel.id}
          preferLastUsed={channelId === undefined}
          returnFocusRef={returnFocus}
          onClose={() => setOpen(false)}
          onSaved={(saved) => {
            captured.current = saved.id;
            router.refresh();
          }}
          onClosed={() => {
            const id = captured.current;
            captured.current = null;
            if (id) focusArrival(id);
          }}
        />
      ) : null}
    </>
  );
}
