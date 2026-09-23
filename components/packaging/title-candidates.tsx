"use client";

import { useId, useRef, useState } from "react";

import { MAX_CANDIDATES, MAX_CANDIDATE_NOTE_LENGTH, MAX_TITLE_LENGTH, type TitleCandidate } from "@/lib/packaging";

import { useFocusAfterRemove } from "./hash-focus";

import type { RowIssue } from "./row-issue";

/**
 * The title candidate list.
 *
 * BRIEF.md's packaging checklist says, in as many words, *"Generated 10–20
 * title candidates, not 3"*. That is a habit, and a habit is only as likely as
 * the cheapest way to perform it — so the shape of this component is the
 * argument:
 *
 * - **One input, Enter adds, focus stays.** Typing fifteen candidates is fifteen
 *   keystrokes-plus-Enter without ever touching the mouse or hunting for an
 *   "add another" button. A form that made you click "+" first would get three
 *   candidates, every time.
 * - **The count is always on screen**, phrased against the target ("12 —
 *   heading for 10–20") rather than as a bare number, so the habit is visible
 *   rather than implied.
 * - **The note is secondary.** It is the "why this one" that makes choosing
 *   possible later, but asking for it up front would slow the list down, so it
 *   is a second, optional field per row and never blocks adding.
 *
 * Choosing a candidate copies its text into the working title, because that is
 * what choosing *means* here: the gate reads `videos.title`, not the list, and a
 * ticked candidate that left the title empty would be a decision the gate does
 * not believe in.
 */
