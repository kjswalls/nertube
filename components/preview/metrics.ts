/**
 * The YouTube layout metrics — every number the preview draws with, in one
 * place.
 *
 * ## Where these came from, and how to correct them
 *
 * They are **transcribed layout metrics, not a copy of YouTube's stylesheet and
 * not the result of fetching the site.** This repository is developed with no
 * egress to youtube.com, so nothing here was measured against a live page in
 * this session: every value below is written down with what it represents, so
 * that anyone with the real page open can compare one number at a time and
 * correct it here — and the three renderings, the truncation warning and the
 * e2e assertions all move together, because they all read this object.
 *
 * YouTube's own CSS is authored with `html { font-size: 10px }`, so its
 * `1.6rem` is 16px. Everything below is already in px.
 *
 * ## What is deliberately *not* here
 *
 * No logo, wordmark, play button, brand colour or any other asset of theirs.
 * This is a layout mock — boxes at the real sizes with the real type scale —
 * whose entire job is to answer two questions honestly: *where does my title
 * get cut*, and *does my thumbnail read at this size*. Anything that made it
 * look more like their product would not make it answer those any better.
 */

/**
 * The CSS custom property the real Roboto arrives on.
 *
 * `app/layout.tsx` asks `next/font/google` for Roboto at weights 400 and 500
 * and publishes it here, self-hosted, on `<html>`.
 *
 * What the variable actually resolves to in this version of Next is
 * `"Roboto", "Roboto Fallback"` — read out of the build with
 * `grep -rho -- "--font-face-youtube:[^;]*" .next`. The first is the family the
 * generated `@font-face` claims; the second is the metric-adjusted local
 * fallback `next/font` synthesises so the swap does not reflow. (Older notes
 * here said the name was a build-time hash such as `__Roboto_1a2b3c`. It is
 * not, and the difference matters below.)
 *
 * The stack still reaches it through the variable rather than by name, because
 * the variable is the one thing that is true whatever `next/font` decides to
 * call the family; and `measure-title.ts` resolves the variable at runtime for
 * the same reason, because `document.fonts.load()` needs a concrete family.
 */
export const YOUTUBE_FONT_VAR = "--font-face-youtube";

/**
 * The face YouTube sets titles in, with the fallbacks behind it.
 *
 * **This used to be the known weak point of the measurement, and is not any
 * more.** Until Roboto was loaded, the browser measured the first fallback it
 * had — Liberation Sans on this Linux box, Arial on Windows, Helvetica on a
 * Mac — and none of those is metrically compatible with Roboto. Roboto is
 * slightly narrower, so every clamp was reported a character or two early: the
 * warning said a title was cut when YouTube would have fitted it.
 *
 * The stack behind the variable is what is painted during `display: swap` — a
 * window `measure-title.ts` explicitly waits out before it trusts a
 * measurement.
 *
 * The bare `Roboto` that used to sit between the variable and those fallbacks
 * has been removed. It was justified as "what a machine that genuinely has
 * Roboto installed uses if the self-hosted file fails to fetch", and that
 * justification was wrong: the variable already resolves to `"Roboto", "Roboto
 * Fallback"`, so the literal named the same family the generated `@font-face`
 * claims and selected the same face. A locally installed Roboto is reached by
 * the first name in the variable, not by a second copy of it.
 */
export const YOUTUBE_FONT_STACK =
  `var(${YOUTUBE_FONT_VAR}), "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`;

/**
 * The weights the preview draws in, and the sizes it draws them at.
 *
 * `document.fonts.load()` takes a font *shorthand*, and it only fetches the
 * face that shorthand selects — asking for 400 does not bring 500. These are
 * the pairs `measure-title.ts` asks for before it trusts a clamp; they are
 * exactly the weights `app/layout.tsx` asks Google for.
 */
export const PREVIEW_FACES = [
  { weight: 400, size: 18 },
  { weight: 500, size: 16 },
] as const;

