"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import type { TitleBox } from "./metrics";

/**
 * Where a title stops fitting — measured by laying it out, not guessed from a
 * character count.
 *
 * ## Why not "titles are cut after N characters"
 *
 * Because they are not. YouTube clamps its titles with `-webkit-line-clamp: 2`,
 * which is a *layout* rule: the cut happens where the third line would start,
 * and that depends on the width of the box, the size and weight of the face,
 * and — this is the part a character count can never model — where the words
 * break. "Illinois' iii" and "MMM WWW MMM" are the same length and nowhere near
 * the same width. A 60-character rule of thumb is wrong in both directions
 * several times a day, and a warning that is wrong is worse than no warning,
 * because it is the one thing on the page claiming to know something the user
 * cannot see.
 *
 * So this lays the string out in a real element, at the real width, in the real
 * type, and binary-searches for the longest prefix that still fits in two lines
 * with an ellipsis after it — which is exactly what the browser does to draw
 * the clamp. The number the warning quotes and the ellipsis the preview draws
 * therefore come from the same place.
 *
 * ## Where the measuring element lives
 *
 * Appended to `document.body`, not rendered into the React tree, and for a
 * reason that is easy to hit: the preview sits inside a section panel, and an
 * inactive panel is `display: none`. Every descendant of a `display: none`
 * element measures as zero, so a measurer rendered beside the thing it measures
 * would silently answer "nothing fits" the moment the user switched tabs. On
 * the body it is always laid out, and it is one element for the whole page
 * rather than one per title.
 *
 * It is `visibility: hidden` and parked off-screen rather than `display: none`,
 * because `display: none` is exactly the state that does not lay out.
 */

/** What laying a string out in a `TitleBox` produced. */
export interface Clamp {
  /** The whole string, as passed in. */
  readonly text: string;
  /** What fits — the string itself when it fits, otherwise the visible prefix. */
  readonly visible: string;
  /** Characters the clamp would cut. Zero when the whole title fits. */
  readonly cut: number;
  /** Would the browser draw an ellipsis here? */
  readonly truncated: boolean;
}

/** The whole string fits: the answer for an empty box or an empty string. */
function whole(text: string): Clamp {
  return { text, visible: text, cut: 0, truncated: false };
}

/** The character the clamp ends a cut line with, and the one this file searches with. */
const ELLIPSIS = "…";

/* -------------------------------------------------------------------------- */
/* The measuring element                                                       */
/* -------------------------------------------------------------------------- */

let element: HTMLDivElement | null = null;

function measurer(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (element?.isConnected) return element;

  const node = document.createElement("div");
  node.setAttribute("aria-hidden", "true");
  node.dataset.ytMeasure = "";
  Object.assign(node.style, {
    position: "fixed",
    top: "0px",
    left: "-10000px",
    visibility: "hidden",
    pointerEvents: "none",
    // The wrapping rules a title box has. `overflow-wrap: break-word` is what
    // stops one 300-character word from measuring as a single unbreakable line
    // — the same thing the real box does.
    whiteSpace: "normal",
    overflowWrap: "break-word",
    wordBreak: "normal",
    margin: "0px",
    padding: "0px",
    border: "0px",
    letterSpacing: "normal",
  });

  document.body.append(node);
  element = node;
  return node;
}

/**
 * The clamp for one string, or `null` when there is no DOM to measure in
 * (server rendering, and the first render in the browser so the two agree).
 */
