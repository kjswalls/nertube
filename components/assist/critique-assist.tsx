"use client";

import { useState } from "react";

import { critiqueThumbnails, type CritiqueAnswer } from "@/app/actions/assist";
import {
  useThumbnailAssistTarget,
  type ThumbnailAssistVariant,
} from "@/components/thumbnails/assist-target";
import { ROLE_LABEL } from "@/components/thumbnails/roles";
import type { ThumbnailRole } from "@/lib/storage";

import {
  AssistFailure,
  AssistFixtureNotice,
  AssistMetaLine,
  AssistNoticeLine,
  AssistPanel,
  AssistPending,
  AssistPillButton,
  Proposal,
  useAssistFocus,
} from "./chrome";
import { useAssistRun } from "./run";

/**
 * "Critique at tile size" — the assist that looks at the pictures.
 *
 * M4 placed this pill in the thumbnails section and left it disabled, with the
 * same honest note the packaging one carried: the layout decision was worth
 * making early, and a listener behind a button nobody can press is the illusion
 * of a feature. This is the button, connected.
 *
 * ## Why this one judges rather than generates
 *
 * BRIEF.md's second principle is that a thumbnail **concept** and a thumbnail
 * **asset** are two different things at two different stages, and this section
 * is the assets. Nothing in this app generates an image, and nothing here
 * pretends to: the concept was written at packaging (there is a pill for
 * proposing those, beside that field), the three files were made by a person,
 * and what a model can usefully add at this point is the one thing the person
 * cannot do for themselves — see their own thumbnail for the first time, small,
 * beside the title, the way a stranger meets it. So the answer is three
 * verdicts and a role it would ship, never an image and never a prompt for one.
 *
 * ## Why the answer is not kept
 *
 * `videos.brainstorm_last` makes reopening the title panel free, because those
 * proposals are about text that has not changed. A verdict is about *the bytes
 * that were in the bucket when it ran*. Replace the wild card and a stored
 * verdict becomes a confident paragraph about an image that no longer exists,
 * which is worse than no verdict because it reads as current. The panel says as
 * much, and asking again is one click.
 *
 * ## Accepting
 *
 * A critique's proposal is *which one to ship*, so accepting it ships that one
 * — through the section's own path, which is `swap_thumbnail` and nothing else
 * (`update (shipped_role)` is revoked from clients). When something is already
 * live that path opens the swap dialog, and the model's sentence arrives in the
 * textarea as a starting point the person edits or deletes before the log row
 * is written. The log is a record of what *they* decided; nothing may write in
 * it without being read first.
 */

const PREFIX = "critique";