/**
 * Text rendering the preview turns *off* the application's setting for.
 *
 * `app/globals.css` puts `-webkit-font-smoothing: antialiased` on `<body>`,
 * which is a deliberate choice for the product's own faces and makes text
 * perceptibly lighter. YouTube sets no such rule, so its titles are drawn with
 * the platform default. Leaving the app's setting in place would make every
 * title in the preview a little thinner than the real one — a small thing that
 * is exactly the kind of small thing this component exists to get right.
 *
 * `letter-spacing` and `word-spacing` are pinned for a second reason: the
 * measuring element in `measure-title.ts` pins them too, and a drawn title that
 * inherited tracking the measured one did not would break the guarantee that
 * the two are the same computation.
 */
export const TEXT_RENDERING = {
  WebkitFontSmoothing: "auto",
  MozOsxFontSmoothing: "auto",
  letterSpacing: "normal",
  wordSpacing: "normal",
} as const;

/** Every title box is clamped to this many lines on every surface YouTube has. */
export const TITLE_LINES = 2;

/** 16:9, the only aspect a YouTube thumbnail is ever served at. */
export const THUMB_ASPECT = 16 / 9;

/**
 * The same ratio as a CSS value, which is how the thumbnails are actually
 * drawn.
 *
 * A browser given `aspect-ratio: 16 / 9` at width 360 lays out **202.5px**, and
 * at 390 it lays out 219.375. `thumbHeight` below rounds those to 203 and 219,
 * which are ratios of 1.7734 and 1.78082 rather than 1.77778 — so a preview
 * whose whole claim is "this is the shape your thumbnail is" was drawing a
 * shape it is not. The element gets the ratio; nothing rounds.
 */
export const THUMB_ASPECT_CSS = "16 / 9";

/**
 * The 16:9 height for a thumbnail of this width, **rounded to an integer**.
 *
 * An approximation, and only for the places that genuinely need a whole number
 * — reserving vertical space, or a test that wants one figure to compare. The
 * drawn boxes use `THUMB_ASPECT_CSS` and are fractional, because that is what
 * 16:9 is.
 */
export const thumbHeight = (width: number): number => Math.round(width / THUMB_ASPECT);

/**
 * A title box: everything needed to know where a string stops fitting.
 *
 * `measure-title.ts` lays a string out in exactly these terms, so "would be
 * cut" and "is drawn cut" are the same computation over the same numbers.
 */
export interface TitleBox {
  /** The width the title wraps inside, in px. */
  readonly width: number;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: number;
  /** Lines before `-webkit-line-clamp` ends it with an ellipsis. */
  readonly lines: number;
  readonly fontFamily: string;
}

/* -------------------------------------------------------------------------- */
/* The home feed card                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A card in the desktop home feed (`ytd-rich-item-renderer` →
 * `ytd-rich-grid-media`).
 *
 * This is the **tightest** of the three surfaces, which is why the truncation
 * warning is written against it: a title that survives the feed survives search.
 */
export const FEED = {
  /** The grid item's width. YouTube's rich grid sizes items at 310–360px; the card is drawn at the wide end. */
  cardWidth: 360,
  /** The thumbnail spans the card, at 16:9. */
  thumbWidth: 360,
  thumbHeight: thumbHeight(360),
  /** The rounding on the thumbnail's corners. */
  thumbRadius: 12,
  /** Gap between the thumbnail and the row of avatar + text below it. */
  detailsGap: 12,
  /** The channel avatar beside the title. */
  avatarSize: 36,
  /** Space between that avatar and the text column. */
  avatarGap: 12,
  /** The overflow (⋮) button's column, reserved at the right of the title row. */
  menuReserve: 24,
  /** Title type: Roboto Medium 16/22, clamped to two lines. */
  titleFontSize: 16,
  titleLineHeight: 22,
  titleWeight: 500,
  /** Channel name and the "views · age" line under it. */
  metaFontSize: 12,
  metaLineHeight: 18,
  metaWeight: 400,
  /** Gap between the title block and the channel line. */
  metaGap: 4,
  /** The duration chip in the thumbnail's bottom-right corner, and its inset. */
  chipFontSize: 12,
  chipInset: 8,
} as const;

