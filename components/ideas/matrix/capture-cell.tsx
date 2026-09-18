"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { CaptureForm } from "@/components/capture/capture-form";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";

/**
 * An empty cell: the invitation, and the capture box it opens.
 *
 * BRIEF.md's sentence about this whole feature is *"Matrix view where each
 * empty cell is a prompt for a new idea"*, and this is the component that has
 * to mean it. A grid that only reported counts would have drawn the same
 * numbers and missed the product.
 *
 * ## It is a link first and a dialog second
 *
 * The element really is an `<a href="/capture?…">` carrying the channel and
 * both bucket ids, so it works with no JavaScript at all, opens in a new tab on
 * a middle-click, and can be copied as a link — the same reasoning
 * `components/video-sections/section-nav.tsx` gives for the section tabs, and
 * the same as `/capture` already being a route a phone can bookmark.
 *
 * A plain left-click is intercepted and opens the capture box *here* instead,
 * because the job is "fill the hole and carry on reading the grid": leaving the
 * page for a full-screen form and coming back would lose the place. Modified
 * clicks are left alone.
 *
 * ## The channel cannot be retargeted from here
 *
 * `CaptureForm` is given exactly one channel — this one. The two bucket ids are
 * this channel's, and the composite foreign key in `0001_init.sql` binds a
 * video's bucket to its own channel and axis, so a capture retargeted with
 * `1`..`9` would be refused by the database. Offering the choice and then
 * refusing it would be worse than not offering it; the modal says which channel
 * it is filing into, and the sidebar's chips are where a channel gets changed.
 */
export function CaptureCell({
  channel,
  vertical,
  horizontal,
  href,
}: {
  channel: { id: string; name: string; slug: string };
  vertical: { id: string; name: string };
  horizontal: { id: string; name: string };
  /** `/capture?…`, built by the server so both halves agree on the query. */
  href: string;
}) {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const toast = useToast();

  // What the cell is *for*, in words — the accessible name of the control and
  // the tooltip, so the invitation is not carried by a dashed border alone.
  const prompt = `Add a ${vertical.name} ${horizontal.name} idea`;

  return (
    <>
      <a
        href={href}
        title={`${prompt} — nothing here yet.`}
        data-testid="matrix-cell"
        data-empty="true"
        data-vertical={vertical.name}
        data-horizontal={horizontal.name}
        data-count="0"
        onClick={(event) => {
          // Middle-click, Ctrl/Cmd-click, Shift-click: the browser's job.
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
          returnFocus.current =
            event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
          setOpen(true);
        }}
        className="group flex h-full min-h-[58px] w-full items-center justify-center rounded-card border border-dashed border-border text-muted outline-none transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* The plus is the whole of the resting state: forty invitations
            shouting "New idea" would be forty things competing for attention on
            a page whose point is that the *gaps* are quiet. It grows a word on
            hover and on focus, and the accessible name carries the sentence
            either way. */}
        <span
          aria-hidden="true"
          className="text-[15px] leading-none group-hover:hidden group-focus-visible:hidden"
        >
          +
        </span>
        <span
          aria-hidden="true"
          className="hidden text-[11px] leading-none group-hover:inline group-focus-visible:inline"
        >
          New idea
        </span>
        <span className="sr-only">{prompt}</span>
      </a>

      {open ? (
        <Modal
          title={prompt}
          testId="matrix-capture"
          returnFocusRef={returnFocus}
          onClose={() => setOpen(false)}
        >
          <CaptureForm
            channels={[channel]}
            initialChannelId={channel.id}
            preferLastUsed={false}
            variant="modal"
            prefill={{
              verticalId: vertical.id,
              verticalName: vertical.name,
              horizontalId: horizontal.id,
              horizontalName: horizontal.name,
            }}
            onSaved={(saved) => {
              setOpen(false);
              toast.push({
                message: `Captured “${saved.title}” as ${vertical.name} · ${horizontal.name}.`,
              });
              // The cell this was captured into is no longer empty, and the
              // grid is server-rendered: without this the hole stays drawn
              // until something else happens to reload the route.
              router.refresh();
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}