export function ThumbnailCritiqueAssist({ videoId }: { videoId: string }) {
  const target = useThumbnailAssistTarget();
  const run = useAssistRun<CritiqueAnswer>();
  const [open, setOpen] = useState(false);
  /** Bumped on every press, so pressing the pill again re-aims focus. */
  const [nonce, setNonce] = useState(0);
  const headingRef = useAssistFocus<HTMLHeadingElement>(nonce);

  const variants = target?.variants ?? [];
  const ready = variants.filter((variant) => variant.hasAsset).length;
  const { state } = run;

  const ask = () => void run.ask(() => critiqueThumbnails({ videoId }));

  function press() {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setNonce((previous) => previous + 1);
    // The pill is the ask: pressing it with nothing to show is what starts the
    // call, and pressing it again with an answer on screen must not spend
    // another one. Nothing is stored between sittings, so "an answer on screen"
    // is the only thing that can make this free.
    if (state.data === null && !state.pending && state.failure === null) ask();
  }

  function close() {
    /*
      Closing ends the sitting, and the verdict goes with it.

      Whatever was in flight is no longer wanted — the call itself cannot be
      recalled, and the panel has never claimed otherwise. The answer is thrown
      away too, which is the same rule as not storing it: a verdict is about
      the images as they were, and a thumbnail can be replaced between closing
      this and opening it again. Reopening therefore always asks, and the panel
      says so before it is closed.
    */
    run.forget();
    setOpen(false);
  }

  if (!target) {
    return (
      <span className="text-xs text-muted">
        The critique is only available beside the thumbnail variants.
      </span>
    );
  }

  return (
    <div
      className={[
        "flex flex-col items-end gap-2",
        open ? "w-full" : "ml-auto",
      ].join(" ")}
    >
      <AssistPillButton
        verb="Critique at tile size"
        title={
          ready === 0
            ? "Nothing to judge yet — upload at least one variant first."
            : "Judges each uploaded variant against the concept at the size a viewer meets it."
        }
        expanded={open}
        disabled={ready === 0}
        badge={ready === 0 ? undefined : `${ready}/3`}
        onClick={press}
      />

      {ready === 0 ? (
        <p data-testid="critique-nothing" className="text-xs text-muted">
          Upload a variant and this can look at it.
        </p>
      ) : null}

      {open ? (
        <AssistPanel
          testId={`${PREFIX}-panel`}
          labelledBy="critique-heading"
          onClose={close}
        >
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h3
                id="critique-heading"
                ref={headingRef}
                tabIndex={-1}
                className="text-sm font-semibold outline-none"
              >
                Critique — your thumbnails at 360px, judged
              </h3>
              <p data-testid="critique-provenance" className="text-xs text-muted">
                {state.pending
                  ? "Looking now…"
                  : state.data === null
                    ? "Nothing asked for yet."
                    : `Judged just now, against ${
                        target.hasConcept
                          ? "the concept above"
                          : "the title alone — no concept is written, so this is half the comparison"
                      }. Not kept: it is about the images as they are now, so ask again after you change one.`}
              </p>
              {/*
                The same admission the other two panels make, from the same
                component: a verdict written by the fixtures is not a judgement
                about these pictures, and a panel that did not say so would be
                the only place in this app capable of implying otherwise.
              */}
              <AssistFixtureNotice
                prefix={PREFIX}
                provider={state.meta?.provider ?? null}
              />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid={`${PREFIX}-ask-again`}
                onClick={ask}
                disabled={state.pending}
                className="rounded-button border border-border px-2 py-1 text-xs font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                {state.data === null ? "Ask" : "Ask again"}
              </button>
              <button
                type="button"
                data-testid={`${PREFIX}-close`}
                onClick={close}
                className="rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
              >
                Close
              </button>
            </div>
          </header>

          {state.pending ? (
            <AssistPending
              prefix={PREFIX}
              startedAt={state.startedAt}
              what="Looking at the images. This one sends pictures, so it is the slowest of them — the rest of the page still works while it does."
              onCancel={() => run.cancel()}
            />
          ) : null}

          {state.failure ? (
            <>
              <AssistFailure
                prefix={PREFIX}
                failure={state.failure}
                onRetry={ask}
                disabled={state.pending}
              />
              {/* A fixture must not pass itself off as a model on the failure
                  path either. See `AssistFixtureNotice`. */}
              <AssistFixtureNotice
                prefix={PREFIX}
                provider={state.failure.provider}
                variant="failure"
              />
            </>
          ) : null}

          {state.notice ? (
            <AssistNoticeLine prefix={PREFIX} notice={state.notice} />
          ) : null}

          {/*
            `marksFallback={false}`: this panel marks nothing when the model's
            own pick cannot be used. A ranked list can fall back to its first
            survivor honestly; "would ship" cannot fall back at all, because it
            is a claim about one specific image and the button under it writes
            a real `swap_thumbnail`.
          */}
          <AssistMetaLine
            prefix={PREFIX}
            meta={state.fresh ? state.meta : null}
            marksFallback={false}
          />

          {(state.data?.skipped ?? []).map((skip) => (
            <p
              key={skip.role}
              data-testid="critique-skipped"
              data-role={skip.role}
              className="text-xs text-attention"
            >
              {skip.reason}
            </p>
          ))}

          {state.data === null ? (
            state.pending ? null : (
              <p className="text-xs text-muted">
                Nothing here yet. “Ask” sends the variants you have uploaded,
                with the title and the written concept, and comes back with a
                verdict on each and the one it would ship. It never makes an
                image — the concept is the description, these are the files.
              </p>
            )
          ) : (
            <Verdicts
              answer={state.data}
              variants={variants}
              onShip={(role, reason, from) => {
                target.ship(role, reason, from);
                run.note(
                  variants.some((variant) => variant.live)
                    ? "Opening the swap — its sentence is in the box, so edit it before you confirm. The log records what you write, not what it said."
                    : `Shipping ${ROLE_LABEL[role].toLowerCase()}. It is logged as chosen at launch.`,
                );
              }}
            />
          )}
        </AssistPanel>
      ) : null}
    </div>
  );
}