/**
 * The box a feed title wraps in: the card, less the avatar column and the ⋮
 * button.
 *
 * **One gap, and exactly one**, because the row draws exactly one: the avatar
 * has `avatarGap` after it and the ⋮ column sits flush with the card's right
 * edge. This used to be laid out with a flex `gap`, which applies between
 * *every* pair of children, so the rendered row needed 36 + 12 + 288 + 12 + 24
 * = 372px inside a card declared to be 360 (`scrollWidth` 372 against
 * `clientWidth` 360, with the ⋮ column's right edge 12px outside the card).
 * One of the two documented numbers had to be false, and it was the one that
 * decides where a title is cut: a title that fitted 288 but not 276 was
 * measured as fitting and drawn into a card with no room for it.
 *
 * `e2e/preview.spec.ts` asserts the closure — `scrollWidth === clientWidth ===
 * FEED.cardWidth` — so the two cannot drift apart again.
 */
export const FEED_TITLE_BOX: TitleBox = {
  width: FEED.cardWidth - FEED.avatarSize - FEED.avatarGap - FEED.menuReserve,
  fontSize: FEED.titleFontSize,
  lineHeight: FEED.titleLineHeight,
  fontWeight: FEED.titleWeight,
  lines: TITLE_LINES,
  fontFamily: YOUTUBE_FONT_STACK,
};

/* -------------------------------------------------------------------------- */
/* The search result row                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A result on the desktop search page (`ytd-video-renderer`).
 *
 * Bigger type in a much wider column, so search cuts a title far later than the
 * feed does — which is the point of showing both.
 */
export const SEARCH = {
  thumbWidth: 360,
  thumbHeight: thumbHeight(360),
  thumbRadius: 12,
  /** Gap between the thumbnail and the text column. */
  thumbGap: 16,
  /** The text column's width on a typical desktop window. */
  textWidth: 600,
  /** Title type: Roboto Regular 18/26, clamped to two lines. */
  titleFontSize: 18,
  titleLineHeight: 26,
  titleWeight: 400,
  /** The "views · age" line, the channel line, and the description snippet. */
  metaFontSize: 12,
  metaLineHeight: 18,
  /** The small channel avatar on the byline row. */
  avatarSize: 24,
  avatarGap: 8,
  /** Vertical rhythm inside the text column. */
  rowGap: 6,
  chipFontSize: 12,
  chipInset: 8,
} as const;

/** The full width of a search row, thumbnail and text column together. */
export const SEARCH_ROW_WIDTH = SEARCH.thumbWidth + SEARCH.thumbGap + SEARCH.textWidth;

export const SEARCH_TITLE_BOX: TitleBox = {
  width: SEARCH.textWidth,
  fontSize: SEARCH.titleFontSize,
  lineHeight: SEARCH.titleLineHeight,
  fontWeight: SEARCH.titleWeight,
  lines: TITLE_LINES,
  fontFamily: YOUTUBE_FONT_STACK,
};

/* -------------------------------------------------------------------------- */
/* The phone tile                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A tile in the phone home feed, where the thumbnail is full-bleed and the
 * title sits under it at 14px.
 *
 * This is the surface the *thumbnail* is judged on: 390px wide is a modern
 * phone's logical viewport, so what is drawn here is the size the picture is
 * actually seen at. The preview stacks the video between two sample tiles for
 * exactly that reason — a concept only "reads" relative to what it is scrolled
 * past.
 */
export const PHONE = {
  /** A modern phone's logical viewport width; the feed is one column of it. */
  deviceWidth: 390,
  /** The thumbnail is edge to edge. */
  thumbWidth: 390,
  thumbHeight: thumbHeight(390),
  thumbRadius: 12,
  /** Padding around the text row under the thumbnail. */
  rowPaddingX: 12,
  rowPaddingY: 12,
  avatarSize: 36,
  avatarGap: 12,
  menuReserve: 24,
  /** Title type: Roboto Medium 14/20, clamped to two lines. */
  titleFontSize: 14,
  titleLineHeight: 20,
  titleWeight: 500,
  metaFontSize: 12,
  metaLineHeight: 16,
  metaGap: 2,
  /** Space between one tile and the next in the feed. */
  tileGap: 16,
  chipFontSize: 11,
  chipInset: 6,
} as const;

