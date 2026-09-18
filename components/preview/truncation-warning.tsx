"use client";

import { usePackagingDraft } from "./live-packaging";
import { useClamps } from "./measure-title";
import { FEED_TITLE_BOX } from "./metrics";

/**
 * The thing the tool knows that the user cannot see: which of these titles the
 * home feed cuts, and by how much.
 *
 * ## Why the feed and not search
 *
 * Three surfaces clamp at three different points, and a warning that fired
 * three times would be noise. The feed is the tightest — 16px in a 288px column
 * against 18px in a 600px one — so a title that survives it survives the others.
 * The preview below shows all three; this names the one that bites first.
 *
 * ## Why the cut tail is drawn rather than described
 *
 * "14 characters cut" is a number. What the user needs is *which* 14, because
 * the decision is different depending on whether the cut takes a qualifier or
 * the entire payoff. So the visible part is drawn as it will be seen, and the
 * rest is struck through after it.
 *
 * ## Why it is not a live region
 *
 * It changes on every keystroke past the limit. Announcing each one would talk
 * over somebody trying to type a title. It is a plain region, inside the
 * packaging section, in reading order right after the candidate list it is
 * about — a screen reader passes through it on the way to the next field, and
 * the same fact is on the gate-agnostic side of the page anyway.
 */

export interface TitleTruncationWarningProps {
  /** `videos.title` as the server rendered it — used until the editor publishes. */
  savedTitle: string;
  /** The saved candidate list, likewise. */
  savedCandidates: readonly { readonly id: string; readonly text: string }[];
}

interface Subject {
  readonly key: string;
  /** "Working title" or "Candidate 3" — what this row is. */
  readonly label: string;
  readonly text: string;
}

export function TitleTruncationWarning({
  savedTitle,
  savedCandidates,
}: TitleTruncationWarningProps) {
  const draft = usePackagingDraft();

  const title = (draft?.title ?? savedTitle).trim();
  const candidates = draft?.candidates ?? savedCandidates;

  const subjects: Subject[] = [];
  if (title !== "") {
    subjects.push({ key: "title", label: "Working title", text: title });
  }
  candidates.forEach((candidate, index) => {
    const text = candidate.text.trim();
    // The working title is usually one of the candidates, word for word:
    // choosing one copies it into the column. Listing it twice would double
    // every count in the summary.
    if (text === "" || text === title) return;
    subjects.push({
      key: `candidate-${candidate.id}`,
      label: `Candidate ${index + 1}`,
      text,
    });
  });

  const clamps = useClamps(
    subjects.map((subject) => subject.text),
    FEED_TITLE_BOX,
  );

  const measured = clamps.filter((clamp) => clamp !== null).length;
  const rows = subjects
    .map((subject, index) => ({ subject, clamp: clamps[index] ?? null }))
    .filter((row) => row.clamp !== null && row.clamp.truncated);

  // Nothing measured yet: the server render, and the first client render so
  // that hydration matches it. The state is on the element so a test can wait
  // for the measurement rather than for a timeout.
  const state =
    subjects.length === 0 || measured === 0
      ? "unmeasured"
      : rows.length === 0
        ? "clear"
        : "cut";

  return (
    <div
      data-testid="truncation-warning"
      data-state={state}
      data-cut-count={state === "unmeasured" ? undefined : rows.length}
      className="flex flex-col gap-2 text-xs"
    >
      {state === "clear" ? (
        <p className="text-muted">
          {subjects.length === 1
            ? "The title fits the feed's two lines."
            : `All ${subjects.length} titles fit the feed's two lines.`}
        </p>
      ) : null}

      {state === "cut" ? (
        <>
          <p className="font-medium text-attention" data-testid="truncation-summary">
            The home feed would cut {rows.length} of {subjects.length}{" "}
            {subjects.length === 1 ? "title" : "titles"}.
          </p>
          <ul className="flex flex-col gap-1.5">
            {rows.map(({ subject, clamp }) => (
              <li
                key={subject.key}
                data-testid="truncation-row"
                data-cut={clamp?.cut}
                className="flex flex-col gap-0.5 border-l border-attention pl-2"
              >
                <span className="text-muted">
                  {subject.label} &mdash;{" "}
                  {/* Graphemes, so an emoji counts as one and a family emoji
                      counts as one: see `Clamp.cut` in ./measure-title.ts. */}
                  <span className="font-mono">{clamp?.cut}</span> characters cut
                </span>
                <span className="font-display text-sm leading-snug">
                  {clamp?.visible}
                  <span className="text-muted">&#8230;</span>
                  <span className="text-over-limit line-through">
                    {subject.text.slice((clamp?.visible ?? "").length)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
