"use client";

import { describeGate, type GateStatus } from "@/lib/packaging";

/**
 * The live gate indicator.
 *
 * BRIEF.md principle 1 asks the app to make skipping packaging *structurally
 * awkward*. This line is the visible half of that: it says, at all times and in
 * the same words the board's refusal uses, whether `move_video` would let this
 * video out of Packaging right now.
 *
 * ## It renders a decision, it does not make one
 *
 * Every word here comes from `packagingGate()` and `describeGate()` in
 * `lib/packaging.ts` — the same predicate, transcribed from the plpgsql, that
 * the block feeds with the values the next save will store. This component owns
 * no rule of its own, so there is no second definition of "ready" to drift from
 * the first. A field that was filled and then cleared goes back to "needs…" for
 * exactly the same reason the gate would refuse it: the predicate is re-run on
 * every render against the current values.
 *
 * ## The "not saved yet" caveat
 *
 * The predicate judges what is *in the editor*; `move_video` judges what is *in
 * the row*. Those are the same thing except while a save is in flight or after
 * one has failed — and in that window a confident "Packaging: ready" would be a
 * lie the board is about to contradict. So the indicator says both: what the
 * fields now say, and that the row has not caught up.
 */
export function GateIndicator({
  status,
  unsaved,
  skipReason,
}: {
  status: GateStatus;
  /** The editor holds changes the row does not have yet. */
  unsaved: boolean;
  /** Shown when the gate passes only because packaging was skipped. */
  skipReason: string | null;
}) {
  const tone = status.ready
    ? status.skipped
      ? "border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-300"
      : "border-emerald-600/60 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300"
    : "border-border bg-surface text-foreground";

  /*
    The live region is the *decision*, and only the decision.

    The whole box used to be `role="status"`, caveat included — and the caveat
    flips on the first keystroke of every edit, so resuming typing re-announced
    the entire gate sentence whether or not the gate had changed its mind. The
    sentence is still announced when it changes, which is the point of a live
    indicator; the "not saved yet" fragment is a sibling of the live region
    rather than its content, so it is read in document order and not spoken on
    a keypress.
  */
  return (
    <div
      data-testid="gate-indicator"
      data-gate={status.ready ? (status.skipped ? "skipped" : "ready") : status.missing}
      className={["rounded-md border px-3 py-2 text-sm", tone].join(" ")}
    >
      <span role="status">
        <span className="font-medium">{describeGate(status)}</span>

        {status.skipped && skipReason ? (
          <span data-testid="gate-skip-reason"> — {skipReason}</span>
        ) : null}

        {status.ready && !status.skipped ? (
          <span className="text-muted"> — this video can move past Packaging.</span>
        ) : null}

        {status.skipped ? (
          <span className="text-muted">
            . The gate is bypassed for this video and the skip stays visible as a badge.
          </span>
        ) : null}
      </span>

      {unsaved ? (
        <span data-testid="gate-unsaved" className="text-muted">
          {" "}
          (not saved yet — the board still sees the last saved values)
        </span>
      ) : null}
    </div>
  );
}
