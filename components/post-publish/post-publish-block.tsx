"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  dismissSwap,
  logMetrics,
  reopenSwap,
  type MetricsState,
} from "@/app/actions/metrics";
import { SaveStatus, useSaveQueue, type SaveState } from "@/components/autosave";
import { useVideoVersion } from "@/components/video-version";
import type { ThumbnailRole } from "@/lib/storage";
import type { Expectation } from "@/lib/metrics";
import type { StageKind } from "@/lib/defaults";

import { ConfirmLive } from "./confirm-live";
import { MetricsPair, type MetricsSubmission, type MetricsValues } from "./metrics-pair";
import { reached } from "@/components/video-sections/sections";

import { RepurposedLane } from "./repurposed-lane";
import { SwapPrompt } from "./swap-prompt";

/**
 * The Publish section: the post-publish loop, in the order it happens.
 *
 * BRIEF.md principle 8 — *publishing is not the last stage* — is the whole
 * shape of this block. It reads top to bottom as the loop does: the video goes
 * live, its first twenty-four hours get written down, the numbers produce a
 * decision about the thumbnail, and only then is there anything to repurpose.
 *
 * PLAN.md is emphatic about what this is **not**: *"Post-publish block (simple,
 * manual entry)"*. No charts, no trend lines, no dashboard. Four numbers typed
 * in from YouTube Studio and one question asked about them. Analytics are
 * explicitly out of scope for v1 (BRIEF.md, "Explicitly out of scope"), and the
 * reason is not effort — it is that this is a *workflow step*. The job is to
 * make the creator look once, decide, and move on.
 *
 * ## One write path, and one place that writes
 *
 * Every write here goes through `app/actions/metrics.ts`, which is the same
 * action `/now`'s rows call. The rules the two surfaces share — the pair, the
 * `metrics_logged_at` stamp, what `published_at` is stamped with on a confirm —
 * live there, once, so a video cannot read differently depending on which
 * screen you look at it from.
 *
 * Inside this component the writes are funnelled through one `useSaveQueue`
 * (`components/autosave.tsx`), which is the page's one save pattern: one save
 * on the wire at a time, a failure stops the queue rather than draining it, a
 * rejected promise is caught rather than taking the route down, and nothing on
 * screen is reverted by a failure.
 */

export interface PostPublishProps {
  videoId: string;
  /** The current stage's kind — what decides whether "confirm live" is offered. */
  stageKind: StageKind | null;
  /** ISO, and its server-formatted date. Non-null means the video is live. */
  publishedAt: string | null;
  publishedLabel: string | null;
  youtubeUrl: string | null;
  /** `YYYY-MM-DD` and its words, for the confirm-live wording. */
  targetPublishDate: string | null;
  targetLabel: string | null;
  /** The target date has arrived (computed from the server's single clock read). */
  dueToConfirm: boolean;

  /** The four post-publish columns. */
  metrics: MetricsValues;
  metricsLoggedAt: string | null;
  swapDismissedAt: string | null;

  /** `coalesce(channels.expected_ctr, median of the last ten)` — see `lib/expectation.ts`. */
  expectation: Expectation;
  /** Which variant is live, for the prompt's wording. */
  shippedRole: ThumbnailRole | null;
  /** A swap was logged at or after `metrics_logged_at`. */
  swappedSinceMetrics: boolean;

  /** The channel's Repurposed stage and what is sitting in it. */
  repurposed: { id: string; name: string; isEnabled: boolean } | null;
  repurposedOccupied: number;
}

/**
 * What a "keep it" / "ask me again" that never reached the server says.
 *
 * The queue's own sentence is written for a form — *nothing you typed has been
 * lost* — and nothing was typed here. A decision either got recorded or it did
 * not, and the useful thing to say is which.
 */
const DECISION_UNREACHABLE = {
  ok: false as const,
  error:
    "Could not reach the server, so the decision was not recorded. Try again.",
  conflict: undefined,
};

/** Nothing to report — what the sub-block that did not send the patch shows. */
const QUIET: SaveState<PostPublishPatch> = { kind: "idle" };

/** The three decisions this block can send. Later ones replace earlier ones. */
type PostPublishPatch =
  | { kind: "metrics"; submission: MetricsSubmission }
  | { kind: "keep" }
  | { kind: "reopen" };

