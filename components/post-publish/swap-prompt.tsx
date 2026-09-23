"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { ROLE_LABEL } from "@/components/thumbnails/roles";
import { type ThumbnailRole } from "@/lib/storage";
import {
  formatCtr,
  formatImpressions,
  swapVerdict,
  type Expectation,
} from "@/lib/metrics";

/**
 * "Swap the thumbnail?" — the decision the first twenty-four hours exist to
 * inform.
 *
 * ## It always renders, and that is the point
 *
 * PLAN.md, post-publish: *"Once metrics are logged the 'Swap thumbnail?' prompt
 * **always** renders, coloured red when below expectation."* Not "renders when
 * underperforming". BRIEF.md principle 8 makes the post-publish loop a *step*
 * — check the first 24 hours, swap if needed, then repurpose — and a step that
 * only appears when the tool has already decided the answer is not a step, it
 * is an alert. The creator is the one who decides; this block is what they
 * decide in front of.
 *
 * So there are three states and all three are drawn:
 *
 * - **below** the expectation → urgent. The one place in this section that
 *   takes a colour, because it is the one place where waiting costs something:
 *   *act fast, don't wait days*.
 * - **met** → the same block, quietly. "This is doing what you expected" is
 *   information, and it is also permission to stop looking.
 * - **unknown** → *no verdict at all*. `expectation = coalesce(expected_ctr,
 *   median of the last ten)`, and when neither exists this says so rather than
 *   inventing a number. A made-up threshold in the one place the tool tells you
 *   to act fast is worse than silence.
 *
 * ## "Keep it" is a decision, not a dismissal
 *
 * It writes `swap_dismissed_at`, which stops `/now`'s rule 3 asking. It does
 * **not** hide this block: the prompt stays, says when the decision was made,
 * and offers to reopen it. A decision that vanishes without trace is one nobody
 * can revisit, and the numbers it was made against are still on the screen
 * right above it.
 *
 * ## Why swapping is a link and not a dialog here
 *
 * The swap needs a role that has an asset and a reason, and the question it
 * really asks — *which of these three wins in a feed* — is answered by looking
 * at the three variants beside a competitor's. That is the Thumbnails section.
 * A second swap dialog here would be a second copy of the one rule
 * `swap_thumbnail` exists to keep in one place.
 */