export function measureClamp(text: string, box: TitleBox): Clamp | null {
  const node = measurer();
  if (node === null) return null;
  if (text === "") return whole(text);

  node.style.width = `${box.width}px`;
  node.style.font = `${box.fontWeight} ${box.fontSize}px/${box.lineHeight}px ${box.fontFamily}`;

  // Half a line of slack: `scrollHeight` is an integer and a fractional line
  // box would otherwise round a two-line height up past the limit.
  const limit = box.lines * box.lineHeight + box.lineHeight / 2;

  node.textContent = text;
  const full = node.scrollHeight;

  // Zero means this element is not being laid out at all — a detached body
  // during a teardown, say. Reporting "everything is cut" from that would be a
  // confident lie, so report nothing instead.
  if (full === 0) return null;
  if (full <= limit) return whole(text);

  // The longest prefix that still fits with an ellipsis after it. Chrome's own
  // line clamp fits the ellipsis inside the last line's width, so it is part of
  // what is measured rather than something added afterwards.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    node.textContent = `${text.slice(0, middle).trimEnd()}${ELLIPSIS}`;
    if (node.scrollHeight <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const visible = text.slice(0, low).trimEnd();
  return { text, visible, cut: text.length - visible.length, truncated: true };
}

/* -------------------------------------------------------------------------- */
/* Re-measuring when the face arrives                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every measurement taken before the face loads was taken in the fallback one,
 * and is wrong the moment the real one arrives. `document.fonts.ready` settles
 * once; this bumps every hook below, so each clamp on the page is recomputed
 * exactly once more.
 */
let fontsReady = false;
const listeners = new Set<() => void>();

function watchFonts(): void {
  if (fontsReady || typeof document === "undefined") return;
  const fonts = document.fonts;
  if (!fonts) {
    fontsReady = true;
    return;
  }
  void fonts.ready.then(() => {
    fontsReady = true;
    for (const listener of listeners) listener();
  });
}

/**
 * Whether the faces have settled, read as what it is: a value owned by the
 * document rather than by React.
 *
 * `useSyncExternalStore` and not `useState` + `useEffect` — this is the exact
 * shape that primitive exists for (subscribe, read the current value, and a
 * server snapshot that is deliberately `false` so the server and the first
 * client render agree). It also keeps the rule against setting state inside an
 * effect satisfied honestly rather than by suppression.
 */
function subscribeToFonts(onChange: () => void): () => void {
  watchFonts();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function useFontsReady(): boolean {
  return useSyncExternalStore(
    subscribeToFonts,
    () => fontsReady,
    () => false,
  );
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `null` until the browser has measured.
 *
 * The first client render deliberately measures nothing, so it produces the
 * markup the server did and hydration has nothing to reconcile. The measurement
 * then happens in a layout effect — before the browser paints — so nothing
 * flashes: what is painted is already the measured answer.
 */
export function useClamp(text: string, box: TitleBox): Clamp | null {
  const clamps = useClamps([text], box);
  return clamps[0] ?? null;
}

/** The same, for a list — one measuring element, one pass, one render. */
export function useClamps(
  texts: readonly string[],
  box: TitleBox,
): readonly (Clamp | null)[] {
  const [clamps, setClamps] = useState<readonly (Clamp | null)[]>(() =>
    texts.map(() => null),
  );
  const fonts = useFontsReady();

  // The dependency is the *content*, not the array's identity: this is called
  // with a freshly mapped array on every keystroke of a title.
  // `JSON.stringify` rather than a join on some separator: a separator is
  // only unambiguous until a title contains it, and a title can contain
  // anything at all.
  const key = JSON.stringify(texts);

  /*
    Measuring is the one thing that genuinely cannot happen during render: it
    needs a laid-out DOM, and render has to produce the same output on the
    server, where there is none. A layout effect is where React itself puts
    measurement, and the state it writes is the measurement's *result* — not a
    copy of a prop, and not a cascade: `sameClamps` returns the previous array
    whenever nothing moved, so a re-render with the same titles queues no second
    render at all.
  */
  useLayoutEffect(() => {
    const next = texts.map((text) => measureClamp(text, box));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setClamps((previous) => (sameClamps(previous, next) ? previous : next));
    // `texts` is covered by `key`; `box` is a module-level constant object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, box, fonts]);

  return clamps;
}

function sameClamps(
  a: readonly (Clamp | null)[],
  b: readonly (Clamp | null)[],
): boolean {
  return (
    a.length === b.length &&
    a.every((left, index) => {
      const right = b[index];
      if (left === null || right === null) return left === right;
      return left.text === right.text && left.cut === right.cut;
    })
  );
}
