"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { settingsPath } from "@/components/settings/settings-nav";
import {
  readShortcutSheet,
  usePendingSequence,
  useShortcuts,
  type SheetGroup,
  type Shortcut,
} from "@/lib/shortcuts";

import { ChannelShortcuts, type ShortcutChannel } from "./channel-shortcuts";
import { Cap } from "./keys";
import { ShortcutSheet } from "./sheet";

/**
 * Every key that belongs to the application rather than to one page:
 * `g` then a letter to go somewhere, `1`..`9` for a channel, and `?` for the
 * sheet that lists the rest.
 *
 * Mounted once, by the sidebar, at every width — the same reason `c` lives
 * there: it is the one component every signed-in route renders, and it already
 * knows the channel list and which channel the route is about. It draws
 * nothing in the page's flow: the sheet is a portal, and the sequence
 * indicator is fixed to the bottom of the viewport.
 *
 * ## `g` then the first letter of the place
 *
 * | Keys  | Goes to                      |
 * |-------|------------------------------|
 * | `g n` | Now                          |
 * | `g b` | this channel's board         |
 * | `g i` | this channel's idea bank     |
 * | `g c` | the calendar                 |
 * | `g s` | this channel's settings      |
 *
 * One rule — the initial of the sidebar row — instead of five keys to learn.
 * PLAN.md wrote `g k` for the calendar, presumably because `c` is capture; but
 * after `g` the registry reads the next key as a destination and nothing else
 * (see "Two-key sequences" in `lib/shortcuts.ts`), so `g c` cannot open
 * capture, and the rule survives without an exception. Recorded as a
 * deviation in `docs/MILESTONES.md`.
 *
 * "This channel" is the route's channel, or the first — `boardSlug` is exactly
 * what the sidebar's Board row links to, so the key and the row cannot
 * disagree. Board, Ideas and Settings are not bound on an account with no
 * channel, for the same reason those rows are disabled.
 */
export function KeyboardShortcuts({
  channels,
  boardSlug,
}: {
  channels: readonly ShortcutChannel[];
  /** The channel the Board, Ideas and Settings rows point at, if any. */
  boardSlug: string | undefined;
}) {
  const [sheet, setSheet] = useState<readonly SheetGroup[] | null>(null);
  /** Recorded when the sheet is asked for, as `CaptureHost` does and why. */
  const returnFocus = useRef<HTMLElement | null>(null);

  const openSheet = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Read *before* the sheet mounts: its modal silences the page, and the
    // page's bindings are what the sheet is about.
    setSheet(readShortcutSheet());
  }, []);

  // The hint bar's "all keys" button opens the same sheet.
  useEffect(() => {
    sheetOpener = openSheet;
    return () => {
      if (sheetOpener === openSheet) sheetOpener = null;
    };
  }, [openSheet]);

  useShortcuts(
    useMemo<Shortcut[]>(
      () => [
        {
          key: "?",
          description: "Show the keyboard shortcuts",
          run: (event) => {
            event.preventDefault();
            openSheet();
          },
        },
      ],
      [openSheet],
    ),
  );

  return (
    <>
      <GoTo boardSlug={boardSlug} />
      <ChannelShortcuts channels={channels} />
      <SequenceIndicator />
      {sheet !== null ? (
        <ShortcutSheet
          groups={sheet}
          boardSlug={boardSlug}
          channelCount={channels.length}
          returnFocusRef={returnFocus}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

/** Set while a `KeyboardShortcuts` is mounted. */
let sheetOpener: (() => void) | null = null;

/** Open the `?` sheet from a control — the hint bar's button. */
export function openShortcutSheet(): void {
  sheetOpener?.();
}

function GoTo({ boardSlug }: { boardSlug: string | undefined }) {
  const router = useRouter();

  const shortcuts = useMemo<Shortcut[]>(() => {
    const places: { letter: string; name: string; path: string | null }[] = [
      { letter: "n", name: "Now", path: "/now" },
      {
        letter: "b",
        name: "Board",
        path: boardSlug === undefined ? null : `/c/${encodeURIComponent(boardSlug)}/board`,
      },
      {
        letter: "i",
        name: "Ideas",
        path: boardSlug === undefined ? null : `/c/${encodeURIComponent(boardSlug)}/ideas`,
      },
      { letter: "c", name: "Calendar", path: "/calendar" },
      {
        letter: "s",
        name: "Settings",
        path: boardSlug === undefined ? null : settingsPath("stages", boardSlug),
      },
    ];

    return places
      .filter((place) => place.path !== null)
      .map((place) => ({
        key: `g ${place.letter}`,
        description: `Go to ${place.name}`,
        hint: {
          keys: `g ${place.letter}`,
          text: place.name,
          label: `Go to ${place.name}`,
          bar: false,
        },
        run: () => {
          const path = place.path!;
          // Read from the document, not a prop: see `ChannelShortcuts`.
          if (window.location.pathname === path) return;
          router.push(path);
        },
      }));
  }, [boardSlug, router]);

  useShortcuts(shortcuts, { group: "Get around" });
  return null;
}

/**
 * What `g` is waiting for, drawn while it waits.
 *
 * A sequence nobody can see is a key that seems to do nothing, and then a
 * second key that seems to do the wrong thing. So for the second and a half an
 * armed `g` lasts, a small bar at the bottom of the screen lists where the next
 * key goes. It is a live region, so a screen reader hears the same list.
 */
function SequenceIndicator() {
  const { prefix, steps } = usePendingSequence();

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
    >
      {prefix !== null && steps.length > 0 ? (
        <div
          data-testid="shortcut-sequence"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-border bg-surface px-3 py-2 text-[12px] text-foreground shadow-lg"
        >
          <span className="text-muted">
            <Cap>{prefix}</Cap> <span className="ml-0.5">then</span>
          </span>
          {steps.map((step) => (
            <span key={step.key} className="inline-flex items-center gap-1.5">
              <Cap>{step.key}</Cap>
              {step.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
