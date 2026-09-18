"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import {
  PREVIEW_FACES,
  TEXT_RENDERING,
  YOUTUBE_FONT_VAR,
  type TitleBox,
} from "./metrics";

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
  /**
   * Characters the clamp would cut, counted the way a person counts them.
   *
   * **Graphemes, not UTF-16 code units.** `"😀".length` is 2 and
   * `"👨‍👩‍👧‍👦".length` is 11, so a warning reading "33 characters cut" was
   * reporting a tail of one space and sixteen emoji. `Intl.Segmenter` is built
   * into every browser this app supports and adds no dependency; `Array.from`
   * (code points) is the fallback where it is not, which is right for emoji and
   * only wrong for a ZWJ sequence.
   */
  readonly cut: number;
  /** Would the browser draw an ellipsis here? */
  readonly truncated: boolean;
}

/**
 * A string as a list of things a person would call characters.
 *
 * Grapheme clusters where `Intl.Segmenter` exists, code points otherwise. This
 * is what the binary search steps over and what the cut is counted in, and both
 * of those used to be UTF-16 code units:
 *
 * - The **search** could land between the two halves of a surrogate pair, so
 *   `text.slice(0, low)` ended in a lone high surrogate and the browser drew
 *   U+FFFD. The truncation warning then rendered the visible prefix and the
 *   remainder separately, which split one emoji into two replacement glyphs,
 *   one on each side of the ellipsis. Reproduced on six different emoji at the
 *   same pad length, so it was alignment and not luck.
 * - The **count** double-counted every astral character.
 *
 * Segmenting also means a family emoji or a flag is never cut in half through
 * its joiners, which code points alone would not prevent.
 */
function units(text: string): string[] {
  const Segmenter = (
    Intl as unknown as { Segmenter?: typeof Intl.Segmenter }
  ).Segmenter;
  if (typeof Segmenter === "function") {
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (
      part,
    ) => part.segment);
  }
  return Array.from(text);
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
    // The same four properties the drawn title pins, for the same reason: a
    // measurement taken with the application's `-webkit-font-smoothing:
    // antialiased` in force would be a measurement of slightly lighter text
    // than the preview paints. `TEXT_RENDERING` is the one place they are
    // decided.
    ...TEXT_RENDERING,
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
  // Longhands rather than the `font` shorthand: the family is reached through a
  // custom property (`var(--font-face-youtube)`, whose real name is a build-time
  // hash), and the shorthand also *resets* every font longhand it does not
  // mention — including the smoothing pinned above.
  node.style.fontWeight = String(box.fontWeight);
  node.style.fontSize = `${box.fontSize}px`;
  node.style.lineHeight = `${box.lineHeight}px`;
  node.style.fontFamily = box.fontFamily;

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

  /*
    The longest prefix that still fits with an ellipsis after it.

    Chrome's own line clamp fits the ellipsis inside the last line's width, so
    it is part of what is measured rather than something added afterwards.

    The search steps over **graphemes** and not code units — see `units`. A
    midpoint in the middle of a surrogate pair produced a prefix ending in half
    a character, which the browser drew as U+FFFD in the title and which the
    truncation warning then split across its own ellipsis.
  */
  const parts = units(text);
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    node.textContent = `${parts.slice(0, middle).join("").trimEnd()}${ELLIPSIS}`;
    if (node.scrollHeight <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const visible = parts.slice(0, low).join("").trimEnd();
  // Counted in the same units the search used, so "N characters cut" is a
  // number a person could arrive at by looking at the tail.
  return {
    text,
    visible,
    cut: parts.length - units(visible).length,
    truncated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Re-measuring when the face arrives                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every measurement taken before Roboto loads was taken in a fallback face, and
 * is wrong the moment the real one arrives. This settles once and bumps every
 * hook below, so each clamp on the page is recomputed exactly once more.
 *
 * ## Why `document.fonts.ready` is not enough on its own
 *
 * `ready` answers "nothing is loading *right now*". The preview is inside a
 * section panel on a page that has already loaded its own three faces, so by
 * the time it mounts `ready` may well be an already-resolved promise — and a
 * promise that resolved before Roboto was ever asked for says nothing about
 * Roboto.
 *
 * So the load is *requested by name* first. `document.fonts.load()` takes a
 * font shorthand and fetches the face it selects, which is why
 * `PREVIEW_FACES` lists both weights: asking for 400 does not bring 500, and
 * a search title measured in a synthesised bold-of-400 is not a search title.
 *
 * The concrete family is read off the document, because `next/font` decides at
 * build time what the generated `@font-face` is called and nothing in the
 * source knows it. If the variable is not there — the stylesheet has not
 * applied, or
 * someone removed the face — this falls back to plain `ready`, which is what
 * the code did before and is still better than never re-measuring.
 */
let fontsReady = false;
const listeners = new Set<() => void>();

/**
 * The real family name behind `--font-face-youtube`, or `null` if the document
 * does not have one.
 */
function resolvedFamily(): string | null {
  const root = document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(YOUTUBE_FONT_VAR).trim();
  return value === "" ? null : value;
}

function settle(): void {
  fontsReady = true;
  for (const listener of listeners) listener();
}

function watchFonts(): void {
  if (fontsReady || typeof document === "undefined") return;
  const fonts = document.fonts;
  if (!fonts) {
    // No Font Loading API: whatever the first measurement saw is all there is.
    fontsReady = true;
    return;
  }

  const family = resolvedFamily();
  const requested =
    family === null
      ? []
      : PREVIEW_FACES.map((face) =>
          // A rejection here is a face that will never arrive, which is a
          // reason to stop waiting rather than a reason to throw.
          fonts.load(`${face.weight} ${face.size}px ${family}`).catch(() => []),
        );

  void Promise.all(requested)
    // `ready` after the explicit loads, not instead of them: it also covers the
    // application's own three faces, which share the page's layout.
    .then(() => fonts.ready)
    .then(settle, settle);
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