/** The three verdicts, in the section's own role order. */
function Verdicts({
  answer,
  variants,
  onShip,
}: {
  answer: CritiqueAnswer;
  variants: readonly ThumbnailAssistVariant[];
  onShip: (
    role: ThumbnailRole,
    reason: string,
    from: HTMLElement | null,
  ) => void;
}) {
  const byRole = new Map(variants.map((variant) => [variant.role, variant]));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        <span data-testid="critique-count" className="font-mono">
          {answer.verdicts.length}
        </span>{" "}
        {answer.verdicts.length === 1 ? "verdict" : "verdicts"} — the tool
        talking about pictures you made. Shipping one is your decision, and it
        is logged as yours.
      </p>

      <ul data-testid="critique-verdicts" className="flex flex-col gap-2">
        {answer.verdicts.map((verdict) => {
          const variant = byRole.get(verdict.role);
          const live = variant?.live ?? false;
          const picked = answer.recommendedRole === verdict.role;

          return (
            <Proposal
              key={verdict.role}
              testId="critique-verdict"
              chip="Verdict"
              picked={picked}
              pickedLabel="Would ship"
              data-role={verdict.role}
              badge={
                <span className="text-sm font-medium">
                  {ROLE_LABEL[verdict.role]}
                </span>
              }
            >
              <div className="flex flex-wrap gap-2">
                <Flag
                  ok={verdict.readsAtTileSize}
                  yes="Reads at tile size"
                  no="Does not read at tile size"
                  testId="critique-reads"
                />
                <Flag
                  ok={verdict.complementsTitle}
                  yes="Adds to the title"
                  no="Repeats the title"
                  testId="critique-complements"
                />
              </div>

              <p data-testid="critique-note" className="text-xs text-muted">
                {verdict.note}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="critique-ship"
                  data-role={verdict.role}
                  aria-label={`Ship the ${ROLE_LABEL[verdict.role].toLowerCase()} thumbnail`}
                  disabled={live || !variant?.hasAsset}
                  onClick={(event) =>
                    onShip(verdict.role, verdict.note, event.currentTarget)
                  }
                  className="rounded-button border border-border bg-background px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {live
                    ? "Already live"
                    : `Ship the ${ROLE_LABEL[verdict.role].toLowerCase()}`}
                </button>
              </div>
            </Proposal>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One of the two questions the packaging checklist actually asks about a
 * thumbnail, answered yes or no.
 *
 * Both sentences are written out rather than shown as a tick or a cross: a
 * checklist item that reads "Thumbnail concept still readable at phone-tile
 * size" deserves an answer in the same words, and a green tick beside a
 * paragraph is the kind of thing people read backwards.
 */
function Flag({
  ok,
  yes,
  no,
  testId,
}: {
  ok: boolean;
  yes: string;
  no: string;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      data-ok={ok ? "true" : "false"}
      className={[
        "rounded-button border px-1.5 py-0.5 text-[11px]",
        ok ? "border-border text-muted" : "border-attention/60 text-attention",
      ].join(" ")}
    >
      {ok ? yes : no}
    </span>
  );
}
