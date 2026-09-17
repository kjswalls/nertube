"use client";

import { useId, useRef, useState } from "react";

import { MAX_CANDIDATES, MAX_CANDIDATE_NOTE_LENGTH, MAX_TITLE_LENGTH, type TitleCandidate } from "@/lib/packaging";

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
  onAdd,
  onEditText,
  onEditNote,
  onCommit,
  onToggleChosen,
  onRemove,
}: {
  candidates: readonly TitleCandidate[];
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

  const count = candidates.length;
  const atLimit = count >= MAX_CANDIDATES;

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
          {count < 10 ? " — the brief asks for 10–20, not 3" : " — in the 10–20 band"}
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
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        />
        <button
          type="submit"
          data-testid="candidate-add"
          className="rounded-md border border-border px-3 py-2 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          Add
        </button>
      </form>

      <p
        id={noticeId}
        role="status"
        data-testid="candidate-notice"
        className="min-h-4 text-xs text-amber-700 dark:text-amber-400"
      >
        {notice ?? ""}
      </p>

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
              className={[
                "flex flex-col gap-1 rounded-md border px-2 py-2",
                candidate.chosen ? "border-emerald-600/60 bg-emerald-600/5" : "border-border",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`${addId}-text-${candidate.id}`}>
                  Candidate {index + 1}
                </label>
                <input
                  id={`${addId}-text-${candidate.id}`}
                  type="text"
                  value={candidate.text}
                  maxLength={MAX_TITLE_LENGTH}
                  data-testid="candidate-text"
                  onChange={(event) => onEditText(candidate.id, event.target.value)}
                  onBlur={onCommit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1 text-base outline-none hover:border-border focus-visible:ring-2 focus-visible:ring-foreground/40"
                />

                <button
                  type="button"
                  aria-pressed={candidate.chosen}
                  data-testid="candidate-choose"
                  title={
                    candidate.chosen
                      ? "This is the working title. Click to un-choose it."
                      : "Copy this into the working title."
                  }
                  onClick={() => onToggleChosen(candidate.id)}
                  className={[
                    "shrink-0 rounded border px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
                    candidate.chosen
                      ? "border-emerald-600/60 bg-emerald-600/10"
                      : "border-border hover:bg-surface",
                  ].join(" ")}
                >
                  {candidate.chosen ? "Chosen" : "Choose"}
                </button>

                <button
                  type="button"
                  data-testid="candidate-remove"
                  aria-label={`Remove candidate ${index + 1}`}
                  onClick={() => onRemove(candidate.id)}
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40"
                >
                  Remove
                </button>
              </div>

              <label className="sr-only" htmlFor={`${addId}-note-${candidate.id}`}>
                Note on candidate {index + 1}
              </label>
              <input
                id={`${addId}-note-${candidate.id}`}
                type="text"
                value={candidate.note ?? ""}
                placeholder="Why this one (optional)"
                maxLength={MAX_CANDIDATE_NOTE_LENGTH}
                data-testid="candidate-note"
                onChange={(event) => onEditNote(candidate.id, event.target.value)}
                onBlur={onCommit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-xs text-muted outline-none hover:border-border focus-visible:ring-2 focus-visible:ring-foreground/40"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
