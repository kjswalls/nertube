"use client";

import { useState } from "react";

import type { VideoState } from "@/app/actions/videos";
import type { BucketChoices } from "@/lib/buckets";

import { BucketRow } from "./bucket-row";
import { TagEditor } from "./tag-editor";

/**
 * Filing: the two content buckets and the tags.
 *
 * ## Why it is here, on the Packaging tab
 *
 * These are the idea-bank fields — the ones capture's disclosure writes and the
 * ones `/c/[slug]/ideas` filters and counts on. They had nowhere to live on
 * `/videos/[id]`, which meant an idea captured in ten seconds could never be
 * filed afterwards: the matrix's empty cells could only ever be filled by a new
 * capture, and a tag typo was permanent.
 *
 * They sit under the packaging block rather than in Schedule, because what a
 * video *is* — this channel's money pillar, done as a review, tagged `index
 * funds` — is the same kind of fact as its title and its thumbnail concept, and
 * a different kind from its target date. The tab a bare `/videos/[id]` opens at
 * is Packaging, which is also the first screen an idea is opened on; filing
 * belongs where you land, not a tab along.
 *
 * ## Both halves write the same way
 *
 * One version token, one write path (`updateVideo`), one save queue each
 * (`components/autosave.tsx`), and one status line each. Nothing here is a new
 * mechanism — see `save-filing.ts`, which is the only thing either of them
 * calls.
 */
export function FilingBlock({
  videoId,
  choices,
  verticalId,
  horizontalId,
  tags,
  vocabulary,
}: {
  videoId: string;
  /** This video's channel's buckets, split by axis, in position order. */
  choices: BucketChoices;
  verticalId: string | null;
  horizontalId: string | null;
  tags: readonly string[];
  /** The tags this channel's other videos already use, most-used first. */
  vocabulary: readonly string[];
}) {
  /**
   * The channel's vocabulary, grown by what this page saves.
   *
   * The list comes down with the server render, so a tag added here would not
   * appear as a suggestion until the route was re-rendered — which matters for
   * the obvious case of removing a tag and immediately wanting it back. Only
   * grown, never pruned: a tag this video drops may well still be on five
   * others, and this page cannot know.
   */
  const [learned, setLearned] = useState<readonly string[]>([]);

  function absorb(video: VideoState): void {
    setLearned((current) => {
      const known = new Set(
        [...vocabulary, ...current].map((tag) => tag.toLocaleLowerCase()),
      );
      const added = video.tags.filter(
        (tag) => !known.has(tag.toLocaleLowerCase()),
      );
      return added.length === 0 ? current : [...current, ...added];
    });
  }

  return (
    <section
      data-testid="filing-block"
      aria-labelledby="filing-heading"
      className="flex flex-col gap-4 border-t border-border pt-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="filing-heading" className="text-sm font-semibold">
          Filing
        </h2>
        <p className="text-xs text-muted">
          Where this sits in the channel’s matrix, and how it will be found
          again. One pillar and one format at most — a video belongs to its
          channel’s buckets and to no others.
        </p>
      </div>

      <BucketRow
        videoId={videoId}
        choices={choices}
        verticalId={verticalId}
        horizontalId={horizontalId}
      />

      <TagEditor
        videoId={videoId}
        initial={tags}
        vocabulary={[...vocabulary, ...learned]}
        onSaved={absorb}
      />
    </section>
  );
}
