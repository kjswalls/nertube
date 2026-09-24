"use client";

import { useState } from "react";

import { assist } from "@/app/actions/assist";
import { assistPrompt, readPastedReply } from "@/app/actions/assist-manual";
import type { AssistMode } from "@/lib/assist/select";
import type { CapReached } from "@/lib/assist/types";
import { sameLabel } from "@/lib/text";

import {
  AssistCapNote,
  AssistFailure,
  AssistFixtureNotice,
  AssistManualEntry,
  AssistMetaLine,
  AssistNoticeLine,
  AssistPanel,
  AssistPending,
  AssistPillButton,
  AssistProvenance,
  Proposal,
  useAssistFocus,
} from "./chrome";
import { OpenInClaude, useManualRoute } from "./manual";
import { useAssistTarget } from "./packaging-assist";
import { useAssistRun } from "./run";
import type { StoredAssistEntryValue, StoredBrainstormView } from "./stored";

/**
 * "Suggest concepts" — the assist beside the *written* thumbnail concept.
 *
 * M2 placed this pill next to the concept box and left it inert; this is the
 * button, connected. It proposes **concepts**, which BRIEF.md principle 2 is
 * emphatic are not thumbnails: the concept is a description of the shot to
 * film, locked at packaging so the right footage gets captured on the day, and
 * the image files are made much later and live in the Thumbnails section. So a
 * proposal here is prose describing a picture, and nothing in this app will
 * ever hand back an image or a prompt for one. The panel says so where a
 * person can read it, because this is the exact spot where the two ideas are
 * most likely to be conflated.
 *
 * ## Why this is its own control and not a third tab on the brainstorm panel
 *
 * The brainstorm panel sits beside the title candidates and answers two
 * questions about *lists* — twenty titles, three hooks — where accepting means
 * appending a row. The concept is a single field, and accepting means
 * **replacing** what is in it. That is a different gesture with a different
 * risk (it can destroy something the person wrote), it belongs beside the box
 * it overwrites rather than three fields away, and it needs an undo that a
 * list-shaped panel has no use for.
 *
 * What it is *not* is a second mechanism: the in-flight state is
 * `useAssistRun`, the waiting row, the failure block, the notice with its undo
 * and the proposal frame are all `components/assist/chrome.tsx`, and the
 * answer is stored in the same `videos.brainstorm_last` envelope under its own
 * key. Learn one pill and you have learned this one.
 *
 * ## Accepting writes through the packaging block
 *
 * `acceptConcept` is the block's own function, which pushes an ordinary edit
 * into the one save queue. This component never calls `updateVideo`, never
 * holds a copy of the field, and is not a second write path — the rule seven
 * milestones of reviewers have policed.
 */

const PREFIX = "concept-assist";

