"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { useShortcuts, type Shortcut } from "@/lib/shortcuts";

/**
 * `1`..`9` — switch channel (PLAN.md's "Shortcuts": *`1..9` switch channel*).
 *
 * Mounted by the header, which is the one component that always knows the
 * channel list, so the digits work on every signed-in route rather than only on
 * a board. The nth digit goes to the nth channel's board, in the same order the
 * header draws the chips and the capture form numbers them — one order for the
 * whole application, so "channel 2" means one thing.
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
  currentSlug,
}: {
  channels: readonly ShortcutChannel[];
  currentSlug?: string;
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
          if (channel.slug === currentSlug) return;
          event.preventDefault();
          router.push(`/c/${channel.slug}/board`);
        },
      })),
    [channels, currentSlug, router],
  );

  useShortcuts(shortcuts, { enabled: channels.length > 1 });

  return null;
}