export function PostPublishBlock(props: PostPublishProps) {
  const router = useRouter();
  const version = useVideoVersion();

  /*
    The server render is authoritative; what is kept is only the delta a write
    on this block produced, tagged with the props it was computed over. The
    moment a fresh render arrives — a `revalidatePath` from `/now` logging the
    same video's metrics in another tab, a `router.refresh()` after a confirm —
    the tag stops matching and the new props win.

    This is the flow block's `applied` pattern, and it exists because the
    alternative (seeding `useState` from props) cannot catch up: a `useState`
    initialiser does not re-run, so an external write would leave this copy
    behind for the life of the page.
  */
  const propsVersion = `${props.metricsLoggedAt}|${props.swapDismissedAt}|${props.metrics.impressions}|${props.metrics.ctr}|${props.metrics.views}|${props.metrics.newViewersNote}`;
  const [applied, setApplied] = useState<{
    over: string;
    value: MetricsState;
  } | null>(null);

  const live = applied && applied.over === propsVersion ? applied.value : null;

  const metrics: MetricsValues = live
    ? {
        impressions: live.impressions,
        ctr: live.ctr,
        views: live.views,
        newViewersNote: live.newViewersNote,
      }
    : props.metrics;

  const metricsLoggedAt = live ? live.metricsLoggedAt : props.metricsLoggedAt;
  const swapDismissedAt = live ? live.swapDismissedAt : props.swapDismissedAt;

  /*
    Both stamps are formatted here rather than handed down from the server,
    because `formatStamp` is deterministic: a fixed locale and UTC, so this
    component's server render and its browser render produce the same string
    for the same input, and so does a stamp that arrives from a write a moment
    later. (The page still formats `published_at` and the target date itself —
    those strings are used outside this block too.)
  */
  const dismissedLabel =
    swapDismissedAt === null ? null : formatStamp(swapDismissedAt);
  const loggedLabel =
    metricsLoggedAt === null ? null : formatStamp(metricsLoggedAt);

  /*
    Which sub-block the queue's current state belongs to.

    There is one queue here on purpose — one save on the wire at a time across
    the whole section — but there are two controls, 180px apart, and a single
    status line under the metrics form reported the swap decision's failures in
    the metrics form's words ("Nothing you typed has been lost") after a button
    press in which nothing was typed, while the control that was actually
    pressed said nothing at all. So the state is *routed*: whichever sub-block
    sent the last patch is the one that reports on it, and the other renders
    idle.
  */
  const [reporting, setReporting] = useState<PostPublishPatch["kind"]>("metrics");

  const queue = useSaveQueue<PostPublishPatch>({
    // These are decisions, not deltas: if two are queued, the later one is the
    // one the person meant.
    merge: (_queued, next) => next,
    save: async (patch) => {
      const expectedUpdatedAt = version.peek();

      /*
        A rejected promise — the server unreachable — is the queue's to word
        for the metrics form, where "nothing you typed has been lost" is
        exactly right. It is the wrong sentence for a button press, so the two
        decisions answer for themselves and only the form falls through to the
        queue's wording.
      */
      const result =
        patch.kind === "metrics"
          ? await logMetrics({
              videoId: props.videoId,
              impressions: patch.submission.impressions,
              ctr: patch.submission.ctr,
              views: patch.submission.views,
              newViewersNote: patch.submission.newViewersNote ?? null,
              expectedUpdatedAt,
            })
          : patch.kind === "keep"
            ? await dismissSwap({ videoId: props.videoId, expectedUpdatedAt }).catch(
                () => DECISION_UNREACHABLE,
              )
            : await reopenSwap({ videoId: props.videoId, expectedUpdatedAt }).catch(
                () => DECISION_UNREACHABLE,
              );

      if (!result.ok) {
        return { ok: false, error: result.error, conflict: result.conflict };
      }

      // The page's one version token has to learn what this write produced,
      // or the *next* save anywhere on this page reports a conflict that never
      // happened. See `components/video-version.tsx`.
      version.adopt(result.state.updatedAt);
      setApplied({ over: propsVersion, value: result.state });

      /*
        `/now`'s count and the board both read these columns, and the section
        tab's own state ("logged" / "not logged") is rendered from the server.
        A refresh is what keeps them honest; nothing here is remounted by it,
        so no draft is lost.
      */
      router.refresh();
      return { ok: true };
    },
  });

  const published = props.publishedAt !== null;
  const logged = metricsLoggedAt !== null;

  return (
    <section
      data-testid="post-publish"
      data-published={published ? "true" : "false"}
      data-logged={logged ? "true" : "false"}
      aria-labelledby="post-publish-heading"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id="post-publish-heading" className="text-sm font-semibold">
          Publish
        </h2>
        <p className="text-xs leading-5 text-muted">
          Publishing is not the last stage. Write the first twenty-four hours
          down, decide about the thumbnail, then repurpose.
        </p>
      </div>

      {/* ------------------------------------------------ live, or not yet -- */}

      {published ? (
        <div data-testid="publish-live" className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted">Live</p>
          <p className="text-sm">
            Went live on{" "}
            <span data-testid="publish-live-date" className="font-mono">
              {props.publishedLabel ?? "an unknown date"}
            </span>
            .
          </p>
          {props.youtubeUrl ? (
            <a
              href={props.youtubeUrl}
              data-testid="publish-live-url"
              target="_blank"
              rel="noreferrer"
              className="truncate text-xs underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {props.youtubeUrl}
            </a>
          ) : (
            <p className="text-xs text-muted">
              No URL recorded. Paste it on{" "}
              <Link
                href={`/videos/${props.videoId}?section=schedule`}
                className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Schedule
              </Link>
              .
            </p>
          )}
        </div>
      ) : props.stageKind === "scheduled" ? (
        <ConfirmLive
          videoId={props.videoId}
          initialUrl={props.youtubeUrl ?? ""}
          due={props.dueToConfirm}
          targetLabel={props.targetLabel}
          onConfirmed={() => router.refresh()}
        />
      ) : (
        <p data-testid="publish-not-yet" className="text-xs leading-5 text-muted">
          Not live yet. When this video reaches the Scheduled stage and its
          target date arrives, the offer to confirm it live and record the URL
          appears here.
          {props.targetLabel
            ? ` It is aimed at ${props.targetLabel}.`
            : " No target publish date is set."}
        </p>
      )}

      {/* ------------------------------------------------- the first 24h ---- */}

      {published ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">The first 24 hours</h3>
            <p data-testid="metrics-logged-at" className="text-xs text-muted">
              {loggedLabel ? (
                <>
                  Logged <span className="font-mono">{loggedLabel}</span>
                </>
              ) : (
                "Not logged yet"
              )}
            </p>
          </div>

          <p className="text-xs leading-5 text-muted">
            From YouTube Studio: Content → this video → Analytics. Impressions
            and click-through are one reading and are entered together — a rate
            with no denominator is not a measurement.
          </p>

          <MetricsPair
            values={metrics}
            busy={queue.pending}
            withNote
            onSubmit={(submission) => {
              setReporting("metrics");
              queue.touch();
              queue.send({ kind: "metrics", submission });
            }}
            submitLabel={logged ? "Save" : "Log the first 24 hours"}
          />

          <SaveStatus
            state={reporting === "metrics" ? queue.state : QUIET}
            testId="post-publish-status"
            onRetry={(payload) => queue.send(payload)}
          />
        </div>
      ) : null}

      {/* ------------------------------------------------- the decision ----- */}

      {published && logged && metrics.impressions !== null && metrics.ctr !== null ? (
        <SwapPrompt
          videoId={props.videoId}
          impressions={metrics.impressions}
          ctr={metrics.ctr}
          expectation={props.expectation}
          shippedRole={props.shippedRole}
          dismissedLabel={dismissedLabel}
          swappedSinceMetrics={props.swappedSinceMetrics}
          busy={queue.pending}
          onKeep={() => {
            setReporting("keep");
            queue.touch();
            queue.send({ kind: "keep" });
          }}
          onReopen={() => {
            setReporting("reopen");
            queue.touch();
            queue.send({ kind: "reopen" });
          }}
          /*
            The decision's own status line, inside the prompt rather than 180px
            above it in the metrics form. A refusal has to appear on the control
            that was pressed, or the person watching that control sees nothing
            happen at all.
          */
          status={
            <SaveStatus
              state={reporting === "metrics" ? QUIET : queue.state}
              testId="swap-decision-status"
              onRetry={(payload) => queue.send(payload)}
            />
          }
        />
      ) : null}

      {/* ------------------------------------------------- the lane --------- */}

      {/*
        The lane switch appears exactly when this tab stops claiming there is
        nothing here.

        It is a *channel* setting, and it was rendered unconditionally — so an
        Idea-stage video's Publish tab read "locked · Not live yet" over a live
        control that changes the board for every video in the channel. That is
        the same contradiction the lock itself was lifted to remove, one
        element further down, so it is settled the same way and with the same
        predicate: `reached(stageKind, "scheduled")`, imported from the module
        that decides what the tab says rather than recomputed here. Until then
        the switch lives on any Scheduled or later video, and M7's settings
        screen is where it stops depending on a video at all.
      */}
      {reached(props.stageKind, "scheduled") ? (
        <RepurposedLane
          stage={props.repurposed}
          occupied={props.repurposedOccupied}
          onChanged={() => router.refresh()}
        />
      ) : null}
    </section>
  );
}

/**
 * A timestamp as a date, in UTC with a fixed locale — the same formatting the
 * server render uses, so a label recomputed after a write reads identically to
 * one that came down with the page.
 */
function formatStamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}
