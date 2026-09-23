"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

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

/**
 * Where the caret goes after a row is removed: the next row's field, or the
 * add box when the list is empty. Shared by the title candidates and the
 * hooks, which each used to hold a copy.
 *
 * The request is kept until the button that was pressed has actually left
 * the document (M10 review). The effect runs after every render, and the old
 * copies consumed the request on the first render after the click — if any
 * render landed before the one that removed the row (the save queue's own
 * state, under load), the button was still there and focused, the effect
 * stood down and threw the request away, and the removal render then left
 * focus on `<body>`. That is the most likely cause of `m2-review`'s "focus
 * after removing a hook row" failure, recorded since M5 as load and never
 * explained; it is inferred from the code, not observed in a trace.
 */
export function useFocusAfterRemove(
  fallback: RefObject<HTMLElement | null>,
): (targetId: string | null, pressed: HTMLElement) => void {
  const pending = useRef<{ targetId: string | null; pressed: HTMLElement } | null>(null);
  useEffect(() => {
    const request = pending.current;
    if (request === null) return;
    // Not removed yet: this render is some other update. Keep waiting.
    if (request.pressed.isConnected) return;
    pending.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    focusAnchor(
      request.targetId === null ? fallback.current : document.getElementById(request.targetId),
    );
  });
  return useCallback((targetId: string | null, pressed: HTMLElement) => {
    pending.current = { targetId, pressed };
  }, []);
}
