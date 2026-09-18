"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { usePackagingDraft } from "./live-packaging";
import { useClamp, type Clamp } from "./measure-title";
import {
  AVATAR,
  CHIP,
  FEED,
  FEED_TITLE_BOX,
  PHONE,
  PHONE_TITLE_BOX,
  SAMPLE_DURATION,
  SAMPLE_NEIGHBOURS,
  SEARCH,
  SEARCH_ROW_WIDTH,
  SEARCH_TITLE_BOX,
  PLACEHOLDER,
  TEXT_RENDERING,
  THUMB_ASPECT_CSS,
  YOUTUBE_COLORS,
  YOUTUBE_FONT_STACK,
  type TitleBox,
  type YoutubePalette,
} from "./metrics";

/**
 * The YouTube preview: this title and this thumbnail, drawn at the sizes they
 * will actually be seen at.
 *
 * ## What it is for
 *
 * Two questions the user cannot answer from the editor, and the tool can:
 *
 * 1. **Where does the title get cut?** The feed clamps to two lines at 16px in
 *    a 288px column, and the cut lands wherever it lands — mid-word, mid-joke,
 *    or right before the payoff. Every character past that point is written for
 *    nobody.
 * 2. **Does the concept read at tile size?** A thumbnail is designed at 1280px
 *    and seen at 360, or at 390 on a phone with two other tiles above and below
 *    it competing for the same thumb. The phone rendering is that comparison,
 *    which is why it has neighbours: "readable" is relative to what it is
 *    scrolled past.
 *
 * ## Fidelity, and its limits
 *
 * Every number comes from `./metrics.ts`, which says what each one represents
 * so it can be corrected in one place. Nothing was fetched from youtube.com —
 * this environment has no egress to it, and a mock built by scraping would be a
 * copy rather than a model. The known gaps are written down there too.
 *
 * The face is **Roboto**, self-hosted by `next/font` (`app/layout.tsx`), which
 * is the one thing here that is not a transcribed number: it is the same family
 * YouTube sets, so the clamp this measures is the clamp YouTube makes rather
 * than the clamp Arial would have made. Two more details follow from the same
 * ambition and are easy to miss — the application's `-webkit-font-smoothing:
 * antialiased` is turned back off inside every frame, because YouTube does not
 * set it and smoothed text is visibly lighter; and the avatar carries the
 * channel's initial, which is YouTube's own fallback for a channel with no
 * picture rather than a hole in the layout.
 *
 * **No brand assets.** No logo, no wordmark, no play button, no red. The parts
 * that are theirs are the *metrics* — a 16:9 thumbnail, a two-line clamp, 16/22
 * type, a grey metadata line — and those are what the user needs. A drawing of
 * their interface would add nothing to the two questions above.
 *
 * ## Why the drawn title is the measured one
 *
 * The clamp is enforced twice: `-webkit-line-clamp` on the element (so it can
 * never overflow, even before anything is measured) and, once measured, the
 * text itself is replaced with the visible prefix plus an ellipsis. That means
 * the cut you *see* and the count the warning quotes are the same computation,
 * and the ellipsis is real text rather than a CSS effect — so it can be
 * asserted, and so it survives being copied out of the page.
 */

export interface YouTubePreviewProps {
  /** The channel this video belongs to; drawn on every byline. */
  channelName: string;
  /**
   * The concept sketch's signed URL, or null when there is not one *or* the
   * app could not sign one.
   */
  sketchUrl: string | null;
  /**
   * Whether the video has a `thumbnail_concept_path` at all.
   *
   * The two states `sketchUrl === null` collapses are different states and the
   * page must not confuse them: no sketch was ever uploaded, versus there is
   * one and the app could not get at it. `app/videos/[id]/concept-sketch.tsx`
   * goes to deliberate trouble over exactly this — *saying "no sketch yet" to
   * the second would be a lie the person cannot act on* — and this preview used
   * to tell that lie, because it was only ever handed the URL.
   */
  hasSketch: boolean;
  /**
   * `videos.title` as the server rendered it — what is drawn until the editor
   * publishes a live draft, and what is drawn on a page whose packaging block
   * is not mounted.
   */
  savedTitle: string;
}

/** What an empty title is drawn as, so the frame is never a blank rectangle. */
const UNTITLED = "Untitled — the working title shows here";

