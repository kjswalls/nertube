"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useClamp, type Clamp } from "./measure-title";
import {
  AVATAR,
  CHIP,
  FEED,
  FEED_TITLE_BOX,
  FRAME_PADDING,
  PLACEHOLDER,
  SAMPLE_DURATION,
  TEXT_RENDERING,
  THUMB_ASPECT_CSS,
  YOUTUBE_COLORS,
  YOUTUBE_FONT_STACK,
  type TitleBox,
  type YoutubePalette,
} from "./metrics";

/**
 * The pieces every YouTube rendering in this application is built out of.
 *
 * ## Why they are here and not in the component that first needed them
 *
 * M3 drew one video: one title, one image, three renderings, in
 * `youtube-preview.tsx`. M4 draws three *variants* of the same video side by
 * side, on a different tab, so a second surface now has to produce a feed card
 * that is the same card in every respect that matters — same width, same
 * two-line clamp at the same measured box, same duration chip over the same
 * corner, same greys.
 *
 * The first cut of that second surface copied the tile out of the preview, and
 * that copy is the thing this module exists to prevent. Two hand-copies of a
 * layout do not stay the same layout: the moment one of them is corrected
 * against the real page — and `metrics.ts` is written on the assumption that
 * they will be, one number at a time — the other quietly keeps drawing the old
 * one, and a comparison between a card drawn one way and a card drawn the other
 * is not a comparison at all.
 *
 * So there is one `Thumb`, one `FeedCard`, one title, one frame. The
 * *questions* the two surfaces ask differ — "where does my title get cut"
 * versus "which of these three wins in a feed" — and that difference lives in
 * the surfaces. The drawing does not differ, so it lives here.
 */

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * YouTube's greys, in both of its themes, following the app's choice.
 *
 * The same three-block pattern `app/globals.css` uses and for the same reason:
 * a bare `@media (prefers-color-scheme: dark)` would take the manual override
 * straight back on a dark OS. It is a `<style>` in the component rather than a
 * block in `globals.css` because these values are YouTube's, not the product's,
 * and keeping them beside the metrics they belong to is what stops someone
 * "tidying" them into the palette.
 *
 * Every surface that draws a `[data-yt-surface]` renders one of these. Two on a
 * page is harmless — the rules are identical and idempotent — and that is the
 * point: the thumbnails tab and the packaging tab are different sections, and
 * neither can rely on the other being mounted.
 */
