"use client";

import { useShortcutHints } from "@/lib/shortcuts";

/**
 * The keys that work *here*, read off the shortcut registry.
 *
 * Discoverability is the whole point: a keyboard-first board whose keys are
 * only written down in a plan is a board with no keyboard. The full `?` cheat
 * sheet is M9; this is the part that cannot wait, and because it is derived
 * from the live registrations rather than typed out by hand it cannot
 * advertise a key that is not bound on this route — the board's `j`/`k`/`[`/`]`
 * simply disappear from it on `/videos/[id]`, and `1–9` only appears when there
 * is a second channel to switch to.
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
    </p>
  );
}