export function YouTubePreview({
  channelName,
  sketchUrl,
  hasSketch,
  savedTitle,
}: YouTubePreviewProps) {
  const draft = usePackagingDraft();
  const typed = (draft?.title ?? savedTitle).trim();
  const title = typed === "" ? UNTITLED : typed;

  return (
    <section
      data-testid="youtube-preview"
      aria-labelledby="preview-heading"
      /*
        No border and no padding of its own, and the reason is arithmetic
        rather than taste. In the right rail there are 452px, of which the
        rail's own rule and gutter take 33. A box around this section would take
        another 34, leaving 385 — and the phone rendering is 390px wide because
        that is what a phone is. The card the frames are already drawn in is the
        grouping; a second box around the group bought nothing and cost the one
        rendering whose width is not negotiable.
      */
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id="preview-heading" className="text-sm font-semibold">
          How this looks on YouTube
        </h3>
        <p className="text-xs text-muted">
          A layout mock at YouTube&rsquo;s own metrics — 16:9, the two-line
          clamp, the real type sizes — drawn from the numbers in{" "}
          <code className="font-mono text-[11px] [overflow-wrap:anywhere]">
            components/preview/metrics.ts
          </code>.
          Not their interface, and not their assets.
        </p>
      </div>

      <PreviewStyles />

      <Frame
        caption="Home feed — a 360px card. The tightest clamp of the three."
        testId="preview-feed"
      >
        <FeedCard
          title={title}
          channelName={channelName}
          sketchUrl={sketchUrl}
          hasSketch={hasSketch}
        />
      </Frame>

      <Frame
        caption="Search results — bigger type in a 600px column, so the cut comes much later. The row is 976px wide; scroll it sideways for the thumbnail."
        testId="preview-search"
        // Park it on the text column: that is the half of a search result this
        // frame exists to answer, and it is the half a narrow rail hides.
        startAt={SEARCH.thumbWidth + SEARCH.thumbGap}
      >
        <SearchRow
          title={title}
          channelName={channelName}
          sketchUrl={sketchUrl}
          hasSketch={hasSketch}
        />
      </Frame>

      <Frame
        caption="On a phone, between two other tiles — the size the thumbnail is really seen at. The neighbours are invented samples, for scale."
        testId="preview-phone"
      >
        <PhoneFeed
          title={title}
          channelName={channelName}
          sketchUrl={sketchUrl}
          hasSketch={hasSketch}
        />
      </Frame>
    </section>
  );
}

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
 */
