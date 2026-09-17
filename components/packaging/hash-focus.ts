"use client";

import { useEffect, useState } from "react";

/**
 * Following a link into a field, and landing *in* it.
 *
 * The board's gate refusal links at `/videos/<id>#packaging-title` and
 * `#packaging-skip` (PLAN.md: *a "Fix packaging" link (detail scrolled to that
 * field) and a "Skip gate…" link*). A browser's own fragment handling scrolls
 * the element into view and stops there, which for a text field means the
 * person arrives looking at the box they were sent to and still has to click
 * it. On a phone that is a second gesture and a lost keyboard; on a long page
 * it is not even obvious which of the visible fields was meant.
 *
 * So the anchors name focusable controls (`GATE_ANCHOR` / `SKIP_ANCHOR` in
 * `lib/packaging.ts`) and this puts the caret in them.
 */

export interface HashTarget {
  /** The fragment, without the `#`. */
  readonly id: string;
  /**
   * Bumped on every hash event, so a component can tell "the same anchor,
   * asked for again" from "a re-render". Without it, arriving at
   * `#packaging-skip` twice in one session would be indistinguishable from not
   * arriving at all.
   */
  readonly nonce: number;
}

/**
 * The current fragment, as of mount and of every `hashchange`.
 *
 * Read in an effect rather than during render: `window` does not exist while
 * this is server-rendered, and a value that differs between the two renders is
 * a hydration mismatch. The first paint therefore has no target and the focus
 * happens immediately afterwards, which is the correct order anyway — the
 * element has to be in the document before it can be focused.
 */
export function useHashTarget(): HashTarget | null {
  const [target, setTarget] = useState<HashTarget | null>(null);

  useEffect(() => {
    let nonce = 0;

    function read(): void {
      const raw = window.location.hash.slice(1);
      nonce += 1;
      if (raw === "") {
        setTarget(null);
        return;
      }
      // A fragment arrives percent-encoded when it came from a typed URL.
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        // A malformed escape is not an anchor; use it verbatim and let
        // `getElementById` find nothing.
      }
      setTarget({ id, nonce });
    }

    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  return target;
}

/**
 * Put the caret in this control and bring it into view.
 *
 * `scrollIntoView` first and `preventScroll` on the focus, so the element lands
 * in the middle of the viewport rather than wherever the browser's own
 * "scroll the focused thing into view" minimally puts it — usually hard against
 * the top or bottom edge, with the label off screen.
 */
export function focusAnchor(element: HTMLElement | null): void {
  if (!element) return;
  element.scrollIntoView({ block: "center" });
  element.focus({ preventScroll: true });
}

/** `focusAnchor` on whatever carries this `id`, if anything does. */
export function focusAnchorId(id: string): void {
  focusAnchor(document.getElementById(id));
}
