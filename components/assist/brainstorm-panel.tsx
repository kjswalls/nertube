"use client";

import { useCallback } from "react";

import { TITLE_WARN_LENGTH } from "@/lib/packaging";
import type { CapReached } from "@/lib/assist/types";
import type { AssistMode } from "@/lib/assist/select";
import { sameLabel } from "@/lib/text";

import { capacityLine, describeAcceptance } from "./acceptance";
import {
  AssistCapNote,
  AssistFailure,
  AssistFixtureNotice,
  AssistMetaLine,
  AssistNoticeLine,
  AssistPanel,
  AssistPending,
  AssistProvenance,
  Proposal,
  useAssistFocus,
} from "./chrome";
import { OpenInClaude, useManualRoute, type ManualPromptAnswer } from "./manual";
import { useAssistTarget } from "./packaging-assist";
import type { AssistNotice, AssistRunState } from "./run";
import type { StoredAssistEntryValue } from "./stored";

/**
 * The brainstorm panel.
 *
 * ## Why the rationale is as prominent as the title
 *
 * BRIEF.md's first principle is that packaging is a craft: the title is a fifth
 * of the work and most of the result, and the packaging checklist asks for *ten
 * to twenty* candidates rather than three. A flat list of twenty titles does not
 * teach that — it is a slot machine. A title with a reason beside it does: after
 * a dozen of them you can see what "sells the result" and "creates curiosity"
 * actually look like, and that is the part that is still useful once the panel
 * is closed. So the rationale is never behind a disclosure, one suggestion is
 * marked as the model's own pick, and the pick's reason is spelled out.
 *
 * ## Why everything in here is a proposal
 *
 * Every suggestion is drawn as the *tool talking*: a dashed rule, a "Proposal"
 * chip, a quieter surface than the fields above it. Nothing generated is ever
 * put into a field without somebody pressing a button, and when it is, it lands
 * in the candidate list as an ordinary row marked `source: "ai"` — a field like
 * any other field they wrote. The line between what a model wrote and what the
 * person wrote is one this app must never be the thing that blurs.
 *
 * ## Why it is not a modal
 *
 * A model call takes seconds; PLAN.md budgets up to forty. A dialog over the
 * page for forty seconds is a page you cannot use, so this is inline, the rest
 * of the block stays live while it works, and Cancel is always one click away.
 *
 * ## It renders; it does not fetch
 *
 * Asking, cancelling and remembering all live in
 * `components/assist/brainstorm-assist.tsx`, which stays mounted when this is
 * closed. That is what makes closing and reopening free, and it is why nothing
 * here happens in an effect on mount.
 */

/**
 * Everything known about one of the two questions.
 *
 * Not a type of its own: it is `AssistRunState` from
 * `components/assist/run.ts`, the one in-flight state every assist control in
 * this app uses, carrying a stored brainstorm entry as its answer. This panel
 * used to keep a near-identical `KindView` and its owner used to keep a
 * near-identical copy of the machine that fills it; they agreed by hand, which
 * is the kind of agreement that stops being true. One machine, one state, one
 * set of words for cancelling.
 */
export type KindView = AssistRunState<StoredAssistEntryValue>;

/**
 * The two questions *this* panel answers.
 *
 * It sits beside the title candidates and the hooks, and both of those are
 * lists on the packaging block, so one panel with two tabs is one answer and
 * one place to accept it. The third text assist — thumbnail concepts — is a
 * single field with a replace rather than an add, and it has its own control
 * beside that field (`components/assist/concept-assist.tsx`), built from the
 * same `run.ts` state and the same `chrome.tsx` elements so that it behaves
 * identically. `StoredAssistKind` is the wider set, because
 * `videos.brainstorm_last` keeps all three.
 */
export const PANEL_KINDS = ["titles", "hooks"] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

const LABEL: Record<PanelKind, string> = {
  titles: "Title candidates",
  hooks: "Spoken hooks",
};

/** What each question is waiting for, while it waits. */
const WAITING: Record<PanelKind, string> = {
  titles:
    "Thinking. Twenty titles with reasons takes a few seconds — the rest of the page still works while it does.",
  hooks:
    "Thinking. The hooks it writes have to fit the title and the concept you already chose — the rest of the page still works while it does.",
};

/** What Open in Claude asks for, per question (M11). */
const MANUAL_WHAT: Record<PanelKind, string> = {
  titles: "twenty title candidates",
  hooks: "the spoken hooks this video is missing",
};

