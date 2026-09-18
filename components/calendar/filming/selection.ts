import { MAX_FILMING_DAY_VIDEOS, type FilmingCandidate } from "./types";

/**
 * Which candidates the schedule dialog opens with ticked.
 *
 * Pure, and in its own module rather than inside the dialog, for the reason
 * `summary.ts` is: this is the rule an M6 reviewer broke the product with, and
 * a rule with a data-loss failure mode should be assertable without a browser.
 *
 * ## Rule 1 — a video already on a day is left unticked
 *
 * `link()` in `app/actions/filming-days.ts` sets `filming_day_id`
 * unconditionally, so a ticked video that is already on a shoot is *moved* off
 * it. The dialog used to tick every candidate, and the board's badge counts
 * videos that are already booked — so "book the Saturday, then press the badge
 * again" emptied the Saturday. The default press must be the harmless one;
 * moving a video is then a deliberate tick, the row says which day it is coming
 * off, and the action reports the move in its `warning`.
 *
 * The booked ones stay *in the list*: the badge counts the whole pile (BRIEF.md
 * principle 4's signal is about the pile) and a dialog that showed a different
 * set would be the badge and the dialog disagreeing, which is the thing
 * `lib/filming-data.ts` exists to prevent.
 *
 * ## Rule 2 — never more than the server will take
 *
 * `VideoIdsSchema` refuses more than `MAX_FILMING_DAY_VIDEOS`. A form that
 * opens in a state the server refuses is a dead end, and the state it happens
 * in is precisely the one the badge exists for: a big pile in Filming. A
 * reviewer put 57 videos in Filming, pressed the badge, pressed submit and got
 * a refusal that named no limit in front of a dialog with no way to get under
 * one.
 *
 * The first N of the list — which `readFilmingVideos()` orders by title, so it
 * is the same N between renders rather than an arbitrary subset.
 */
export function defaultSelection(
  candidates: readonly FilmingCandidate[],
): ReadonlySet<string> {
  return new Set(
    candidates
      .filter((candidate) => candidate.filmingDayId === null)
      .slice(0, MAX_FILMING_DAY_VIDEOS)
      .map((candidate) => candidate.id),
  );
}