/**
 * The same arithmetic as `FEED_TITLE_BOX`, and the same one gap: the row draws
 * `avatarGap` after the avatar only, so the padded content box closes at
 * 12 + 36 + 12 + 294 + 24 + 12 = 390. With a flex `gap` it needed 378px of
 * content in a 366px box, and the 12px went out of the tile's right padding —
 * the ⋮ column ended up flush with the device edge, on a rendering whose entire
 * claim is that 390px is what a phone is.
 */
export const PHONE_TITLE_BOX: TitleBox = {
  width:
    PHONE.deviceWidth -
    PHONE.rowPaddingX * 2 -
    PHONE.avatarSize -
    PHONE.avatarGap -
    PHONE.menuReserve,
  fontSize: PHONE.titleFontSize,
  lineHeight: PHONE.titleLineHeight,
  fontWeight: PHONE.titleWeight,
  lines: TITLE_LINES,
  fontFamily: YOUTUBE_FONT_STACK,
};

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * YouTube's own text and surface tokens, in both of its themes.
 *
 * The preview does **not** use Moss & Sand here. Everything else in this
 * application is the product's palette; this one component is a picture of
 * somewhere else, and rendering their grey metadata line in our muted green
 * would quietly change the contrast the user is trying to judge. It follows
 * the app's light/dark choice — because that is a fair guess at the viewer's —
 * and nothing else about the app's colour.
 */
export interface YoutubePalette {
  readonly surface: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly placeholder: string;
  readonly placeholderText: string;
  readonly fill: string;
}

export const YOUTUBE_COLORS = {
  light: {
    surface: "#ffffff",
    textPrimary: "#0f0f0f",
    textSecondary: "#606060",
    /** The grey a thumbnail slot shows before an image is there. */
    placeholder: "#e5e5e5",
    placeholderText: "#909090",
    /** The avatar circle and other small filled shapes. */
    fill: "#d9d9d9",
  },
  dark: {
    surface: "#0f0f0f",
    textPrimary: "#f1f1f1",
    textSecondary: "#aaaaaa",
    placeholder: "#272727",
    placeholderText: "#717171",
    fill: "#373737",
  },
} as const satisfies Record<"light" | "dark", YoutubePalette>;

/**
 * The sample tiles the phone rendering scrolls past.
 *
 * Invented, generic, and no one's: two plausible neighbours, one with a title
 * long enough to clamp and one short, so the comparison covers both. They carry
 * sample view counts because a metadata line of the right length is part of the
 * layout being judged — they are not claims about any real video.
 */
export const SAMPLE_NEIGHBOURS = [
  {
    title: "I tried the thing everyone says you should try, for thirty days straight",
    channel: "Another channel",
    meta: "128K views · 3 days ago",
    duration: "14:02",
  },
  {
    title: "The five-minute version",
    channel: "Someone else",
    meta: "42K views · 1 week ago",
    duration: "5:31",
  },
] as const;

/**
 * The duration chip's text in every rendering.
 *
 * A placeholder, and it is drawn on purpose rather than left off: the chip
 * covers the thumbnail's bottom-right corner on every surface YouTube has, so a
 * concept whose subject lives in that corner is a concept that will be sat on.
 * That is a thing the preview exists to show.
 */
export const SAMPLE_DURATION = "10:24";

/**
 * The channel avatar's own metrics.
 *
 * YouTube draws the channel's picture here; this application does not have one
 * and would not invent one, so the disc carries the channel's initial — which
 * is YouTube's own fallback for a channel with no picture. These two numbers
 * were literals in the component, which is the drift this file exists to
 * prevent.
 */
export const AVATAR = {
  /** Roughly half the disc, which is where YouTube's own initial sits. */
  initialScale: 0.45,
  /** Roboto Medium, same as a title. */
  fontWeight: 500,
} as const;

/**
 * The empty thumbnail slot's label, and the ⋮ column's line box.
 *
 * Ours rather than YouTube's — they never draw an empty thumbnail — but they
 * are still numbers the preview draws with, and the rule in this file is that
 * those live here.
 */
export const PLACEHOLDER = {
  /** The "No concept sketch yet" label. */
  fontSize: 12,
  /** Keeps the label off the slot's edges at phone width. */
  padding: 8,
  /** The ⋮ column's line box, so the glyph sits on the title's first line. */
  menuLineHeight: 18,
  /** A neighbour tile is a touch back from the user's own. */
  sampleOpacity: 0.85,
} as const;