export function BrainstormPanel({
  kind,
  nonce,
  now,
  view,
  mode = "api",
  capReached = null,
  reading = false,
  manualEntry = false,
  getPrompt,
  onRead,
  otherHasAnswer,
  onAsk,
  onCancel,
  onKind,
  onNotice,
  onClose,
}: {
  kind: PanelKind;
  /** Bumped every time a pill asks for the panel; moves focus here. */
  nonce: number;
  /** The clock, read in the handler that opened this. See the parent. */
  now: number;
  view: KindView;
  /** M11: `manual` makes Open in Claude the panel's action and hides "Ask". */
  mode?: AssistMode;
  /** Set when the mode is `manual` because the spending cap was reached. */
  capReached?: CapReached | null;
  /** The last attempt on this question was a pasted reply being read. */
  reading?: boolean;
  /** Opened with "or Open in Claude": the steps lead, nothing was asked. */
  manualEntry?: boolean;
  /** The manual prompt for this question, fetched when Open in Claude is pressed. */
  getPrompt: () => Promise<ManualPromptAnswer>;
  /** Read a pasted reply into this question's run: how many it became, or null. */
  onRead: (reply: string) => Promise<number | null>;
  /** Whether the other question already has an answer, for the tab's badge. */
  otherHasAnswer: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onKind: (kind: PanelKind) => void;
  onNotice: (notice: AssistNotice | string) => void;
  onClose: () => void;
}) {
  const target = useAssistTarget();
  const entry = view.data;

  /*
    Focus lands in the panel whenever a pill opens it, and again when it is
    re-aimed at another question. The counter, the waiting row, the failure
    block and the notice line are all `components/assist/chrome.tsx` — the same
    ones the thumbnail critique renders, which is what makes "learn one, learn
    all of them" true rather than a claim in a comment.
  */
  const headingRef = useAssistFocus<HTMLHeadingElement>(`${nonce}:${kind}`);

  const candidates = target?.candidates;
  const hooks = target?.hooks;
  const candidateRoom = target?.candidateRoom ?? 0;
  const hookRoom = target?.hookRoom ?? 0;

  const inCandidates = useCallback(
    (text: string) => (candidates ?? []).some((c) => sameLabel(c.text, text)),
    [candidates],
  );
  const inHooks = useCallback(
    (text: string) => (hooks ?? []).some((hook) => sameLabel(hook.text, text)),
    [hooks],
  );

  const capacity = capacityLine(candidateRoom, hookRoom);

  /*
    Which failure belongs to which box, and whether Open in Claude leads:
    `useManualRoute` in manual.tsx, the one rule all three panels use. A paste
    that could not be read — or never reached the server — is shown under the
    paste box, and its retry is Read; everything else is an API failure with
    the block and "Try again" it always had. The cap's refusal is drawn above
    Open in Claude and stays until the next ask or a reply that reads.
  */
  const route = useManualRoute({
    mode,
    failure: view.failure,
    reading,
    manualEntry,
    latchKey: kind,
  });
  const { pasteFailure, apiFailure, capFailure, manualFirst } = route;
  const ask = () => {
    route.clearCap();
    onAsk();
  };
  const readReply = async (reply: string) => {
    const count = await onRead(reply);
    if (count !== null) route.clearCap();
    return count;
  };

  const addOne = (text: string, rationale: string) => {
    if (!target) return;
    onNotice(describeAcceptance(target.addCandidates([{ text, note: rationale }]), 1));
  };

  const addAll = () => {
    if (!target || !entry) return;
    const items = entry.suggestions.map((suggestion) => ({
      text: suggestion.text,
      note: suggestion.rationale,
    }));
    onNotice(describeAcceptance(target.addCandidates(items), items.length));
  };

  const asHook = (text: string) => {
    if (!target) return;
    const outcome = target.addHook(text);
    onNotice(
      outcome.ok
        ? "Added to your hooks. Pick the strongest one there when you have three."
        : (outcome.reason ?? "That could not be added as a hook."),
    );
  };

  return (
    <AssistPanel
      testId="brainstorm-panel"
      data-kind={kind}
      labelledBy="brainstorm-heading"
      onClose={onClose}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3
            id="brainstorm-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold outline-none"
          >
            Brainstorm — {LABEL[kind].toLowerCase()}, proposed
          </h3>
          <AssistProvenance
            prefix="brainstorm"
            entry={entry}
            pending={view.pending}
            fresh={view.fresh}
            now={now}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {mode === "api" ? (
            <button
              type="button"
              data-testid="brainstorm-ask-again"
              onClick={ask}
              disabled={view.pending}
              className="rounded-button border border-border px-2 py-1 text-xs font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 thumb:min-h-11"
            >
              {entry === null ? "Ask" : "Ask again"}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="brainstorm-close"
            onClick={onClose}
            className="rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            Close
          </button>
        </div>
      </header>

      {/*
        One panel, two questions. Switching keeps whatever the other one has
        already answered — asking for hooks must not throw away twenty titles
        nobody has accepted yet.

        Plain buttons with `aria-pressed`, deliberately not `role="tablist"`: a
        tablist promises arrow-key navigation and a tabpanel relationship, and
        claiming a widget's role without its keyboard behaviour is worse for a
        screen-reader user than not claiming it. These are two buttons that
        change what is below them, which is what they are announced as.
      */}
      <div className="flex gap-1">
        {PANEL_KINDS.map((which) => (
          <button
            key={which}
            type="button"
            aria-pressed={kind === which}
            data-testid={`brainstorm-tab-${which}`}
            onClick={() => onKind(which)}
            className={[
              "rounded-button border px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11",
              kind === which
                ? "border-accent bg-accent/10 font-medium"
                : "border-border hover:bg-surface",
            ].join(" ")}
          >
            {LABEL[which]}
            {kind !== which && otherHasAnswer ? (
              <span className="ml-1 font-mono text-[10px] text-muted">saved</span>
            ) : null}
          </button>
        ))}
      </div>

      {/*
        Open in Claude (M11): the panel's action when there is no API key, a
        quiet disclosure beside "Ask" when there is. Keyed by question only, so
        the prompt copied and the reply pasted belong to the tab they were for
        — and never by whether it leads, which remounted it mid-read (review).
      */}
      {capReached ? <AssistCapNote prefix="brainstorm" capReached={capReached} /> : null}
      {capFailure ? (
        <AssistFailure
          prefix="brainstorm"
          failure={capFailure}
          onRetry={ask}
          disabled={view.pending}
        />
      ) : null}

      <OpenInClaude
        key={kind}
        prefix="brainstorm"
        primary={manualFirst}
        what={MANUAL_WHAT[kind]}
        getPrompt={getPrompt}
        onRead={readReply}
        reading={view.pending && reading}
        busy={view.pending}
        failure={pasteFailure}
      />

      {view.pending ? (
        <AssistPending
          prefix="brainstorm"
          startedAt={view.startedAt}
          what={reading ? "Reading Claude’s reply." : WAITING[kind]}
          onCancel={onCancel}
        />
      ) : null}

      {apiFailure ? (
        <>
          <AssistFailure
            prefix="brainstorm"
            failure={apiFailure}
            onRetry={ask}
            disabled={view.pending}
          />
          {/*
            A fixture must never pass itself off as a model, and a *failure* is
            where that is easiest to believe: a refusal reads as a judgement
            about the notes somebody has just written. The notice above the
            list is rendered from the stored entry, which on a failure is null,
            so this is the same admission rendered from what failed.
          */}
          <AssistFixtureNotice
            prefix="brainstorm"
            provider={apiFailure.provider}
            variant="failure"
          />
        </>
      ) : null}

      {view.notice ? (
        <AssistNoticeLine prefix="brainstorm" notice={view.notice} />
      ) : null}

      {!view.persisted ? (
        <p data-testid="brainstorm-unsaved" className="text-xs text-attention">
          These could not be saved for next time, so closing the panel will lose
          them. Accept the ones you want first.
        </p>
      ) : null}

      <AssistMetaLine prefix="brainstorm" meta={view.fresh ? view.meta : null} />

      {capacity ? (
        <p data-testid="brainstorm-capacity" className="text-xs text-attention">
          {capacity}
        </p>
      ) : null}

      {entry === null ? (
        view.pending ? null : (
          <p className="text-xs text-muted">
            {mode === "manual"
              ? "Nothing here yet. Open in Claude copies a prompt built from this video’s notes, its tags and the channel’s voice guide; paste Claude’s reply above and its proposals appear here, each with a reason."
              : "Nothing here yet. “Ask” reads this video’s notes, its tags and the channel’s voice guide, and comes back with proposals and a reason for each."}
          </p>
        )
      ) : (
        <Suggestions
          kind={kind}
          entry={entry}
          inCandidates={inCandidates}
          inHooks={inHooks}
          candidateRoom={candidateRoom}
          hookRoom={hookRoom}
          onAddOne={addOne}
          onAddAll={addAll}
          onUseAsHook={asHook}
        />
      )}

      {/*
        A second way out at the foot of a long list (M10 review): twenty
        proposals are 4,000px on a phone, and the only Close was at the top.
        Its own test id, so the header's stays unique.
      */}
      {entry !== null && entry.suggestions.length > 3 ? (
        <button
          type="button"
          data-testid="brainstorm-close-foot"
          onClick={onClose}
          className="self-end rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3"
        >
          Close
        </button>
      ) : null}
    </AssistPanel>
  );
}

/** The list itself. Split out so the component above stays about state. */
function Suggestions({
  kind,
  entry,
  inCandidates,
  inHooks,
  candidateRoom,
  hookRoom,
  onAddOne,
  onAddAll,
  onUseAsHook,
}: {
  kind: PanelKind;
  entry: StoredAssistEntryValue;
  inCandidates: (text: string) => boolean;
  inHooks: (text: string) => boolean;
  candidateRoom: number;
  hookRoom: number;
  onAddOne: (text: string, rationale: string) => void;
  onAddAll: () => void;
  onUseAsHook: (text: string) => void;
}) {
  const titles = kind === "titles";
  const recommendedReason = entry.recommendedReason;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          <span data-testid="brainstorm-count" className="font-mono">
            {entry.suggestions.length}
          </span>{" "}
          proposals — the tool talking. They become your writing the moment you
          accept one.
        </p>
        {titles ? (
          <button
            type="button"
            data-testid="brainstorm-add-all"
            onClick={onAddAll}
            disabled={candidateRoom <= 0 || entry.suggestions.length === 0}
            className="rounded-button border border-border bg-background px-2 py-1 text-xs font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 thumb:min-h-11"
          >
            Add all as candidates
          </button>
        ) : null}
      </div>

      <ul data-testid="brainstorm-suggestions" className="flex flex-col gap-2">
        {entry.suggestions.map((suggestion, index) => {
          const recommended = entry.recommended === index;
          const alreadyCandidate = inCandidates(suggestion.text);
          const alreadyHook = inHooks(suggestion.text);
          const overLong = suggestion.text.length > TITLE_WARN_LENGTH;

          return (
            /*
              Drawn through `Proposal` rather than beside it.

              This panel used to repeat the frame by hand — the same dashed
              border, the same accent wash, its own chip and its own pick badge
              — while the concept and critique panels used the component. Two
              copies of a rule that exists so the line between a proposal and
              the person's own writing "cannot be drawn differently twice"
              agreed only by hand, which is the kind of agreement that stops
              being true. The two test ids this panel's suite named first are
              props on the component for exactly this case.
            */
            <Proposal
              key={`${index}-${suggestion.text}`}
              testId="brainstorm-suggestion"
              picked={recommended}
              pickedTestId="brainstorm-pick-badge"
              data-duplicate={alreadyCandidate ? "true" : "false"}
              badge={
                <>
                  <span data-testid="suggestion-text" className="min-w-0 text-sm">
                    {suggestion.text}
                  </span>
                  {titles ? (
                    <span
                      data-testid="suggestion-length"
                      title={
                        overLong
                          ? `Over ${TITLE_WARN_LENGTH} characters — the feed may cut it. Not a refusal: a long title that works still works.`
                          : undefined
                      }
                      className={[
                        "font-mono text-[11px]",
                        overLong ? "text-attention" : "text-muted",
                      ].join(" ")}
                    >
                      {suggestion.text.length}
                    </span>
                  ) : null}
                </>
              }
            >
              <p data-testid="suggestion-rationale" className="text-xs text-muted">
                {suggestion.rationale}
              </p>

              {/*
                The comparison, and only when there is one.

                This label used to sit over the picked row's *own* rationale,
                which says why that one works — not why it beats the others.
                Nothing had ever asked why, so the label was an invitation to
                read a generic sentence as a judgement. `recommended_reason` is
                now a field of the answer, and where the model gave nothing
                usable the badge carries the pick on its own.
              */}
              {recommended && recommendedReason ? (
                <p data-testid="brainstorm-pick-reason" className="text-xs text-muted">
                  <strong className="text-foreground">Why it picked this one: </strong>
                  {recommendedReason}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {titles ? (
                  <button
                    type="button"
                    data-testid="suggestion-add"
                    aria-label={`Add “${suggestion.text}” as a title candidate`}
                    onClick={() => onAddOne(suggestion.text, suggestion.rationale)}
                    disabled={alreadyCandidate || candidateRoom <= 0}
                    className="rounded-button border border-border bg-background px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 thumb:min-h-11"
                  >
                    {alreadyCandidate ? "Already a candidate" : "Add as candidate"}
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid="suggestion-hook"
                  aria-label={`Use “${suggestion.text}” as a hook`}
                  onClick={() => onUseAsHook(suggestion.text)}
                  disabled={alreadyHook || hookRoom <= 0}
                  className="rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 thumb:min-h-11"
                >
                  {alreadyHook ? "Already a hook" : "Use as hook"}
                </button>
              </div>
            </Proposal>
          );
        })}
      </ul>
    </div>
  );
}
