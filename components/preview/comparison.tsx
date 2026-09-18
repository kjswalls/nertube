"use client";

import { useClamps } from "./measure-title";
import {
  COMPARISON,
  FEED,
  FEED_TITLE_BOX,
  SAMPLE_NEIGHBOURS,
  comparisonRowWidth,
} from "./metrics";
import {
  DrawnTitle,
  FeedCard,
  Frame,
  PreviewStyles,
  type ThumbCopy,
} from "./parts";

/**
 * The comparison row: the same feed card, once per thumbnail variant, beside
 * somebody else's.
 *
 * ## Why this is not the three frames again, larger
 *
 * A variant shown on its own at 640px, on a white page, next to its two
 * siblings, answers "is this image any good". That is the wrong question and it
 * flatters every one of them. A thumbnail is seen at 360px in a grid, for about
 * a second, against whatever else the feed put there — so the decision actually
 * being made is *which of these wins in a feed*, and the only honest way to
 * show that is to draw the feed.
 *
 * ## What is held constant, and why it matters
 *
 * Every card here is the same `FeedCard` at the same `FEED.cardWidth`, with the
 * same title, the same channel and the same metadata line. The **only**
 * difference between one variant's card and the next is the picture — because
 * that is the only difference the user is being asked to judge, and anything
 * else that varied would be a second variable in a comparison of one.
 *
 * The title is measured **once**, by `useClamps`, and the same `Clamp` is drawn
 * into every card. Measuring per card would give the same answer — same string,
 * same box — but "the same answer every time" would then be a property of the
 * measurement being deterministic rather than a property of the markup, and the
 * claim this row makes is about the markup.
 *
 * ## The competitor
 *
 * One more card at the end, from `SAMPLE_NEIGHBOURS`: invented, generic, and
 * nobody's. It is not dimmed and not marked out, because a competitor you can
 * tell apart at a glance is not doing its job — the point is to see the user's
 * tile the way a stranger scrolling past would, which is to say beside a tile
 * with no special claim on their attention. Its frame says what it is in words
 * instead, and reports `data-state="sample"` so it is never counted as one of
 * the user's own empty slots.
 *
 * ## It scrolls, and it never shrinks
 *
 * Four 360px cards and three gaps are 1,488px (`comparisonRowWidth`) and no
 * column in this application is. Scaling them down is the one thing a rendering
 * like this must never do: type drawn at 60% answers "does this read at tile
 * size" wrongly, which is the entire question. So the row scrolls inside its
 * own frame — focusable, so a keyboard can scroll it — and the page itself
 * never scrolls sideways. See `Frame`.
 */

export interface ComparisonTile {
  /** Stable key and `data-role`: the variant's role, or whatever names it. */
  readonly key: string;
  /** The slot's name, as it is written everywhere else: "Wild card". */
  readonly label: string;
  /** A signed URL, or null when there is none *or* signing failed. */
  readonly url: string | null;
  /** Whether the row names an object at all. Different from having a URL. */
  readonly hasAsset: boolean;
  /** Is this the one that is live on YouTube right now? */
  readonly live: boolean;
}

/** The marker on the live variant's label. */
const LIVE_MARKER = "· live";

/** The competitor: invented, generic and nobody's. See `SAMPLE_NEIGHBOURS`. */
const COMPETITOR = SAMPLE_NEIGHBOURS[0];

const COMPETITOR_LABEL = "Someone else's";

/**
 * What an empty or unreachable slot says, in this row, for this slot.
 *
 * Derived from the slot's own label so the three sentences cannot drift apart
 * from each other or from the label above the card, and kept distinct between
 * the two states on purpose: "no image yet" is an instruction to upload one and
 * "could not be loaded" is an instruction to check the one that is there. A
 * single sentence for both would be a lie to whichever half of the users is
 * reading it at the time.
 */
function copyFor(label: string): ThumbCopy {
  const slot = label.toLowerCase();
  return {
    empty: `No ${slot} image yet`,
    broken: `The ${slot} image could not be loaded`,
  };
}

