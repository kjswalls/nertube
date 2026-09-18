"use client";

import { useEffect } from "react";

/**
 * Move the reading position into the drill-down panel when a cell opens it.
 *
 * ## Why this is not simply the `#cell` fragment
 *
 * The cell's href does end in `#cell`, and that is what scrolls the panel into
 * view. A *browser* fragment navigation also focuses the target, which is the
 * half that matters — without it the newly revealed content is an entire grid
 * away in the tab order (measured at 24 tab stops on a three-pillar channel;
 * BRIEF.md allows five pillars by twelve formats). Next's client router scrolls
 * to the fragment but does not reliably focus it, so this does that part.
 *
 * ## Why it does not steal focus
 *
 * It moves focus only when focus is currently **on a matrix cell** — which is
 * exactly the case after a cell has been clicked or activated with Enter, and
 * is exactly not the case on a cold load of a pasted `?cell=` link, where the
 * page must open where the person put it and leave their focus alone.
 *
 * Rendered by `cell-panel.tsx` with the cell's key, so switching from one cell
 * to another re-runs it: the panel is the same element in the same place, and
 * only the key says it is now about something else.
 */
export function FocusPanel({ cellKey }: { cellKey: string }) {
  useEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.dataset.testid !== "matrix-cell") return;
    document.getElementById("cell")?.focus();
  }, [cellKey]);

  return null;
}