/**
 * The duration chip's own metrics (`ytd-thumbnail-overlay-time-status-renderer`).
 *
 * Its *size* is the same on every surface — only the type size and the inset
 * from the corner change, and those live on `FEED` / `SEARCH` / `PHONE`
 * beside the rest of that surface's numbers. Everything here was previously
 * inlined in the component, which is exactly the drift this file exists to
 * prevent.
 */
export const CHIP = {
  /** Vertical and horizontal padding inside the chip. */
  paddingY: 3,
  paddingX: 4,
  radius: 4,
  /** Roboto Medium, and a line box the height of the type. */
  fontWeight: 500,
  lineHeight: 12,
  /** The scrim behind it, which is the same black at the same alpha everywhere. */
  background: "rgba(0, 0, 0, 0.8)",
  /** Chip text is white on every YouTube theme, light or dark. */
  color: "#ffffff",
} as const;

/* -------------------------------------------------------------------------- */
/* The frame the preview draws inside                                          */
/* -------------------------------------------------------------------------- */

/**
 * The padding between a frame's border and the YouTube surface inside it.
 *
 * Ours, not theirs, and it is load-bearing arithmetic rather than taste. The
 * packaging preview lives in a 452px right rail. The rail's own rule and gutter
 * take 33 and the preview section draws no box of its own, so a frame gets
 * 419 — 417 inside its 1px border.
 *
 * The widest rendering that has to fit there *whole* is the phone tile, and it
 * is 390px because that is what a phone is: 390 + 2 × 12 = 414, with three to
 * spare. At 16 it was 422 and clipped the duration chip off the right-hand
 * edge, which — in a component where the chip exists to show what covers the
 * thumbnail's corner — was a funny way to fail.
 *
 * It lived in `youtube-preview.tsx` while the preview was the only surface that
 * drew a frame. The comparison row draws one too, and a second literal `12`
 * there would be the drift this file exists to prevent.
 */
export const FRAME_PADDING = 12;

/* -------------------------------------------------------------------------- */
/* The comparison row                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The comparison row: one feed card per thumbnail variant, side by side, with
 * somebody else's card at the end of it.
 *
 * ## Why these are separate numbers rather than reused ones
 *
 * The *card* is not a new thing — a tile in the comparison is a `FEED` card,
 * drawn from `FEED` and `FEED_TITLE_BOX`, because the question being asked is
 * "which of these wins in the feed" and a card of any other size answers a
 * different question. What is new is only the row those cards sit in, and our
 * own label above each one, and that is all that is written down here.
 *
 * The label is **ours, not YouTube's**: they never write "wild card" over a
 * tile. It is drawn outside the card, in their secondary grey and smaller than
 * anything in their layout, so it reads as an annotation on the mock rather
 * than as part of the interface being mocked.
 */
export const COMPARISON = {
  /**
   * Between one card and the next.
   *
   * YouTube's own rich grid gutters its columns at 16px, which is also
   * `PHONE.tileGap` — the same gap, the other way round. It is repeated rather
   * than aliased because a correction to the desktop grid's gutter should not
   * silently move the phone feed's vertical rhythm.
   */
  cardGap: 16,
  /** The label above each card: which slot this is, and whether it is live. */
  labelFontSize: 11,
  labelLineHeight: 16,
  /** Between that label and the top of the thumbnail. */
  labelGap: 6,
  /** Between the slot's name and the "live" marker beside it. */
  labelPartsGap: 6,
} as const;

/**
 * How wide a comparison row of `cards` feed cards is, gaps included.
 *
 * Four 360px cards and three 16px gaps are 1,488px and no column in this
 * application is, so the row scrolls inside its frame — it is never scaled,
 * because type drawn at 60% answers "does this read at tile size" wrongly, and
 * that is the only question the row is asked. `e2e/preview.spec.ts` measures
 * the drawn row against this, so the two cannot drift.
 */
export const comparisonRowWidth = (cards: number): number =>
  cards <= 0 ? 0 : cards * FEED.cardWidth + (cards - 1) * COMPARISON.cardGap;
