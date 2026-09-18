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
 * The face YouTube sets titles in, with the fallbacks a machine without it
 * will actually use.
 *
 * **This is the known weak point of the measurement.** Roboto is not shipped by
 * this app (no new dependencies, and the three app faces are fetched from
 * Google at build time), so on a machine without Roboto installed the browser
 * measures Arial — or, on this Linux box, Liberation Sans, which is
 * metrically compatible with Arial and *not* with Roboto. Roboto is slightly
 * narrower, so the warning errs towards saying a title is cut when YouTube
 * might just fit it. The error is a character or two at the clamp, in the
 * pessimistic direction, and it is the first thing to fix if these numbers are
 * ever checked against the real page.
 */
export const YOUTUBE_FONT_STACK =
  'Roboto, "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif';

/** Every title box is clamped to this many lines on every surface YouTube has. */
export const TITLE_LINES = 2;

/** 16:9, the only aspect a YouTube thumbnail is ever served at. */
export const THUMB_ASPECT = 16 / 9;

/** The 16:9 height for a thumbnail of this width, rounded the way a browser lays it out. */
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

/** The box a feed title wraps in: the card, less the avatar column and the ⋮ button. */
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