export function ConceptAssist({
  videoId,
  initial,
  mode = "api",
  capReached = null,
}: {
  videoId: string;
  /**
   * `videos.brainstorm_last`, read on the server — the same column the
   * brainstorm panel reads, under its own key. Reopening this costs no call.
   */
  initial: StoredBrainstormView;
  /** M11: `manual` opens on Open in Claude and never asks an API. */
  mode?: AssistMode;
  /**
   * M11 integration: set when the page found this month's API spending at
   * the cap, which is why `mode` is `manual` — the panel says so above Open
   * in Claude. `readAssistView` in `lib/assist/mode.ts`.
   */
  capReached?: CapReached | null;
}) {
  const target = useAssistTarget();
  const run = useAssistRun<StoredAssistEntryValue>(initial.concepts);
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  /**
   * The clock, read when the panel is opened rather than during render. "Asked
   * for two hours ago" is a subtraction, and a subtraction done while
   * rendering is a different answer on every re-render.
   */
  const [now, setNow] = useState(0);
  const headingRef = useAssistFocus<HTMLHeadingElement>(nonce);

  const { state } = run;
  const entry = state.data;

  // No mapping: `assist()` already answers in the shape `useAssistRun`
  // consumes, which is the same shape `critiqueThumbnails()` answers in. One
  // result contract across every assist in the app.
  /** The last ask went to the API, or was a pasted reply being read (M11). */
  const [reading, setReading] = useState(false);

  const ask = () => {
    setReading(false);
    route.clearCap();
    void run.ask(() => assist({ videoId, kind: "concepts" }));
  };

  /** A reply pasted back from claude.ai, into the same run. See the brainstorm. */
  const read = async (reply: string): Promise<number | null> => {
    setReading(true);
    let count: number | null = null;
    await run.ask(async () => {
      const answer = await readPastedReply({ videoId, kind: "concepts", reply });
      count = answer.ok ? answer.data.suggestions.length : null;
      return answer;
    });
    if (count !== null) route.clearCap();
    return count;
  };

  /** Opened with "or Open in Claude": nothing was asked (review, finding 8). */
  const [manualEntry, setManualEntry] = useState(false);

  // Which failure belongs to which box, and whether Open in Claude leads —
  // the one rule, in manual.tsx. See the brainstorm.
  const route = useManualRoute({ mode, failure: state.failure, reading, manualEntry });
  const { pasteFailure, apiFailure, capFailure, manualFirst } = route;

  function openManual() {
    setNow(Date.now());
    setManualEntry(true);
    setOpen(true);
    setNonce((previous) => previous + 1);
  }

  function press() {
    if (open) {
      close();
      return;
    }
    setNow(Date.now());
    setManualEntry(false);
    setOpen(true);
    setNonce((previous) => previous + 1);
    // The pill is the ask when there is nothing to show, and free when there
    // is: `brainstorm_last` exists so that closing and reopening never costs a
    // second call. With no API key there is nothing to ask (M11).
    if (mode === "api" && entry === null && !state.pending && state.failure === null) {
      ask();
    }
  }

  function close() {
    // Closing ends the sitting. What was in flight is no longer wanted — the
    // call cannot be recalled and this has never claimed otherwise — and what
    // is on screen stops being "just now".
    run.settle();
    setOpen(false);
  }

  if (!target) {
    return (
      <span className="text-xs text-muted">
        Concept suggestions are only available beside the concept field.
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
      <div className="flex flex-wrap items-center justify-end gap-1">
      {mode === "api" && !open ? <AssistManualEntry prefix={PREFIX} onClick={openManual} /> : null}
      <AssistPillButton
        verb="Suggest concepts"
        title={
          mode === "manual"
            ? "Writes a prompt for thumbnail concepts to film against, to run in your own claude.ai conversation."
            : "Proposes thumbnail concepts to film against — descriptions of a shot, never an image."
        }
        expanded={open}
        badge={entry && !open ? "saved" : undefined}
        onClick={press}
      />
      </div>

      {open ? (
        <AssistPanel
          testId={`${PREFIX}-panel`}
          labelledBy="concept-assist-heading"
          onClose={close}
        >
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h3
                id="concept-assist-heading"
                ref={headingRef}
                tabIndex={-1}
                className="text-sm font-semibold outline-none"
              >
                Brainstorm — thumbnail concepts, proposed
              </h3>
              <AssistProvenance
                prefix={PREFIX}
                entry={entry}
                pending={state.pending}
                fresh={state.fresh}
                now={now}
              />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {mode === "api" ? (
                <button
                  type="button"
                  data-testid={`${PREFIX}-ask-again`}
                  onClick={ask}
                  disabled={state.pending}
                  className="rounded-button border border-border px-2 py-1 text-xs font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 thumb:min-h-11"
                >
                  {entry === null ? "Ask" : "Ask again"}
                </button>
              ) : null}
              <button
                type="button"
                data-testid={`${PREFIX}-close`}
                onClick={close}
                className="rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
              >
                Close
              </button>
            </div>
          </header>

          <p className="text-xs text-muted">
            A concept is a <strong className="font-medium">description of a
            shot</strong> — what is in frame, the expression, any words on the
            image — so the right thing gets filmed on the day. It is not a
            picture, and the files themselves are three sections along, near
            publish.
          </p>

          {capReached ? <AssistCapNote prefix={PREFIX} capReached={capReached} /> : null}
          {capFailure ? (
            <AssistFailure
              prefix={PREFIX}
              failure={capFailure}
              onRetry={ask}
              disabled={state.pending}
            />
          ) : null}

          {/* Open in Claude (M11). See `components/assist/manual.tsx`. */}
          <OpenInClaude
            prefix={PREFIX}
            primary={manualFirst}
            what="four thumbnail concepts"
            getPrompt={() => assistPrompt({ videoId, kind: "concepts" })}
            onRead={read}
            reading={state.pending && reading}
            busy={state.pending}
            failure={pasteFailure}
          />

          {state.pending ? (
            <AssistPending
              prefix={PREFIX}
              startedAt={state.startedAt}
              what={
                reading
                  ? "Reading Claude’s reply."
                  : "Thinking. Four concepts, each one a shot you could film — the rest of the page still works while it does."
              }
              onCancel={() => run.cancel()}
            />
          ) : null}

          {apiFailure ? (
            <>
              <AssistFailure
                prefix={PREFIX}
                failure={apiFailure}
                onRetry={ask}
                disabled={state.pending}
              />
              {/* A fixture must not pass itself off as a model on the failure
                  path either. See `AssistFixtureNotice`. */}
              <AssistFixtureNotice
                prefix={PREFIX}
                provider={apiFailure.provider}
                variant="failure"
              />
            </>
          ) : null}

          {state.notice ? (
            <AssistNoticeLine prefix={PREFIX} notice={state.notice} />
          ) : null}

          {!state.persisted ? (
            <p data-testid={`${PREFIX}-unsaved`} className="text-xs text-attention">
              These could not be saved for next time, so closing the panel will
              lose them. Take the one you want first.
            </p>
          ) : null}

          <AssistMetaLine prefix={PREFIX} meta={state.fresh ? state.meta : null} />

          {entry === null ? (
            state.pending ? null : (
              <p className="text-xs text-muted">
                {mode === "manual"
                  ? "Nothing here yet. Open in Claude copies a prompt built from the title, the notes and the channel’s voice guide; paste Claude’s reply above and its concepts appear here, each with a reason."
                  : "Nothing here yet. “Ask” reads the title, the notes and the channel’s voice guide, and comes back with concepts and a reason for each."}
              </p>
            )
          ) : (
            <ConceptProposals
              entry={entry}
              current={target.concept}
              onTake={(text) => {
                const outcome = target.acceptConcept(text);
                if (!outcome.ok) {
                  run.note(outcome.reason ?? "That could not be used as the concept.");
                  return;
                }
                if (outcome.previous.trim() === "") {
                  run.note(
                    "Written into the concept box. It is your field now — edit it there like anything else you wrote.",
                  );
                  return;
                }
                run.note({
                  text: "Replaced the concept. What was there is one press away.",
                  undoLabel: "Put it back",
                  undo: () => {
                    target.restoreConcept(outcome.previous);
                    run.note("Put the concept back the way you had it.");
                  },
                });
              }}
            />
          )}
        </AssistPanel>
      ) : null}
    </div>
  );
}

/** The proposals themselves, drawn as the tool talking. */
function ConceptProposals({
  entry,
  current,
  onTake,
}: {
  entry: StoredAssistEntryValue;
  /** What the concept box says right now, for "already the concept". */
  current: string;
  onTake: (text: string) => void;
}) {
  const written = current.trim() !== "";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        <span data-testid={`${PREFIX}-count`} className="font-mono">
          {entry.suggestions.length}
        </span>{" "}
        proposals — the tool talking. One of them becomes your writing the
        moment you take it.
        {written
          ? " Taking one replaces what is in the box, and the line underneath will offer it back."
          : ""}
      </p>

      <ul data-testid={`${PREFIX}-suggestions`} className="flex flex-col gap-2">
        {entry.suggestions.map((suggestion, index) => {
          const same = sameLabel(current, suggestion.text);
          return (
            <Proposal
              key={`${index}-${suggestion.text}`}
              testId={`${PREFIX}-suggestion`}
              chip="Proposal"
              picked={entry.recommended === index}
              data-duplicate={same ? "true" : "false"}
            >
              <p data-testid="suggestion-text" className="text-sm">
                {suggestion.text}
              </p>
              <p data-testid="suggestion-rationale" className="text-xs text-muted">
                {suggestion.rationale}
              </p>
              {/* The comparison, where the answer gave one. See the same note
                  in `brainstorm-panel.tsx`: the label used to sit over this
                  proposal's own rationale, which is not a reason for a pick. */}
              {entry.recommended === index && entry.recommendedReason ? (
                <p data-testid={`${PREFIX}-pick-reason`} className="text-xs text-muted">
                  <strong className="text-foreground">Why it picked this one: </strong>
                  {entry.recommendedReason}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="suggestion-use"
                  aria-label={
                    written
                      ? `Replace the thumbnail concept with “${suggestion.text}”`
                      : `Use “${suggestion.text}” as the thumbnail concept`
                  }
                  disabled={same}
                  onClick={() => onTake(suggestion.text)}
                  className="rounded-button border border-border bg-background px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 thumb:min-h-11"
                >
                  {same
                    ? "Already the concept"
                    : written
                      ? "Replace the concept"
                      : "Use as the concept"}
                </button>
              </div>
            </Proposal>
          );
        })}
      </ul>
    </div>
  );
}