const COMPETITOR_COPY: ThumbCopy = {
  // Neither of these can happen — the competitor has no object and never will —
  // but `ThumbCopy` asks for them and a frame that said nothing would be the
  // blank grey rectangle this component exists to avoid.
  empty: "A neighbour's thumbnail",
  broken: "A neighbour's thumbnail",
  sample: "A neighbour's thumbnail",
};

export function FeedComparison({
  tiles,
  title,
  channelName,
  caption = "The same card once per variant, with a neighbour for scale. The neighbour is an invented sample, not a real video.",
  testId = "preview-comparison",
}: {
  tiles: readonly ComparisonTile[];
  /** The video's title — the same on every one of the user's cards. */
  title: string;
  channelName: string;
  caption?: string;
  testId?: string;
}) {
  /*
    One pass for every title in the row: the user's, drawn into each of their
    cards, and the neighbour's. `useClamps` lays them out in one measuring
    element and returns in one render, which is also why the user's title is
    measured once rather than once per card.
  */
  const [ownClamp, competitorClamp] = useClamps(
    [title, COMPETITOR.title],
    FEED_TITLE_BOX,
  );

  return (
    <>
      <PreviewStyles />

      <Frame caption={caption} testId={testId}>
        <div
          style={{
            display: "flex",
            gap: COMPARISON.cardGap,
            alignItems: "flex-start",
            width: comparisonRowWidth(tiles.length + 1),
          }}
        >
          {tiles.map((tile) => (
            <Tile
              key={tile.key}
              role={tile.key}
              label={tile.label}
              live={tile.live}
            >
              <FeedCard
                title={
                  <DrawnTitle
                    text={title}
                    clamp={ownClamp ?? null}
                    box={FEED_TITLE_BOX}
                    color="var(--yt-text)"
                    testId="preview-comparison-title"
                  />
                }
                channelName={channelName}
                url={tile.url}
                hasAsset={tile.hasAsset}
                copy={copyFor(tile.label)}
                thumbTestId="preview-comparison-thumb"
                imageTestId="preview-comparison-image"
              />
            </Tile>
          ))}

          <Tile role="sample" label={COMPETITOR_LABEL} live={false}>
            <FeedCard
              title={
                <DrawnTitle
                  text={COMPETITOR.title}
                  clamp={competitorClamp ?? null}
                  box={FEED_TITLE_BOX}
                  color="var(--yt-text)"
                />
              }
              channelName={COMPETITOR.channel}
              meta={COMPETITOR.meta}
              url={null}
              hasAsset={false}
              copy={COMPETITOR_COPY}
              sample
              thumbTestId="preview-comparison-thumb"
            />
          </Tile>
        </div>
      </Frame>
    </>
  );
}

/**
 * One card with our label over it.
 *
 * The label is drawn *outside* the card, smaller than anything in YouTube's own
 * layout and in their secondary grey, because it is an annotation on the mock
 * and not part of the interface being mocked. Without it the row is four
 * pictures and no way to say which one you mean; with it inside the card it
 * would be the preview claiming YouTube writes "wild card" over a tile.
 *
 * There is deliberately **no** `data-state` on this figure. The thumbnail knows
 * whether its picture arrived — it is the thing that watches the `<img>` fail —
 * and a second copy of that state out here could disagree with the frame the
 * user is actually looking at.
 */
function Tile({
  role,
  label,
  live,
  children,
}: {
  role: string;
  label: string;
  live: boolean;
  children: React.ReactNode;
}) {
  return (
    <figure
      data-testid="preview-comparison-tile"
      data-role={role}
      data-live={live ? "true" : "false"}
      style={{ width: FEED.cardWidth, margin: 0, flex: "none" }}
    >
      <figcaption
        style={{
          fontSize: COMPARISON.labelFontSize,
          lineHeight: `${COMPARISON.labelLineHeight}px`,
          marginBottom: COMPARISON.labelGap,
          color: "var(--yt-text-2)",
          display: "flex",
          gap: COMPARISON.labelPartsGap,
        }}
      >
        <span>{label}</span>
        {live ? <span data-testid="preview-comparison-live">{LIVE_MARKER}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}
