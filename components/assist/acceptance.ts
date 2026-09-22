import type { AssistMeta } from "@/lib/assist/types";
import { MAX_CANDIDATES, MAX_HOOKS } from "@/lib/packaging";

import type { AcceptOutcome } from "./packaging-assist";

/**
 * What accepting a suggestion did, and what a full list says before you pick.
 *
 * Two rules, both from the milestone brief, both pure so they can be tested
 * without a browser:
 *
 * 1. **A list at its ceiling says so before the person picks, not after.**
 *    `capacityLine` is rendered at the top of the panel, above the
 *    suggestions, so the sentence arrives before the button does.
 * 2. **Nothing is ever dropped silently.** "Add all" over a nearly-full list
 *    adds what fits and *says* what did not, and a suggestion that repeats a
 *    candidate already in the list says that rather than quietly adding a
 *    twin.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The line above the suggestions: what the lists can still take. */
export function capacityLine(
  candidateRoom: number,
  hookRoom: number,
): string | null {
  if (candidateRoom <= 0 && hookRoom <= 0) {
    return `Both lists are full — ${MAX_CANDIDATES} candidates and ${MAX_HOOKS} hooks. Remove something before accepting anything here.`;
  }
  if (candidateRoom <= 0) {
    return `Your candidate list is full at ${MAX_CANDIDATES}. Remove some before adding more; "Use as hook" still works.`;
  }
  if (hookRoom <= 0) {
    return `You already have ${MAX_HOOKS} hooks, which is the limit. Remove one before taking a hook from here; candidates are unaffected.`;
  }
  if (candidateRoom < 5) {
    return `Room for ${candidateRoom} more ${plural(candidateRoom, "candidate", "candidates")} before the list is full.`;
  }
  return null;
}

/** What happened when `asked` suggestions were accepted. Always a full sentence. */
export function describeAcceptance(outcome: AcceptOutcome, asked: number): string {
  const { added, duplicates, noRoom } = outcome;

  if (added === 0) {
    if (duplicates > 0 && noRoom === 0) {
      return asked === 1
        ? "That one is already in your candidate list."
        : `Nothing added — all ${duplicates} of those are already in your list.`;
    }
    if (noRoom > 0 && duplicates === 0) {
      return `Nothing added — the candidate list is full at ${MAX_CANDIDATES}.`;
    }
    return `Nothing added — ${duplicates} ${plural(duplicates, "was", "were")} already in your list and there was no room for ${noRoom}.`;
  }

  const parts = [
    `Added ${added} ${plural(added, "candidate", "candidates")} to your list.`,
  ];
  if (duplicates > 0) {
    parts.push(
      `${duplicates} ${plural(duplicates, "was", "were")} already there.`,
    );
  }
  if (noRoom > 0) {
    parts.push(
      `${noRoom} did not fit — the list stops at ${MAX_CANDIDATES}.`,
    );
  }
  return parts.join(" ");
}

/**
 * What the module had to do to the answer to make it usable, in a sentence.
 *
 * PLAN.md's M8 review item is that *a 21-title answer is clamped, not
 * discarded* — and a clamp nobody is told about is indistinguishable from a
 * model that answered short. `lib/assist` counts what it dropped; this says so.
 * `null` when the answer arrived exactly as asked for, which is the normal
 * case and deserves no line at all.
 */
export function describeMeta(meta: AssistMeta | null): string | null {
  if (!meta) return null;

  const dropped: string[] = [];
  if (meta.droppedOverflow > 0) {
    dropped.push(
      `${meta.droppedOverflow} past the ${meta.requested} asked for`,
    );
  }
  if (meta.droppedDuplicates > 0) {
    dropped.push(
      `${meta.droppedDuplicates} that repeated something already on this video`,
    );
  }
  if (meta.droppedUnusable > 0) {
    dropped.push(`${meta.droppedUnusable} that could not be stored`);
  }

  const parts: string[] = [];
  if (dropped.length > 0) {
    parts.push(`The answer overshot: dropped ${dropped.join(", ")}.`);
  }
  if (meta.recommendationAdjusted) {
    parts.push("Its pick pointed at something that was dropped, so the first is marked instead.");
  }
  if (meta.servedByFallback) {
    parts.push("A fallback model answered this one.");
  }

  return parts.length === 0 ? null : parts.join(" ");
}
