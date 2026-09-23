"use client";

import { useShortcutHints } from "@/lib/shortcuts";

import { openShortcutSheet } from "./keyboard-shortcuts";

/**
 * The keys that work *here*, read off the shortcut registry — and the way to
 * the rest.
 *
 * Discoverability is the whole point: a keyboard-first board whose keys are
 * only written down in a plan is a board with no keyboard. Because it is
 * derived from the live registrations rather than typed out by hand it cannot
 * advertise a key that is not bound on this route — the board's `j`/`k`/`[`/`]`
 * simply disappear from it on `/videos/[id]`, and `1–9` only appears when there
 * is a second channel to switch to.
 *
 * M1's review asked whether the `?` sheet would make this bar redundant. It
 * does not, and M9 kept both: the bar is what someone who has never pressed `?`
 * sees, and its last item is the button that opens the sheet — which is how a
 * mouse user finds the keyboard at all. What changed is that the bar no longer
 * tries to be complete. The `g` sequences, `/` and Escape are on the sheet
 * only (`hint.bar: false`), so the bar stays the handful of keys nobody would
 * guess.
 *
 * It renders nothing on the server and nothing on the first client render:
 * bindings register in effects, so an empty first paint is what makes this
 * match the server's HTML exactly.
 */
export function ShortcutHints() {
  const hints = useShortcutHints();

  if (hints.length === 0) return null;

  return (
    <p
      data-testid="shortcut-hints"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-muted"
    >
      <span className="sr-only">Keyboard shortcuts on this page:</span>
      {hints.map((shortcut) => (
        <span key={shortcut.hint!.keys} className="whitespace-nowrap">
          {/* A shortcut key is something the tool measured out for you, so it
              is drawn in the mono face — the same face as counts and ages. */}
          <kbd className="rounded-button border border-border px-1 font-mono text-[10px]">
            {shortcut.hint!.keys}
          </kbd>{" "}
          {shortcut.hint!.text}
        </span>
      ))}
      <button
        type="button"
        data-testid="shortcut-sheet-open"
        aria-keyshortcuts="?"
        onClick={openShortcutSheet}
        className="whitespace-nowrap rounded-button text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
      >
        <kbd className="rounded-button border border-border px-1 font-mono text-[10px]">
          ?
        </kbd>{" "}
        all keys
      </button>
    </p>
  );
}