function PreviewStyles() {
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
 * The frame's own padding — ours, not YouTube's, and it is load-bearing
 * arithmetic rather than taste.
 *
 * The preview lives in a 452px right rail. The rail's own rule and gutter take
 * 33 and this section draws no box of its own (see the note on it), so a frame
 * gets 419 — 417 inside its 1px border.
 *
 * The widest rendering that has to fit there *whole* is the phone tile, and it
 * is 390px because that is what a phone is: 390 + 2 × 12 = 414, with three to
 * spare. At 16 it was 422 and clipped the duration chip off the right-hand
 * edge, which — in a component where the chip exists to show what covers the
 * thumbnail's corner — was a funny way to fail.
 *
 * The search row is the one rendering that does not fit at any padding; it is
 * 976px and it scrolls. See `Frame`.
 */
const FRAME_PADDING = 12;

/**
 * One rendering, at its true pixel size, with a caption saying what it is.
 *
 * `overflow-x: auto` and not a scale transform: a search row is 976px wide and
 * no rail is, and shrinking it to fit would be the one thing this component
 * must not do. Type drawn at 80% is type that answers "does this read?"
 * wrongly. So it scrolls, inside its own frame, and the page itself never
 * scrolls sideways.
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
 *   thumbnail is answered at true size by the other two renderings; what only
 *   search can answer is how much later *its* column cuts.
 */
function Frame({
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
/* Shared parts                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A title in a real title box: clamped by CSS always, and replaced by its
 * measured prefix once the browser has laid it out.
 *
 * `data-cut` is the number of characters the clamp removes, and it is the same
 * number the truncation warning quotes, because both come from `useClamp`.
 */
function ClampedTitle({
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
  const clamp: Clamp | null = useClamp(text, box);
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

/**
 * The thumbnail slot: the concept sketch, or an honest empty frame.
 *
 * ## Three states, not two
 *
 * `sketchUrl === null` collapses two of them, and they are not the same thing:
 *
 * - **No sketch.** Nothing has been uploaded. "No concept sketch yet" is true.
 * - **A sketch the app could not reach.** There is a
 *   `thumbnail_concept_path`, and signing a URL for it failed
 *   (`app/videos/[id]/page.tsx` hands this `null` in that case too). Saying "no
 *   sketch yet" here is a lie the person cannot act on — the sibling
 *   `ConceptSketch` on the same page takes `hasSketch` separately for exactly
 *   this reason, and this component now does the same.
 * - **A sketch whose object will not load.** The URL was signed and the fetch
 *   failed or the bytes are not an image. With no `onError` the `<img>` stayed
 *   in the layout at full size with `naturalWidth` 0 and `alt=""`, so Chromium
 *   painted nothing: a blank grey rectangle with a duration chip on it and not
 *   one word of explanation anywhere on the user's own tile.
 *
 * The `brokenUrl` pattern is the one already written in
 * `app/videos/[id]/concept-sketch.tsx`: remember *which* URL failed, so a newly
 * signed one is tried rather than being written off by the last one's failure.
 */
function Thumb({
  width,
  radius,
  sketchUrl,
  hasSketch,
  chipFontSize,
  chipInset,
}: {
  width: number;
  radius: number;
  sketchUrl: string | null;
  hasSketch: boolean;
  chipFontSize: number;
  chipInset: number;
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
  const broken = sketchUrl !== null && brokenUrl === sketchUrl;
  const drawImage = sketchUrl !== null && !broken;

  // With no image drawn, there are two things it can be: there is a sketch
  // (this one broke, or the app could not sign a URL for it), or there is not.
  const missing = broken || hasSketch;

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
          src={sketchUrl}
          alt=""
          onError={() => setBrokenUrl(sketchUrl)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <span
          data-testid="preview-thumb-empty"
          data-state={missing ? "broken" : "empty"}
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
          {missing ? "The sketch could not be loaded" : "No concept sketch yet"}
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
function Avatar({ size, channelName }: { size: number; channelName: string }) {
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
function MenuColumn({ width }: { width: number }) {
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
function Meta({
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
function TextColumn({
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
const NOT_PUBLISHED = "Not published yet";

/* -------------------------------------------------------------------------- */
/* 1. The home feed card                                                       */
/* -------------------------------------------------------------------------- */

function FeedCard({
  title,
  channelName,
  sketchUrl,
  hasSketch,
}: {
  title: string;
  channelName: string;
  sketchUrl: string | null;
  hasSketch: boolean;
}) {
  return (
    <div data-testid="preview-feed-card" style={{ width: FEED.cardWidth }}>
      <Thumb
        width={FEED.thumbWidth}
        radius={FEED.thumbRadius}
        sketchUrl={sketchUrl}
        hasSketch={hasSketch}
        chipFontSize={FEED.chipFontSize}
        chipInset={FEED.chipInset}
      />

      {/* No flex `gap` here: 36 + 12 + 288 + 24 is exactly `cardWidth`, and a
          gap between every pair would make it 372 in a 360px card. The one gap
          belongs to the text column. See `TextColumn`. */}
      <div
        data-testid="preview-feed-details"
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
          <ClampedTitle
            text={title}
            box={FEED_TITLE_BOX}
            color="var(--yt-text)"
            testId="preview-title-feed"
          />
          <div>
            <Meta fontSize={FEED.metaFontSize} lineHeight={FEED.metaLineHeight}>
              {channelName}
            </Meta>
            <Meta fontSize={FEED.metaFontSize} lineHeight={FEED.metaLineHeight}>
              {NOT_PUBLISHED}
            </Meta>
          </div>
        </TextColumn>
        <MenuColumn width={FEED.menuReserve} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. The search result row                                                    */
/* -------------------------------------------------------------------------- */

function SearchRow({
  title,
  channelName,
  sketchUrl,
  hasSketch,
}: {
  title: string;
  channelName: string;
  sketchUrl: string | null;
  hasSketch: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: SEARCH.thumbGap, width: SEARCH_ROW_WIDTH }}>
      <Thumb
        width={SEARCH.thumbWidth}
        radius={SEARCH.thumbRadius}
        sketchUrl={sketchUrl}
        hasSketch={hasSketch}
        chipFontSize={SEARCH.chipFontSize}
        chipInset={SEARCH.chipInset}
      />

      <div
        style={{
          width: SEARCH.textWidth,
          flex: "none",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: SEARCH.rowGap,
        }}
      >
        <ClampedTitle
          text={title}
          box={SEARCH_TITLE_BOX}
          color="var(--yt-text)"
          testId="preview-title-search"
        />

        <Meta fontSize={SEARCH.metaFontSize} lineHeight={SEARCH.metaLineHeight}>
          {NOT_PUBLISHED}
        </Meta>

        <div style={{ display: "flex", alignItems: "center", gap: SEARCH.avatarGap }}>
          <Avatar size={SEARCH.avatarSize} channelName={channelName} />
          <Meta fontSize={SEARCH.metaFontSize} lineHeight={SEARCH.metaLineHeight}>
            {channelName}
          </Meta>
        </div>

        {/* YouTube shows the first two lines of the description here. NerTube
            does not hold a description yet (it is not in the schema), so the
            slot says so rather than borrowing the thumbnail concept — which is
            a note to the editor, not something a viewer would ever read. */}
        <Meta fontSize={SEARCH.metaFontSize} lineHeight={SEARCH.metaLineHeight}>
          The description snippet goes here on YouTube.
        </Meta>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. The phone feed                                                           */
/* -------------------------------------------------------------------------- */

function PhoneFeed({
  title,
  channelName,
  sketchUrl,
  hasSketch,
}: {
  title: string;
  channelName: string;
  sketchUrl: string | null;
  hasSketch: boolean;
}) {
  return (
    <div
      style={{
        width: PHONE.deviceWidth,
        display: "flex",
        flexDirection: "column",
        gap: PHONE.tileGap,
      }}
    >
      <PhoneTile
        title={SAMPLE_NEIGHBOURS[0].title}
        channelName={SAMPLE_NEIGHBOURS[0].channel}
        meta={SAMPLE_NEIGHBOURS[0].meta}
        sketchUrl={null}
        hasSketch={false}
        sample
      />
      <PhoneTile
        title={title}
        channelName={channelName}
        meta={NOT_PUBLISHED}
        sketchUrl={sketchUrl}
        hasSketch={hasSketch}
        testId="preview-title-phone"
      />
      <PhoneTile
        title={SAMPLE_NEIGHBOURS[1].title}
        channelName={SAMPLE_NEIGHBOURS[1].channel}
        meta={SAMPLE_NEIGHBOURS[1].meta}
        sketchUrl={null}
        hasSketch={false}
        sample
      />
    </div>
  );
}

function PhoneTile({
  title,
  channelName,
  meta,
  sketchUrl,
  hasSketch,
  testId,
  sample = false,
}: {
  title: string;
  channelName: string;
  meta: string;
  sketchUrl: string | null;
  hasSketch: boolean;
  testId?: string;
  /** A neighbour: greyed a touch, and labelled for a screen reader. */
  sample?: boolean;
}) {
  return (
    <div
      data-testid="preview-phone-tile"
      style={{ width: PHONE.deviceWidth, opacity: sample ? PLACEHOLDER.sampleOpacity : 1 }}
      aria-label={sample ? "Sample tile, for scale" : undefined}
      data-sample={sample ? "true" : undefined}
    >
      <Thumb
        width={PHONE.thumbWidth}
        radius={PHONE.thumbRadius}
        sketchUrl={sketchUrl}
        hasSketch={hasSketch}
        chipFontSize={PHONE.chipFontSize}
        chipInset={PHONE.chipInset}
      />
      {/* Again no flex `gap`: 36 + 12 + 294 + 24 is exactly the padded content
          box, 390 − 2 × 12. See `TextColumn`. */}
      <div
        data-testid="preview-phone-row"
        style={{
          display: "flex",
          padding: `${PHONE.rowPaddingY}px ${PHONE.rowPaddingX}px`,
          alignItems: "flex-start",
        }}
      >
        <Avatar size={PHONE.avatarSize} channelName={channelName} />
        <TextColumn
          width={PHONE_TITLE_BOX.width}
          gap={PHONE.metaGap}
          marginLeft={PHONE.avatarGap}
        >
          <ClampedTitle
            text={title}
            box={PHONE_TITLE_BOX}
            color="var(--yt-text)"
            testId={testId}
          />
          <Meta fontSize={PHONE.metaFontSize} lineHeight={PHONE.metaLineHeight}>
            {channelName} &middot; {meta}
          </Meta>
        </TextColumn>
        <MenuColumn width={PHONE.menuReserve} />
      </div>
    </div>
  );
}
