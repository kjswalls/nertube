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
 * ## It is a Server Component, deliberately
 *
 * The heading, the sentence and the section chrome are static, and this page
 * already mounts five sections at once — hydration is one synchronous pass over
 * all of them, and everything added to it widens the window in which a
 * server-rendered control has no handler yet and a first click is swallowed
 * (`e2e/hydration.ts` has the argument). So only the two things that genuinely
 * need a browser are client components: the bucket row and the tag editor. This
 * file holds no state and ships no JavaScript.
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
  inBank,
  tags,
  vocabulary,
}: {
  videoId: string;
  /** This video's channel's buckets, split by axis, in position order. */
  choices: BucketChoices;
  verticalId: string | null;
  horizontalId: string | null;
  /**
   * Is this video in the idea bank — i.e. is its stage the Idea one?
   *
   * The bucket row's idle line says what being unfiled *costs*, and the answer
   * is not the same for an idea and for a video in Packaging: the bank pins
   * `stage_id` to the channel's `kind = 'idea'` stage, so a Packaging video is
   * not in it and must not be told that it is.
   */
  inBank: boolean;
  tags: readonly string[];
  /** The tags this channel's videos already use, most-used first. */
  vocabulary: readonly string[];
}) {
  return (
    <section
      id="video-filing"
      data-testid="filing-block"
      aria-labelledby="filing-heading"
      className="flex flex-col gap-4 border-t border-border pt-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="filing-heading" className="text-sm font-semibold">
          Filing
        </h2>
        <p className="text-xs text-muted">
          Where it sits in the channel’s matrix: one pillar and one format at
          most.
        </p>
      </div>

      <BucketRow
        videoId={videoId}
        choices={choices}
        verticalId={verticalId}
        horizontalId={horizontalId}
        inBank={inBank}
      />

      <TagEditor videoId={videoId} initial={tags} vocabulary={vocabulary} />
    </section>
  );
}