export function PreviewStyles() {
  const { light, dark } = YOUTUBE_COLORS;
  const vars = (theme: YoutubePalette) => `
    --yt-surface: ${theme.surface};
    --yt-text: ${theme.textPrimary};
    --yt-text-2: ${theme.textSecondary};
    --yt-placeholder: ${theme.placeholder};
    --yt-placeholder-text: ${theme.placeholderText};
    --yt-fill: ${theme.fill};
  `;

  const css = `
[data-yt-surface] { ${vars(light)} }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) [data-yt-surface] { ${vars(dark)} }
}
:root[data-theme="dark"] [data-yt-surface] { ${vars(dark)} }
`;

  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/* -------------------------------------------------------------------------- */
/* The frame around each rendering                                             */
/* -------------------------------------------------------------------------- */

/**
 * One rendering, at its true pixel size, with a caption saying what it is.
 *
 * `overflow-x: auto` and not a scale transform: a search row is 976px wide and
 * a comparison row of four cards is 1,488, and no rail is either. Shrinking
 * them to fit would be the one thing these components must not do — type drawn
 * at 80% answers "does this read?" wrongly. So it scrolls, inside its own
 * frame, and the page itself never scrolls sideways.
 *
 * Two things follow from a frame that scrolls, and both are easy to leave out:
 *
 * - **It is focusable.** A scroll container that nothing can focus cannot be
 *   scrolled from a keyboard at all, which is a straightforward WCAG failure
 *   and not a detail. `tabIndex={0}` with a group role and the caption as its
 *   name.
 * - **It starts where the question is.** `startAt` scrolls a clipped frame to
 *   the part worth seeing first. For the search row that is the text column:
 *   drawn from the left, a 419px rail shows 419px of a 360px thumbnail and
 *   nothing else — a grey rectangle where a title was supposed to be. The
 *   comparison row is the other way round and starts at 0, because its first
 *   card is the first thing to judge.
 */
export function Frame({
  caption,
  testId,
  startAt = 0,
  children,
}: {
  caption: string;
  testId: string;
  /** Where to park the scroll when the frame is too narrow for its content. */
  startAt?: number;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || startAt === 0) return;
    // Only when it is actually clipped: in a wide page the whole row is
    // visible and moving it would just hide the thumbnail for no reason.
    if (node.scrollWidth <= node.clientWidth) return;
    node.scrollLeft = startAt;
  }, [startAt]);

  return (
    <figure className="flex flex-col gap-2" data-testid={testId}>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
      <div
        ref={scroller}
        role="group"
        aria-label={caption}
        tabIndex={0}
        className="overflow-x-auto rounded-card border border-border outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div
          data-yt-surface=""
          style={{
            background: "var(--yt-surface)",
            color: "var(--yt-text)",
            fontFamily: YOUTUBE_FONT_STACK,
            padding: FRAME_PADDING,
            // `max-content` so a 976px row is 976px and scrolls; `min-width:
            // 100%` so a 360px card does not leave a strip of *our* page
            // showing down the right of a frame that is supposed to be a
            // picture of theirs. YouTube's own background runs past the card.
            width: "max-content",
            minWidth: "100%",
            boxSizing: "border-box",
            // The application smooths its own faces and YouTube does not, and
            // the measurer pins the same four properties. See `TEXT_RENDERING`.
            ...TEXT_RENDERING,
          }}
        >
          {children}
        </div>
      </div>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* The title                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A title drawn in a real title box from a measurement somebody else took.
 *
 * The clamp is enforced twice: `-webkit-line-clamp` on the element (so it can
 * never overflow, even before anything is measured) and, once measured, the
 * text itself is replaced with the visible prefix plus an ellipsis. That means
 * the cut you *see* and the count the warning quotes are the same computation,
 * and the ellipsis is real text rather than a CSS effect — so it can be
 * asserted, and so it survives being copied out of the page.
 *
 * `clamp` is passed in rather than measured here because the comparison row
 * draws the *same* title four times: measuring once and handing the answer to
 * every card is what makes "the tiles differ only by image" true of the markup
 * and not just of the intention. `ClampedTitle` is the one-title case.
 *
 * `data-cut` is the number of characters the clamp removes — in graphemes, the
 * way a person counts them — and it is the same number the truncation warning
 * quotes, because both come from the same `Clamp`.
 */
export function DrawnTitle({
  text,
  clamp,
  box,
  color,
  testId,
}: {
  text: string;
  /** `null` before the browser has measured, and on the server. */
  clamp: Clamp | null;
  box: TitleBox;
  color: string;
  testId?: string;
}) {
  const drawn = clamp === null ? text : clamp.truncated ? `${clamp.visible}…` : clamp.text;

  const style: CSSProperties = {
    width: box.width,
    fontSize: box.fontSize,
    lineHeight: `${box.lineHeight}px`,
    fontWeight: box.fontWeight,
    color,
    margin: 0,
    // The safety net. Before the measurement lands — server render, first
    // paint, a browser without `document.fonts` — this is what keeps a long
    // title from pushing the card's metadata down the page.
    display: "-webkit-box",
    WebkitLineClamp: box.lines,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    overflowWrap: "break-word",
  };

  return (
    <p
      style={style}
      data-testid={testId}
      data-cut={clamp === null ? undefined : clamp.cut}
      data-truncated={clamp === null ? undefined : String(clamp.truncated)}
    >
      {drawn}
    </p>
  );
}

/** `DrawnTitle`, measuring its own string. */
export function ClampedTitle({
  text,
  box,
  color,
  testId,
}: {
  text: string;
  box: TitleBox;
  color: string;
  testId?: string;
}) {
  const clamp = useClamp(text, box);

  return (
    <DrawnTitle
      text={text}
      clamp={clamp}
      box={box}
      color={color}
      testId={testId}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The thumbnail slot                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What an empty slot says, in each of the ways it can be empty.
 *
 * Every surface writes its own words — "No concept sketch yet" on the packaging
 * preview, "No wild card image yet" in the comparison row — because the thing
 * that is missing is a different thing. What none of them may do is use one
 * sentence for two states: a slot nobody has filled and a picture that would
 * not load are different problems with different next actions, and telling the
 * first story about the second is a lie the person cannot act on.
 */
export interface ThumbCopy {
  /** Nothing has ever been uploaded here. */
  readonly empty: string;
  /**
   * There *is* an object, and it is not on screen.
   *
   * One sentence for two causes on purpose: the app could not sign a URL for
   * the object, or it signed one and the fetch failed. The person's next move
   * is the same either way, and the difference between them is not something
   * they can see or do anything about.
   */
  readonly broken: string;
  /**
   * This frame was never going to hold one of the user's pictures: it belongs
   * to an invented neighbour, drawn for scale. Required when `sample` is set,
   * so a competitor's frame is never worded — or counted — as one of ours.
   */
  readonly sample?: string;
}

/**
 * The thumbnail slot: the image, or an honest empty frame.
 *
 * ## Three states, not two
 *
 * A single `url: string | null` collapses states that are not the same thing,
 * and the frame must not:
 *
 * - **Empty.** Nothing has been uploaded. `data-state="empty"`.
 * - **Broken.** There is a path on the row, and the picture is not on screen —
 *   signing failed, or the object did not fetch, or the bytes are not an image.
 *   `data-state="broken"`. With no `onError` the `<img>` stayed in the layout
 *   at full size with `naturalWidth` 0 and `alt=""`, so Chromium painted
 *   nothing: a blank grey rectangle with a duration chip on it and not one word
 *   of explanation anywhere.
 * - **Sample.** A neighbour's tile, which has no picture because nobody's
 *   picture belongs there. `data-state="sample"`, so counting the user's own
 *   empty frames never picks up an invented one.
 *
 * The `brokenUrl` pattern is the one already written in
 * `app/videos/[id]/concept-sketch.tsx`: remember *which* URL failed, so a newly
 * signed one is tried rather than being written off by the last one's failure.
 */
export function Thumb({
  width,
  radius,
  url,
  hasAsset,
  chipFontSize,
  chipInset,
  copy,
  sample = false,
  testId,
  imageTestId,
}: {
  width: number;
  radius: number;
  /** A signed URL, or null when there is none *or* signing failed. */
  url: string | null;
  /** Whether the row names an object at all. Different from having a URL. */
  hasAsset: boolean;
  chipFontSize: number;
  chipInset: number;
  copy: ThumbCopy;
  /** An invented neighbour rather than one of the user's slots. */
  sample?: boolean;
  /** The placeholder's test id, so each surface's empty frames count apart. */
  testId?: string;
  /** The `<img>`'s, for a spec that needs to know *which* picture arrived. */
  imageTestId?: string;
}) {
  /*
    *Which* URL failed, not "it failed".

    Storing a boolean would write a new signed URL off because the previous
    object could not be fetched; comparing the stored one against the current
    one means a re-signed URL is tried again, with no effect to reset it — the
    comparison is the reset. Same pattern, same reason, as
    `app/videos/[id]/concept-sketch.tsx`.
  */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const broken = url !== null && brokenUrl === url;
  const drawImage = url !== null && !broken;

  // With no image drawn, there are two things it can be: there is an object
  // (this one broke, or the app could not sign a URL for it), or there is not.
  const state = sample ? "sample" : broken || hasAsset ? "broken" : "empty";
  const label =
    state === "sample" ? (copy.sample ?? copy.empty) : state === "broken" ? copy.broken : copy.empty;

  return (
    <div
      style={{
        position: "relative",
        width,
        // The ratio, not a rounded height: `Math.round(360 / (16/9))` is 203,
        // which is 1.7734 rather than 1.77778. See `THUMB_ASPECT_CSS`.
        aspectRatio: THUMB_ASPECT_CSS,
        borderRadius: radius,
        overflow: "hidden",
        background: "var(--yt-placeholder)",
        flex: "none",
      }}
    >
      {drawImage ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt=""
          data-testid={imageTestId}
          onError={() => setBrokenUrl(url)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <span
          data-testid={testId}
          data-state={state}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: PLACEHOLDER.fontSize,
            color: "var(--yt-placeholder-text)",
            textAlign: "center",
            padding: PLACEHOLDER.padding,
          }}
        >
          {label}
        </span>
      )}

      {/* The duration chip. A placeholder number, drawn because the chip is
          part of the layout: it sits on the thumbnail's bottom-right corner on
          every YouTube surface, so a concept whose subject lives in that corner
          is a concept that gets sat on. */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          right: chipInset,
          bottom: chipInset,
          padding: `${CHIP.paddingY}px ${CHIP.paddingX}px`,
          borderRadius: CHIP.radius,
          background: CHIP.background,
          color: CHIP.color,
          fontSize: chipFontSize,
          lineHeight: `${CHIP.lineHeight}px`,
          fontWeight: CHIP.fontWeight,
        }}
      >
        {SAMPLE_DURATION}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The details row                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The channel avatar: a filled circle carrying the channel's initial.
 *
 * YouTube draws the channel's picture here, which this application does not
 * have and would not be allowed to invent. A blank grey disc is honest but
 * reads as a hole in the layout; the initial is what YouTube itself falls back
 * to for a channel with no picture, so it is both closer to the real thing and
 * still nobody's asset. `aria-hidden`, because the channel's name is written
 * out in full on the line beside it.
 */
export function Avatar({ size, channelName }: { size: number; channelName: string }) {
  // `Array.from` and not `[0]`: a channel called "🎬 Sunday Softworks" has a
  // first *code unit* that is half a character.
  const initial = (Array.from(channelName.trim())[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--yt-fill)",
        color: "var(--yt-text-2)",
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * AVATAR.initialScale),
        lineHeight: 1,
        fontWeight: AVATAR.fontWeight,
        userSelect: "none",
      }}
    >
      {initial}
    </span>
  );
}

