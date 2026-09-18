"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { useShortcuts, type Shortcut } from "@/lib/shortcuts";

/**
 * `1`..`9` — switch channel (PLAN.md's "Shortcuts": *`1..9` switch channel*).
 *
 * Mounted by the sidebar, which is the one component that always knows the
 * channel list, so the digits work on every signed-in route rather than only on
 * a board. The nth digit goes to the nth channel's board, in the same order the
 * sidebar draws the rows and the capture form numbers them — one order for the
 * whole application, so "channel 2" means one thing.
 *
 * It deliberately takes no "current channel" prop: the only question it asks
 * about the current route is "am I already on this board", and the answer to
 * that has to come from the document rather than from a prop captured at the
 * last render — see `run` below.
 *
 * ## Where the digits are *not* a channel switch
 *
 * - **While typing.** The registry never fires a binding from an input, a
 *   textarea or anything contenteditable, so a digit typed into a title is a
 *   digit.
 * - **While the capture modal is open.** The dialog registers an exclusive
 *   scope, so this registration is inert; inside the modal a digit retargets
 *   the capture instead, which is the same idea aimed at the thing in front of
 *   you.
 * - **With one channel.** Nothing to switch to, so nothing is bound and the
 *   hint bar does not advertise it.
 */
export interface ShortcutChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export function ChannelShortcuts({
  channels,
}: {
  channels: readonly ShortcutChannel[];
}) {
  const router = useRouter();

  const shortcuts = useMemo<Shortcut[]>(
    () =>
      channels.slice(0, 9).map((channel, index) => ({
        key: String(index + 1),
        description: `Switch to ${channel.name}`,
        // One hint for the whole run of digits, carried by the first.
        hint:
          index === 0
            ? { keys: channels.length > 1 ? "1–9" : "1", text: "switch channel" }
            : undefined,
        run: (event: KeyboardEvent) => {
          const target = `/c/${channel.slug}/board`;
          /*
            "Am I already there?" is asked of the *document*, not of the
            `currentSlug` prop this closure captured.

            The two disagree for as long as a client-side navigation takes.
            Press 2, then press 1 before channel 2's board has finished
            rendering, and the registration still mounted is the one from
            channel 1's page — whose `currentSlug` is still "1", so the key
            that should take you back does nothing at all and the board stays
            where it was. `window.location.pathname` has already changed by
            then, because `router.push` updates the URL first.

            Same reasoning as the board's in-flight guard reading a ref rather
            than state: a handler that fires between renders has to read
            something that is current between renders.
          */
          if (window.location.pathname === target) return;
          event.preventDefault();
          router.push(target);
        },
      })),
    [channels, router],
  );

  useShortcuts(shortcuts, { enabled: channels.length > 1 });

  return null;
}