export function SwapPrompt({
  videoId,
  impressions,
  ctr,
  expectation,
  shippedRole,
  dismissedLabel,
  swappedSinceMetrics,
  busy,
  onKeep,
  onReopen,
  status,
}: {
  videoId: string;
  /** Both, always — this block never sees one without the other. */
  impressions: number;
  ctr: number;
  expectation: Expectation;
  /** Which variant is live, when one is. */
  shippedRole: ThumbnailRole | null;
  /** When "keep it" was pressed, formatted on the server. Null = not dismissed. */
  dismissedLabel: string | null;
  /** A swap was logged at or after these numbers were. */
  swappedSinceMetrics: boolean;
  busy: boolean;
  onKeep: () => void;
  onReopen: () => void;
  /**
   * This block's own save status line.
   *
   * "Keep it" used to report its refusal in the metrics form's status line,
   * 180px above the button and in the metrics form's words. A control reports
   * on itself.
   */
  status?: ReactNode;
}) {
  const verdict = swapVerdict(ctr, expectation.value);

  /*
    Urgency stands down once the swap has been made.

    `swappedSinceMetrics` means the creator has already done the thing
    BRIEF.md principle 8 asks for — looked at the numbers and swapped fast. A
    block that keeps the red border, the red heading and "Act now rather than
    in a week" directly above its own sentence saying a swap has been logged is
    the page shouting at somebody who already acted. `/now` gets this right
    (rule 3 excludes a swap logged after `metrics_logged_at`), and the two
    surfaces are supposed to be one claim about one video.
  */
  const urgent =
    verdict.kind === "below" && dismissedLabel === null && !swappedSinceMetrics;

  return (
    <section
      data-testid="swap-prompt"
      data-verdict={verdict.kind}
      data-urgent={urgent ? "true" : "false"}
      data-dismissed={dismissedLabel === null ? "false" : "true"}
      aria-labelledby="swap-prompt-heading"
      className={[
        "flex flex-col gap-3 rounded-card border p-4",
        urgent ? "border-over-limit bg-over-limit/5" : "border-border",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id="swap-prompt-heading"
          className={[
            "text-sm font-semibold",
            urgent ? "text-over-limit" : "",
          ].join(" ")}
        >
          Swap the thumbnail?
        </h3>

        {/* The two numbers, together, in the face reserved for measured
            values — the same strings `/now`'s rule-3 row prints, from the same
            formatters. */}
        <p data-testid="swap-prompt-numbers" className="font-mono text-xs text-muted">
          {formatImpressions(impressions)} impressions · {formatCtr(ctr)}%
          click-through
        </p>
      </div>

      <p data-testid="swap-prompt-verdict" className="text-xs leading-5 text-muted">
        <Verdict
          verdict={verdict}
          expectation={expectation}
          settled={swappedSinceMetrics}
        />
      </p>

      {shippedRole === null ? (
        <p className="text-xs leading-5 text-muted">
          No variant is marked as the one that shipped, so there is nothing
          recorded to swap <em>from</em>.{" "}
          <Link
            href={`/videos/${videoId}?section=thumbnails`}
            className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Mark one in Thumbnails
          </Link>
          .
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted">
          <span className="font-medium text-foreground">
            {ROLE_LABEL[shippedRole]}
          </span>{" "}
          is the one that is live.
        </p>
      )}

      {swappedSinceMetrics ? (
        <p
          data-testid="swap-prompt-already-swapped"
          className="text-xs leading-5 text-muted"
        >
          A swap has already been logged since these numbers were recorded. Give
          it a day and log the next twenty-four hours again.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/videos/${videoId}?section=thumbnails`}
          data-testid="swap-prompt-open"
          className={[
            // 44px under a thumb (M10 review): the next step in the week.
            "rounded-button border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent thumb:inline-flex thumb:min-h-11 thumb:items-center",
            urgent
              ? "border-over-limit text-over-limit hover:bg-over-limit/10"
              : "border-border hover:border-accent",
          ].join(" ")}
        >
          {swappedSinceMetrics ? "Swap again…" : "Swap the thumbnail…"}
        </Link>

        {/*
          "Keep it" is not offered for a thumbnail that was not kept.

          It writes `swap_dismissed_at`, which means *I looked and decided this
          thumbnail is not the problem* — a claim nobody can make about a
          thumbnail they have already replaced. The question has been answered
          by acting, which is the better of the two answers, so the resting
          state here is the sentence above rather than a third button.
        */}
        {swappedSinceMetrics ? null : dismissedLabel === null ? (
          <button
            type="button"
            data-testid="swap-prompt-keep"
            disabled={busy}
            onClick={onKeep}
            className="rounded-button border border-border px-3 py-2 text-sm outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 thumb:min-h-11"
          >
            Keep it
          </button>
        ) : (
          <button
            type="button"
            data-testid="swap-prompt-reopen"
            disabled={busy}
            onClick={onReopen}
            className="rounded-button px-3 py-2 text-sm text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 thumb:min-h-11"
          >
            Ask me again
          </button>
        )}
      </div>

      {status}

      {dismissedLabel === null ? null : (
        <p
          data-testid="swap-prompt-dismissed"
          className="text-xs leading-5 text-muted"
        >
          You decided to keep this thumbnail on{" "}
          <span className="font-mono">{dismissedLabel}</span>. It has stopped
          asking on <code className="font-mono">/now</code>, and the decision is
          here rather than gone.
        </p>
      )}
    </section>
  );
}

/** The sentence under the numbers. Three states, and one of them is silence. */
function Verdict({
  verdict,
  expectation,
  settled,
}: {
  verdict: ReturnType<typeof swapVerdict>;
  expectation: Expectation;
  /** A swap has already been logged since these numbers — nothing is urgent. */
  settled: boolean;
}) {
  if (verdict.kind === "unknown") {
    return (
      <>
        There is nothing to measure this against yet — no expected click-through
        is set for this channel, and no other video here has its first
        twenty-four hours logged. This prompt is the step, not the verdict: look
        at the number and decide.
      </>
    );
  }

  const against =
    expectation.source === "channel"
      ? `the ${formatCtr(verdict.expectation)}% this channel expects`
      : `the ${formatCtr(verdict.expectation)}% median of its last ${expectation.sampleSize} logged ${
          expectation.sampleSize === 1 ? "video" : "videos"
        }`;

  if (verdict.kind === "below") {
    return (
      <>
        <span
          className={settled ? "font-medium" : "font-medium text-over-limit"}
        >
          {formatCtr(verdict.shortfall)} points below
        </span>{" "}
        {against}.{" "}
        {settled
          ? "That is what the swap was for."
          : "Act now rather than in a week: a swap is worth most while the video is still being shown."}
      </>
    );
  }

  return <>At or above {against}. Nothing here needs rescuing.</>;
}
