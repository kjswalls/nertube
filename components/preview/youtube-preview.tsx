"use client";

import type { CSSProperties, ReactNode } from "react";

import { usePackagingDraft } from "./live-packaging";
import { useClamp, type Clamp } from "./measure-title";
import {
  FEED,
  FEED_TITLE_BOX,
  PHONE,
  PHONE_TITLE_BOX,
  SAMPLE_DURATION,
  SAMPLE_NEIGHBOURS,
  SEARCH,
  SEARCH_ROW_WIDTH,
  SEARCH_TITLE_BOX,
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
 * copy rather than a model. The known gaps are written down there too; the
 * largest is the face, since Roboto is not shipped with this app.
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
  /** The concept sketch's signed URL, or null for an empty frame. */
  sketchUrl: string | null;
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
  savedTitle,
}: YouTubePreviewProps) {
  const draft = usePackagingDraft();
  const typed = (draft?.title ?? savedTitle).trim();
  const title = typed === "" ? UNTITLED : typed;

  return (
    <section
      data-testid="youtube-preview"
      aria-labelledby="preview-heading"
      className="flex flex-col gap-4 rounded-card border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id="preview-heading" className="text-sm font-semibold">
          How this looks on YouTube
        </h3>
        <p className="text-xs text-muted">
          A layout mock at YouTube&rsquo;s own metrics — 16:9, the two-line
          clamp, the real type sizes — drawn from the numbers in{" "}
          <code className="font-mono text-[11px]">components/preview/metrics.ts</code>.
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
        />
      </Frame>

      <Frame
        caption="Search results — bigger type, a much wider column, so the cut comes later."
        testId="preview-search"
      >
        <SearchRow
          title={title}
          channelName={channelName}
          sketchUrl={sketchUrl}
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
 * One rendering, at its true pixel size, with a caption saying what it is.
 *
 * `overflow-x: auto` and not a scale transform: a search row is 976px wide and
 * the page column is not, and shrinking it to fit would be the one thing this
 * component must not do. Type drawn at 80% is type that answers "does this
 * read?" wrongly. So it scrolls, inside its own frame, and the page itself
 * never scrolls sideways.
 */
function Frame({
  caption,
  testId,
  children,
}: {
  caption: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex flex-col gap-2" data-testid={testId}>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
      <div className="overflow-x-auto rounded-card border border-border">
        <div
          data-yt-surface=""
          style={{
            background: "var(--yt-surface)",
            color: "var(--yt-text)",
            fontFamily: YOUTUBE_FONT_STACK,
            padding: 16,
            width: "max-content",
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

/** The thumbnail slot: the concept sketch, or an honest empty frame. */
function Thumb({
  width,
  height,
  radius,
  sketchUrl,
  chipFontSize,
  chipInset,
}: {
  width: number;
  height: number;
  radius: number;
  sketchUrl: string | null;
  chipFontSize: number;
  chipInset: number;
}) {
  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        borderRadius: radius,
        overflow: "hidden",
        background: "var(--yt-placeholder)",
        flex: "none",
      }}
    >
      {sketchUrl === null ? (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            color: "var(--yt-placeholder-text)",
            textAlign: "center",
            padding: 8,
          }}
        >
          No concept sketch yet
        </span>
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={sketchUrl}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
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
          padding: "1px 4px",
          borderRadius: 4,
          background: "rgba(0,0,0,0.8)",
          color: "#fff",
          fontSize: chipFontSize,
          lineHeight: "14px",
          fontWeight: 500,
        }}
      >
        {SAMPLE_DURATION}
      </span>
    </div>
  );
}

function Avatar({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--yt-fill)",
        flex: "none",
        display: "block",
      }}
    />
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
        lineHeight: "18px",
      }}
    >
      &#8942;
    </span>
  );
}

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
}: {
  title: string;
  channelName: string;
  sketchUrl: string | null;
}) {
  return (
    <div style={{ width: FEED.cardWidth }}>
      <Thumb
        width={FEED.thumbWidth}
        height={FEED.thumbHeight}
        radius={FEED.thumbRadius}
        sketchUrl={sketchUrl}
        chipFontSize={FEED.chipFontSize}
        chipInset={FEED.chipInset}
      />

      <div
        style={{
          display: "flex",
          gap: FEED.avatarGap,
          marginTop: FEED.detailsGap,
          alignItems: "flex-start",
        }}
      >
        <Avatar size={FEED.avatarSize} />
        <div style={{ display: "flex", flexDirection: "column", gap: FEED.metaGap }}>
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
        </div>
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
}: {
  title: string;
  channelName: string;
  sketchUrl: string | null;
}) {
  return (
    <div style={{ display: "flex", gap: SEARCH.thumbGap, width: SEARCH_ROW_WIDTH }}>
      <Thumb
        width={SEARCH.thumbWidth}
        height={SEARCH.thumbHeight}
        radius={SEARCH.thumbRadius}
        sketchUrl={sketchUrl}
        chipFontSize={SEARCH.chipFontSize}
        chipInset={SEARCH.chipInset}
      />

      <div
        style={{
          width: SEARCH.textWidth,
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
          <Avatar size={SEARCH.avatarSize} />
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
}: {
  title: string;
  channelName: string;
  sketchUrl: string | null;
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
        sample
      />
      <PhoneTile
        title={title}
        channelName={channelName}
        meta={NOT_PUBLISHED}
        sketchUrl={sketchUrl}
        testId="preview-title-phone"
      />
      <PhoneTile
        title={SAMPLE_NEIGHBOURS[1].title}
        channelName={SAMPLE_NEIGHBOURS[1].channel}
        meta={SAMPLE_NEIGHBOURS[1].meta}
        sketchUrl={null}
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
  testId,
  sample = false,
}: {
  title: string;
  channelName: string;
  meta: string;
  sketchUrl: string | null;
  testId?: string;
  /** A neighbour: greyed a touch, and labelled for a screen reader. */
  sample?: boolean;
}) {
  return (
    <div
      style={{ opacity: sample ? 0.85 : 1 }}
      aria-label={sample ? "Sample tile, for scale" : undefined}
      data-sample={sample ? "true" : undefined}
    >
      <Thumb
        width={PHONE.thumbWidth}
        height={PHONE.thumbHeight}
        radius={PHONE.thumbRadius}
        sketchUrl={sketchUrl}
        chipFontSize={PHONE.chipFontSize}
        chipInset={PHONE.chipInset}
      />
      <div
        style={{
          display: "flex",
          gap: PHONE.avatarGap,
          padding: `${PHONE.rowPaddingY}px ${PHONE.rowPaddingX}px`,
          alignItems: "flex-start",
        }}
      >
        <Avatar size={PHONE.avatarSize} />
        <div style={{ display: "flex", flexDirection: "column", gap: PHONE.metaGap }}>
          <ClampedTitle
            text={title}
            box={PHONE_TITLE_BOX}
            color="var(--yt-text)"
            testId={testId}
          />
          <Meta fontSize={PHONE.metaFontSize} lineHeight={PHONE.metaLineHeight}>
            {channelName} &middot; {meta}
          </Meta>
        </div>
        <MenuColumn width={PHONE.menuReserve} />
      </div>
    </div>
  );
}
