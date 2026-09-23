"use client";

import Link from "next/link";

import { usePackagingDraft } from "./live-packaging";
import {
  FEED_TITLE_BOX,
  PHONE,
  PHONE_TITLE_BOX,
  PLACEHOLDER,
  SAMPLE_NEIGHBOURS,
  SEARCH,
  SEARCH_ROW_WIDTH,
  SEARCH_TITLE_BOX,
} from "./metrics";
import {
  Avatar,
  ClampedTitle,
  FeedCard,
  Frame,
  Meta,
  MenuColumn,
  NOT_PUBLISHED,
  PreviewStyles,
  TextColumn,
  Thumb,
  UNTITLED,
  type ThumbCopy,
} from "./parts";

/**
 * Exported because a second surface draws YouTube tiles: the thumbnail
 * section's feed strip (`components/thumbnails/feed-strip.tsx`), which is on a
 * different tab from this preview and therefore cannot rely on this component
 * being mounted. It lives in `./parts` now, with the rest of the drawing both
 * surfaces share; this re-export is so nothing that already imports it from
 * here has to care.
 */
export { PreviewStyles };

/**
 * What the concept sketch's slot says when there is no picture in it.
 *
 * The two states are kept apart on purpose — see `ThumbCopy`. "No concept
 * sketch yet" is true of a video nobody has uploaded one for and a lie about a
 * video whose sketch the app cannot reach, and the second person cannot act on
 * being told the first thing.
 */
const SKETCH_COPY: ThumbCopy = {
  empty: "No concept sketch yet",
  broken: "The sketch could not be loaded",
};

/**
 * What a neighbour's frame says.
 *
 * The phone rendering stacks the user's tile between two invented ones. Their
 * thumbnails are empty because nobody's picture belongs there, which is not the
 * same fact as the user's own slot being empty — and for a while both said "No
 * concept sketch yet", which read as though the sample tiles were waiting on
 * something of ours.
 */
const NEIGHBOUR_COPY: ThumbCopy = {
  empty: "A neighbour's thumbnail",
  broken: "A neighbour's thumbnail",
  sample: "A neighbour's thumbnail",
};

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
  /**
   * Where the *assets* are — `/videos/[id]?section=thumbnails`.
   *
   * The preview draws the concept sketch. After M4 the same visual language
   * draws the real shipped image one tab along, so this rendering has to say
   * which of the two it is holding and point at the other; BRIEF.md principle
   * 2 is that they are different things at different stages, and a card that
   * blurs them is the confusion the principle exists to prevent.
   */
  thumbnailsHref: string;
  /**
   * The live variant's name, when one has shipped. Null before that.
   *
   * Once a real image is on YouTube, "how this looks" is a question about that
   * image and not about the sketch, and the preview says so rather than letting
   * the reader assume.
   */
  shippedLabel?: string | null;
}

export function YouTubePreview({
  channelName,
  sketchUrl,
  hasSketch,
  savedTitle,
  thumbnailsHref,
  shippedLabel = null,
}: YouTubePreviewProps) {
  const draft = usePackagingDraft();
  const typed = (draft?.title ?? savedTitle).trim();
  const title = typed === "" ? UNTITLED : typed;

  return (
    <section
      id="video-preview"
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
        {/*
          What the picture in these frames *is*, said out loud.

          BRIEF.md principle 2 is that the concept and the asset are two
          different things at two different stages, and M4 put the real shipped
          image into a near-identical card one tab along. Without this line a
          person looking at a realistic feed card containing their scribble,
          captioned "the size the thumbnail is really seen at", has been handed
          exactly the confusion the principle exists to prevent. (The file the
          layout numbers come from used to be printed here as product copy; it
          is a note for a reader of the repository, and it lives in
          `components/preview/metrics.ts` and in this file's comments instead.)
        */}
        <p className="text-xs text-muted">
          A layout mock at YouTube&rsquo;s own metrics — 16:9, the two-line
          clamp, the real type sizes. Not their interface, and not their assets.
        </p>
        <p data-testid="preview-subject" className="text-xs text-muted">
          The picture in these frames is your <strong>concept sketch</strong>,
          at tile size.{" "}
          {shippedLabel === null
            ? "The image files that actually ship live in "
            : `The ${shippedLabel.toLowerCase()} variant is the one that is actually live; it is in `}
          <Link
            href={thumbnailsHref}
            className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Thumbnails
          </Link>
          .
        </p>
      </div>

      <PreviewStyles />

      <Frame
        caption="Home feed — a 360px card. The tightest clamp of the three."
        testId="preview-feed"
      >
        <FeedCard
          title={
            <ClampedTitle
              text={title}
              box={FEED_TITLE_BOX}
              color="var(--yt-text)"
              testId="preview-title-feed"
            />
          }
          channelName={channelName}
          url={sketchUrl}
          hasAsset={hasSketch}
          copy={SKETCH_COPY}
          cardTestId="preview-feed-card"
          detailsTestId="preview-feed-details"
          thumbTestId="preview-thumb-empty"
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
        caption="On a phone, between two other tiles — the size the concept is really judged at. The neighbours are invented samples, for scale."
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
        url={sketchUrl}
        hasAsset={hasSketch}
        chipFontSize={SEARCH.chipFontSize}
        chipInset={SEARCH.chipInset}
        copy={SKETCH_COPY}
        testId="preview-thumb-empty"
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
        url={sketchUrl}
        hasAsset={hasSketch}
        chipFontSize={PHONE.chipFontSize}
        chipInset={PHONE.chipInset}
        copy={sample ? NEIGHBOUR_COPY : SKETCH_COPY}
        sample={sample}
        testId="preview-thumb-empty"
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
