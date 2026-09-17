"use client";

import { useEffect, useRef, useState } from "react";

import { useToast } from "@/components/toast";
import { useShortcuts } from "@/lib/shortcuts";

import { CaptureForm, type CaptureChannel } from "./capture-form";
import { CaptureModal } from "./capture-modal";

/**
 * What makes `c` work anywhere: the global binding, the modal it opens, and the
 * toast that says where the idea went.
 *
 * It is mounted by the app header, so every signed-in page has it without each
 * page remembering to — and the header is already the component that knows the
 * channel list and which channel the route is about, which is exactly what
 * capture needs (PLAN.md: "Channel = route channel if any, else last-used").
 *
 * Nothing is rendered until `c` is pressed, apart from the button that says the
 * key exists. The confirmation is a toast, so it survives the modal closing.
 */
export function CaptureHost({
  channels,
  currentSlug,
}: {
  channels: readonly CaptureChannel[];
  /** The channel the current route is about, if it is about one. */
  currentSlug?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /**
   * Where focus was when the modal was asked for.
   *
   * Recorded here, in the event handler, rather than in the modal's mount
   * effect: by the time an effect runs the form's `autoFocus` has already moved
   * focus into the dialog, so the modal would "restore" focus to its own input.
   */
  const returnFocus = useRef<HTMLElement | null>(null);
  const toast = useToast();

  const routeChannel = currentSlug
    ? channels.find((channel) => channel.slug === currentSlug)
    : undefined;

  useShortcuts(
    [
      {
        key: "c",
        description: "Capture an idea",
        hint: { keys: "c", text: "capture" },
        run: (event) => {
          event.preventDefault();
          openCapture();
        },
      },
    ],
    // While the modal is open `c` is a letter in a title. The hook ignores
    // events from inputs anyway; this makes it true of the whole dialog.
    { enabled: !open && channels.length > 0 },
  );

  // Says out loud that the shortcut is live — it is bound by an effect, so
  // between the server's HTML and hydration the `c` hint would be a promise the
  // page cannot keep. Written to the DOM rather than held in state because it
  // changes nothing React renders. (The e2e suite waits on it, too: pressing
  // `c` at an unhydrated page is how that suite would flake.)
  useEffect(() => {
    buttonRef.current?.setAttribute("data-shortcut-ready", "true");
  }, []);

  function openCapture() {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }

  // A channel-less account cannot capture anything: there is no Idea stage to
  // capture into. `/c/new` is the only thing to do, and the header links it.
  if (channels.length === 0) return null;

  return (
    <>
      {/* `c` is invisible, and a phone has no `c`. `aria-keyshortcuts` tells
          assistive technology about the key; the button is how everyone else
          finds the feature at all. */}
      <button
        ref={buttonRef}
        type="button"
        aria-keyshortcuts="c"
        onClick={openCapture}
        className="rounded-full border border-border px-3 py-1 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
      >
        Capture <kbd className="font-sans text-xs text-muted">c</kbd>
      </button>

      {open ? (
        <CaptureModal
          title="Capture an idea"
          returnFocusRef={returnFocus}
          onClose={() => setOpen(false)}
        >
          <CaptureForm
            channels={channels}
            initialChannelId={(routeChannel ?? channels[0]).id}
            preferLastUsed={!routeChannel}
            variant="modal"
            onSaved={(result) => {
              setOpen(false);
              // The modal closes on save, so the confirmation has to outlive it
              // — and it goes through the application's one toast mechanism
              // rather than a second line of its own. It says *where* the idea
              // went, because `1..9` can have retargeted it.
              toast.push({
                message: `Captured “${result.title}” in ${result.channelName}.`,
              });
            }}
          />
        </CaptureModal>
      ) : null}
    </>
  );
}
