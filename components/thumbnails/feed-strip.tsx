"use client";

import { FeedComparison, type ComparisonTile } from "@/components/preview/comparison";
import type { ThumbnailRole } from "@/lib/storage";

import { ROLE_LABEL } from "./roles";

/**
 * The three variants as feed tiles, beside somebody else's.
 *
 * ## Why the section draws this at all
 *
 * The three frames above it answer "is this image any good", which is the wrong
 * question: a thumbnail is never seen alone on a white page next to its two
 * siblings. It is seen at 360px in a grid, for about a second, against whatever
 * else the feed put there. The decision being made is *which of these wins in a
 * feed*, so the row draws the feed.
 *
 * ## Why almost nothing is here
 *
 * The row itself is the packaging preview's comparison mode
 * (`components/preview/comparison.tsx`), built from the same `FeedCard`, the
 * same `metrics.ts` numbers and the same honest empty/broken frames as the
 * single-video rendering on the Packaging tab. This file is the seam: it turns
 * three thumbnail *roles* — a domain this section owns and the preview knows
 * nothing about — into the tiles that component takes, and writes the heading
 * that says what the row is for.
 *
 * Keeping it that way round is what stops a second, slightly different YouTube
 * card existing in the codebase: a correction to the real layout moves this row
 * and the packaging preview together, because there is one card.
 */

export interface StripVariant {
  readonly role: ThumbnailRole;
  readonly url: string | null;
  readonly hasAsset: boolean;
  readonly live: boolean;
}

export function FeedStrip({
  variants,
  title,
  channelName,
}: {
  variants: readonly StripVariant[];
  title: string;
  channelName: string;
}) {
  const tiles: ComparisonTile[] = variants.map((variant) => ({
    key: variant.role,
    label: ROLE_LABEL[variant.role],
    url: variant.url,
    hasAsset: variant.hasAsset,
    live: variant.live,
  }));

  return (
    <section aria-labelledby="feed-strip-heading" className="flex flex-col gap-2">
      <h3 id="feed-strip-heading" className="text-sm font-semibold">
        Which one wins in a feed
      </h3>
      {/* What this row is for. What it *is* — one card per variant, plus a
          neighbour — is the frame's own caption, a few pixels below; saying it
          twice was the first thing a look at the rendered page caught. */}
      <p className="text-xs text-muted">
        Only the picture changes from one card to the next, because that is the
        only thing being judged. Everything else is YouTube&rsquo;s own metrics
        out of{" "}
        <code className="font-mono text-[11px] [overflow-wrap:anywhere]">
          components/preview/metrics.ts
        </code>{" "}
        — 360px wide, the two-line clamp, the duration chip over the corner.
      </p>

      <FeedComparison tiles={tiles} title={title} channelName={channelName} />
    </section>
  );
}