export function TitleCandidates({
  candidates,
  issue,
  onAdd,
  onEditText,
  onEditNote,
  onCommit,
  onToggleChosen,
  onRemove,
}: {
  candidates: readonly TitleCandidate[];
  /**
   * The element the last save could not write, and why.
   *
   * The list shares one patch and one status line with the working title, the
   * concept and the hooks, so a message about a candidate shown *there* reads
   * as a refusal of whatever the person was actually typing — and does not say
   * which row is at fault. It belongs on the row.
   */
  issue: RowIssue | null;
  onAdd: (text: string) => void;
  onEditText: (id: string, text: string) => void;
  onEditNote: (id: string, note: string) => void;
  /** Blur: the block works out whether anything actually changed. */
  onCommit: () => void;
  onToggleChosen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const addId = useId();
  const noticeId = useId();
  const addRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Below `md`, a long list shows its first rows (and the chosen one) until
   * asked for the rest (M10 review): twenty wrapped candidates were 3,700px
   * on a phone, and the concept and hooks — the gate's next fields — sat five
   * screens under them. The rows stay in the page, only not drawn, so nothing
   * typed in one is lost by folding it away. From `md` up every row shows.
   */
  const [expanded, setExpanded] = useState(false);

  /*
    Where the caret goes after a row is removed.

    Removing a candidate unmounts the button that was just pressed, and focus
    went to `<body>` — no row, no list, nowhere. It goes to the next row's text
    field instead (or the previous one, or the add box when the list empties),
    which is where somebody tidying a list wants to be anyway. Recorded on the
    click and applied after the re-render, because the element to focus does not
    exist yet at click time.
  */
  const focusAfterRemove = useFocusAfterRemove(addRef);

  const count = candidates.length;
  const atLimit = count >= MAX_CANDIDATES;
  const folds = !expanded && count > PHONE_ROWS;

  function add() {
    const text = draft.trim();
    if (text === "") {
      setNotice("Type a title candidate first — an empty one is not a candidate.");
      return;
    }
    if (atLimit) {
      setNotice(
        `That is ${MAX_CANDIDATES} candidates already. The course asks for 10–20; remove some before adding more.`,
      );
      return;
    }
    setNotice(null);
    setDraft("");
    onAdd(text);
    // The point of the whole component: the next candidate is one keystroke
    // away, not one click and one keystroke away.
    addRef.current?.focus();
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${addId}-heading`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${addId}-heading`} className="text-xs font-medium text-muted">
          Title candidates
        </h3>
        <p data-testid="candidate-count" className="text-xs text-muted">
          <span data-testid="candidate-count-number">{count}</span>
          {count === 1 ? " candidate" : " candidates"}
          {count < 10 ? " — aim for 10–20, not 3" : " — in the 10–20 band"}
        </p>
      </div>

      {/* A real form, so Enter submits the way Enter is supposed to. The block
          is not itself a form, so there is nothing to nest inside. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
        className="flex gap-2"
      >
        <label htmlFor={addId} className="sr-only">
          Add a title candidate
        </label>
        <input
          id={addId}
          ref={addRef}
          type="text"
          value={draft}
          placeholder="Another way to say it…"
          autoComplete="off"
          maxLength={MAX_TITLE_LENGTH}
          aria-describedby={noticeId}
          data-testid="candidate-input"
          onChange={(event) => {
            setDraft(event.target.value);
            if (notice) setNotice(null);
          }}
          className="min-w-0 flex-1 rounded-input border border-border bg-background px-3 py-2 font-display text-base outline-none placeholder:font-sans placeholder:text-sm focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
        />
        <button
          type="submit"
          data-testid="candidate-add"
          className="rounded-button border border-border px-3 py-2 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
        >
          Add
        </button>
      </form>

      <p
        id={noticeId}
        role="status"
        data-testid="candidate-notice"
        className="min-h-4 text-xs text-attention"
      >
        {notice ?? ""}
      </p>

      {issue && issue.id === null ? (
        <p
          role="alert"
          data-testid="candidate-issue"
          className="text-xs text-attention"
        >
          {issue.message}
        </p>
      ) : null}

      {count === 0 ? (
        <p className="text-xs text-muted">
          Nothing yet. Write the bad ones too — the tenth is usually the one.
        </p>
      ) : (
        <ul data-testid="candidate-list" className="flex flex-col gap-2">
          {candidates.map((candidate, index) => (
            <li
              key={candidate.id}
              data-testid="candidate-row"
              data-chosen={candidate.chosen ? "true" : "false"}
              data-folded={
                folds && index >= PHONE_ROWS && !candidate.chosen ? "true" : undefined
              }
              className={[
                "flex flex-col gap-1 rounded-input border px-2 py-2",
                candidate.chosen ? "border-ready/60 bg-ready/[0.07]" : "border-border",
                folds && index >= PHONE_ROWS && !candidate.chosen ? "max-md:hidden" : "",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 max-md:flex-wrap max-md:justify-end">
                <label className="sr-only" htmlFor={`${addId}-text-${candidate.id}`}>
                  Candidate {index + 1}
                </label>
                {/*
                  A candidate is read in full before it is chosen, so it wraps
                  rather than scrolls inside its box (M10) — the hooks' rule
                  from M9. One line of a text input beside Choose and Remove
                  was 166px at 390, "Nine hours of sleep, on", the half of the
                  title that does not decide anything. A one-row textarea that
                  grows with its text (`field-sizing: content`); Enter still
                  commits rather than breaking the line, and a pasted line
                  break becomes a space, because a title is one line. Below
                  `md` it takes the row and the buttons wrap under it.
                */}
                <textarea
                  id={`${addId}-text-${candidate.id}`}
                  rows={1}
                  value={candidate.text}
                  maxLength={MAX_TITLE_LENGTH}
                  data-testid="candidate-text"
                  onChange={(event) =>
                    onEditText(
                      candidate.id,
                      event.target.value.replace(/[\r\n]+/g, " "),
                    )
                  }
                  onBlur={onCommit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="min-w-0 flex-1 resize-none rounded-input border border-transparent bg-transparent px-1 py-1 font-display text-base outline-none field-sizing-content hover:border-border focus-visible:ring-2 focus-visible:ring-accent max-md:basis-full thumb:min-h-11"
                />

                <button
                  type="button"
                  aria-pressed={candidate.chosen}
                  /*
                    Fifteen buttons all called "Choose" is what a screen reader's
                    button list showed before this: nothing tied any of them to
                    its candidate. The Remove buttons in the same row already got
                    this right.
                  */
                  aria-label={
                    candidate.chosen
                      ? `Un-choose candidate ${index + 1}`
                      : `Choose candidate ${index + 1}`
                  }
                  data-testid="candidate-choose"
                  title={
                    candidate.chosen
                      ? "This is the working title. Click to un-choose it."
                      : "Copy this into the working title."
                  }
                  onClick={() => onToggleChosen(candidate.id)}
                  className={[
                    "shrink-0 rounded-button border px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11",
                    candidate.chosen
                      ? "border-ready/60 bg-ready/10"
                      : "border-border hover:bg-surface",
                  ].join(" ")}
                >
                  {candidate.chosen ? "Chosen" : "Choose"}
                </button>

                <button
                  type="button"
                  data-testid="candidate-remove"
                  aria-label={`Remove candidate ${index + 1}`}
                  onClick={(event) => {
                    const neighbour =
                      candidates[index + 1] ?? candidates[index - 1] ?? null;
                    focusAfterRemove(
                      neighbour ? `${addId}-text-${neighbour.id}` : null,
                      event.currentTarget,
                    );
                    onRemove(candidate.id);
                  }}
                  className="shrink-0 rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
                >
                  Remove
                </button>
              </div>

              <label className="sr-only" htmlFor={`${addId}-note-${candidate.id}`}>
                Note on candidate {index + 1}
              </label>
              {/*
                A one-row textarea that grows, like the candidate above it
                (M10 review): after "Add all" every row carries a rationale of
                60–90 characters, and a one-line input showed its first half.
                Enter commits and a pasted line break becomes a space, because
                a note is one line.
              */}
              <textarea
                id={`${addId}-note-${candidate.id}`}
                rows={1}
                value={candidate.note ?? ""}
                placeholder="Why this one (optional)"
                maxLength={MAX_CANDIDATE_NOTE_LENGTH}
                data-testid="candidate-note"
                onChange={(event) =>
                  onEditNote(candidate.id, event.target.value.replace(/[\r\n]+/g, " "))
                }
                onBlur={onCommit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                // 16px, like every other field on the page: iOS Safari zooms
                // the whole page when a field under 16px takes focus, and this
                // is the one you reach for on a phone to say why this title.
                className="w-full resize-none rounded-input border border-transparent bg-transparent px-1 py-1 text-base text-muted outline-none field-sizing-content hover:border-border focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
              />

              {issue && issue.id === candidate.id ? (
                <p
                  role="alert"
                  data-testid="candidate-issue"
                  className="text-xs text-attention"
                >
                  {issue.message} Nothing else on this block is held up by it —
                  fix this row or remove it and it saves.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {folds ? (
        <button
          type="button"
          data-testid="candidate-show-all"
          onClick={() => setExpanded(true)}
          className="self-start rounded-button border border-border px-3 py-2 text-sm outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 md:hidden"
        >
          Show all {count} candidates
        </button>
      ) : null}
    </section>
  );
}

/** How many candidates a phone shows before "Show all". */
const PHONE_ROWS = 5;