/** The ⋮ column YouTube reserves at the right of a title row. */
export function MenuColumn({ width }: { width: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width,
        flex: "none",
        textAlign: "right",
        color: "var(--yt-text-2)",
        lineHeight: `${PLACEHOLDER.menuLineHeight}px`,
      }}
    >
      &#8942;
    </span>
  );
}

/**
 * One metadata line: nowrap, and cut with an ellipsis when it does not fit.
 *
 * The ellipsis only works if something constrains the width, and for a long
 * time nothing did. This is a block inside a flex column that was itself a flex
 * item with no `min-width: 0` and no width of its own, so the column's
 * max-content width won and the *row grew* instead of the text ellipsising —
 * `text-overflow` was dead code on the feed and the phone. On the phone tile
 * the line is `{channelName} · Not published yet`, so a 37-character channel
 * name (the app allows up to 80: `app/actions/channels.ts`) pushed the row 31px
 * past a device that is 390px wide by definition.
 *
 * The fix is on the text column — an explicit width, which is the number
 * `FEED_TITLE_BOX` / `PHONE_TITLE_BOX` already compute, plus `minWidth: 0` so
 * the flex item's automatic minimum size cannot override it. See `TextColumn`.
 */
export function Meta({
  children,
  fontSize,
  lineHeight,
  testId,
}: {
  children: ReactNode;
  fontSize: number;
  lineHeight: number;
  testId?: string;
}) {
  return (
    <p
      data-testid={testId}
      style={{
        margin: 0,
        fontSize,
        lineHeight: `${lineHeight}px`,
        color: "var(--yt-text-2)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </p>
  );
}

/**
 * The title-and-metadata column of a details row, at exactly the width the
 * title was measured in.
 *
 * `flex: none` and `minWidth: 0`: the width here *is* the clamp's width, so
 * neither growing nor shrinking it is allowed. Without `minWidth: 0` a flex
 * item's automatic minimum size is its min-content width, which for a nowrap
 * metadata line is however long that line is.
 */
export function TextColumn({
  width,
  gap,
  marginLeft,
  children,
}: {
  width: number;
  gap: number;
  /**
   * The row's one gap, drawn here rather than by the flex container.
   *
   * A flex `gap` applies between *every* pair of children, so with three of
   * them — avatar, text, ⋮ — it drew two gaps where the metrics subtract one,
   * and the row came out 12px wider than the card that is supposed to contain
   * it. The ⋮ column sits flush with the card's right edge, so the gap belongs
   * to this column alone.
   */
  marginLeft: number;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="preview-text-column"
      style={{
        width,
        flex: "none",
        minWidth: 0,
        marginLeft,
        display: "flex",
        flexDirection: "column",
        gap,
      }}
    >
      {children}
    </div>
  );
}

/**
 * The metadata line for the user's own video.
 *
 * YouTube would show "12K views · 2 days ago" here. Inventing a view count for
 * a video that has not been published would be the preview telling a lie in the
 * middle of a component whose entire job is to tell the truth, so it says what
 * is actually the case.
 */
export const NOT_PUBLISHED = "Not published yet";

/** What an empty title is drawn as, so the frame is never a blank rectangle. */
export const UNTITLED = "Untitled — the working title shows here";

/* -------------------------------------------------------------------------- */
/* The home feed card                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A card in the desktop home feed: thumbnail, avatar, two-line title, two
 * metadata lines.
 *
 * The one card, drawn by the packaging preview and by every tile of the
 * comparison row. The title arrives as a node rather than a string because the
 * two surfaces measure differently — the preview measures its own one title,
 * the comparison measures once and hands the same answer to every card — and
 * everything else about the card is identical by construction, which is exactly
 * the claim the comparison rests on.
 */
export function FeedCard({
  title,
  channelName,
  meta = NOT_PUBLISHED,
  url,
  hasAsset,
  copy,
  sample = false,
  cardTestId,
  detailsTestId,
  thumbTestId,
  imageTestId,
}: {
  /** A `ClampedTitle` or a `DrawnTitle`, in `FEED_TITLE_BOX`. */
  title: ReactNode;
  channelName: string;
  /** The second metadata line — "views · age" on YouTube. */
  meta?: string;
  url: string | null;
  hasAsset: boolean;
  copy: ThumbCopy;
  sample?: boolean;
  cardTestId?: string;
  detailsTestId?: string;
  thumbTestId?: string;
  imageTestId?: string;
}) {
  return (
    <div data-testid={cardTestId} style={{ width: FEED.cardWidth }}>
      <Thumb
        width={FEED.thumbWidth}
        radius={FEED.thumbRadius}
        url={url}
        hasAsset={hasAsset}
        chipFontSize={FEED.chipFontSize}
        chipInset={FEED.chipInset}
        copy={copy}
        sample={sample}
        testId={thumbTestId}
        imageTestId={imageTestId}
      />

      {/* No flex `gap` here: 36 + 12 + 288 + 24 is exactly `cardWidth`, and a
          gap between every pair would make it 372 in a 360px card. The one gap
          belongs to the text column. See `TextColumn`. */}
      <div
        data-testid={detailsTestId}
        style={{
          display: "flex",
          marginTop: FEED.detailsGap,
          alignItems: "flex-start",
        }}
      >
        <Avatar size={FEED.avatarSize} channelName={channelName} />
        <TextColumn
          width={FEED_TITLE_BOX.width}
          gap={FEED.metaGap}
          marginLeft={FEED.avatarGap}
        >
          {title}
          <div>
            <Meta fontSize={FEED.metaFontSize} lineHeight={FEED.metaLineHeight}>
              {channelName}
            </Meta>
            <Meta fontSize={FEED.metaFontSize} lineHeight={FEED.metaLineHeight}>
              {meta}
            </Meta>
          </div>
        </TextColumn>
        <MenuColumn width={FEED.menuReserve} />
      </div>
    </div>
  );
}
