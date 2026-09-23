"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  MAX_SKIP_REASON_LENGTH,
  MIN_SKIP_REASON_LENGTH,
  SKIP_REASON_EMPTY,
  SKIP_REASON_TOO_SHORT,
} from "@/lib/packaging";

import { useTimeZone } from "@/components/time-zone";
import { formatInstant, type TimeZone } from "@/lib/calendar-dates";

import { focusAnchor } from "./hash-focus";

/**
 * The escape hatch, and the reason it is deliberately awkward.
 *
 * BRIEF.md principle 1: packaging is ~20% of the effort for ~80% of the result,
 * and the app should make it *structurally awkward* to skip. Not impossible —
 * a sponsor deadline, a reupload, a video whose packaging was decided in a
 * document three weeks ago are all real — but never the path of least
 * resistance. So skipping costs three deliberate acts:
 *
 * 1. open a disclosure that is closed by default and is not styled as a
 *    primary action,
 * 2. read what it will do, which is stated before the box and not after it,
 * 3. type a reason, which cannot be blank and cannot be a keystroke — refused
 *    here, refused again by `SkipReasonSchema` on the way to the column, and
 *    refused a third time by `packaging_skip_reason <> ''` in `0001_init.sql`.
 *
 * Compare the cost of just writing the thumbnail concept: one sentence in a box
 * that is already on screen. That asymmetry is the feature, and it only exists
 * if the reason is really a reason: a reviewer skipped this gate in four clicks
 * and one keystroke by typing `x`, which cleared the old floor of "not empty"
 * and left behind a column that explains nothing to whoever reads the badge a
 * month later. `MIN_SKIP_REASON_LENGTH` is that floor now, checked here before
 * the round trip and in the schema behind it.
 *
 * ## Why the button is not disabled when the box is empty
 *
 * A disabled button is a refusal with no explanation, and this is precisely the
 * moment somebody is in a hurry and will not go looking for one. Pressing it
 * with an empty box says what is missing, which is both kinder and — since the
 * reason is the entire point of the mechanism — more likely to produce one.
 *
 * It is not disabled while some *unrelated* save is in flight either. It used
 * to be, off the block's shared queue, so editing the title on a slow
 * connection and then pressing Skip did nothing and said nothing — the exact
 * failure mode the paragraph above rejects. The queue already serialises: the
 * skip is merged behind whatever is on the wire and sent after it.
 *
 * ## Un-skipping
 *
 * One click, no confirmation. Going back to doing the work properly should
 * never be the harder direction. What *is* not allowed is for undoing it to
 * make redoing it cheap: un-skipping used to leave the disclosure open with the
 * withdrawn reason still sitting in the box, so re-skipping cost one click and
 * no typing at all — the cheapest control on the screen, immediately after
 * somebody chose to do the work properly. Crossing either way now resets the
 * disclosure to closed and empties the box, so the three acts are three acts
 * every time.
 *
 * ## Arriving here from the board
 *
 * The gate refusal's "Skip gate…" link points at `#packaging-skip`. Landing on
 * a closed disclosure would be a link that does nothing visible, so the
 * disclosure opens itself and the caret goes into the reason box — the one
 * thing that has to be typed. The three deliberate acts are still three: the
 * link *is* the first one, it is only ever reached from a refusal, and the
 * reason is still required and still typed by hand.
 *
 * ## The disclosure is a disclosure
 *
 * The button stays mounted when the form opens and carries `aria-expanded` and
 * `aria-controls`, and focus moves into the reason box. Before that it was a
 * button that vanished from under the person who pressed it, leaving focus on
 * `<body>` with nothing announced — a state change a screen reader had no way
 * of knowing about.
 */
export function SkipPackaging({
  anchorId,
  focusRequest,
  skippedAt,
  skipReason,
  onSkip,
  onUnskip,
}: {
  /** `SKIP_ANCHOR`. Always on whichever control is currently the way in. */
  anchorId: string;
  /**
   * Bumped when the page's fragment names this anchor; `0` means it does not.
   * A counter rather than a boolean so arriving at the same anchor twice in one
   * session is two requests, not one.
   */
  focusRequest: number;
  skippedAt: string | null;
  skipReason: string | null;
  onSkip: (reason: string) => void;
  onUnskip: () => void;
}) {
  const zone = useTimeZone();
  const noticeId = useId();
  const formId = useId();
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const openRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const unskipRef = useRef<HTMLButtonElement>(null);

  /**
   * Whether the form is showing.
   *
   * Two ways in, so it is *derived* rather than stored: the disclosure button,
   * and a "Skip gate…" link that named this anchor. Deriving it is what lets
   * the form already be in the document by the time the focus effect below
   * runs — an effect that opened it first would need a second pass to find the
   * box, and setting state inside an effect to trigger that pass is the
   * cascading-render the React lint rule is about.
   */
  const [openedHere, setOpenedHere] = useState(false);
  /** The link request the user closed again, so Cancel actually closes. */
  const [dismissed, setDismissed] = useState(0);
  const open = openedHere || (focusRequest !== 0 && focusRequest !== dismissed);

  /** The last request the caret has been moved for. */
  const handled = useRef(0);

  useEffect(() => {
    if (focusRequest === 0 || handled.current === focusRequest) return;
    handled.current = focusRequest;
    // Already skipped: the useful control is the one that undoes it. Otherwise
    // the reason box, which `open` has just put on the screen.
    focusAnchor(skippedAt !== null ? unskipRef.current : reasonRef.current);
  }, [focusRequest, skippedAt]);

  /*
    The skip landed, or was undone.

    Both directions unmount the control that was just pressed, so focus is on
    `<body>` and nothing has been announced. Both also have to leave the form in
    the state a first-time skip would find it in: closed, empty. The guard is
    that focus was actually dropped — if the user has moved on to another field
    while the save was on the wire, taking the caret back off them would be
    worse than saying nothing.
  */
  const wasSkipped = useRef(skippedAt);
  useEffect(() => {
    if (wasSkipped.current === skippedAt) return;
    const justSkipped = skippedAt !== null;
    wasSkipped.current = skippedAt;

    setOpenedHere(false);
    setDismissed(focusRequest);
    setReason("");
    setNotice(null);

    if (document.activeElement === null || document.activeElement === document.body) {
      focusAnchor(justSkipped ? unskipRef.current : openRef.current);
    }
  }, [focusRequest, skippedAt]);

  if (skippedAt !== null) {
    return (
      <section
        data-testid="packaging-skipped"
        className="flex scroll-mt-4 flex-col gap-2 rounded-input border border-attention/60 bg-attention/10 px-3 py-2 text-sm"
      >
        <p className="font-medium text-attention">
          Packaging skipped
        </p>
        <p data-testid="skip-reason" className="text-sm">
          {skipReason ?? "(no reason recorded)"}
        </p>
        <p className="text-xs text-muted">
          Skipped <time dateTime={skippedAt}>{formatSkippedAt(skippedAt, zone)}</time>
          . This shows as a badge on the card, and the gate lets this video
          through until it is undone.
        </p>
        <div>
          <button
            type="button"
            id={anchorId}
            ref={unskipRef}
            data-testid="packaging-unskip"
            onClick={onUnskip}
            className="rounded-button border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            Un-skip — put the gate back
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="flex scroll-mt-4 flex-col gap-2">
      <p className="text-xs">
        <button
          type="button"
          /*
            The anchor is whichever control is the way in *right now*: the
            collapsed link when the form is shut, the reason box once it is
            open. `#packaging-skip` therefore always names something focusable,
            and never names two things at once.
          */
          id={open ? undefined : anchorId}
          ref={openRef}
          data-testid="packaging-skip-open"
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => {
            if (open) {
              setOpenedHere(false);
              setDismissed(focusRequest);
              setNotice(null);
              return;
            }
            setOpenedHere(true);
            // The box is the only thing that has to be typed, so that is where
            // the caret goes. The form is rendered in the same pass as this
            // state change, so it is in the document by the time this runs.
            requestAnimationFrame(() => focusAnchor(reasonRef.current));
          }}
          // Padding, not just a line of text: at 12px this was a 240×16 target,
          // under WCAG 2.5.8's 24×24 floor, and it is the only thing in its
          // paragraph so the inline exception does not apply.
          className="inline-block min-h-6 py-1 text-muted underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
        >
          Skip the packaging gate for this video…
        </button>
      </p>

      {open ? (
        <section
          id={formId}
          data-testid="packaging-skip-form"
          className="flex flex-col gap-2 rounded-input border border-border bg-surface px-3 py-2"
        >
          <p className="text-xs text-muted">
            The video moves on with the fields unfinished. Your reason is
            recorded, and it shows as a badge on the card until you undo it.
          </p>

          <label htmlFor={anchorId} className="text-xs font-medium text-muted">
            Why are you skipping packaging?
          </label>
          <textarea
            id={anchorId}
            ref={reasonRef}
            value={reason}
            rows={2}
            maxLength={MAX_SKIP_REASON_LENGTH}
            placeholder="Sponsor deadline — the sponsor fixed the title and thumbnail"
            aria-describedby={noticeId}
            data-testid="skip-reason-input"
            onChange={(event) => {
              setReason(event.target.value);
              if (notice) setNotice(null);
            }}
            className="w-full resize-y rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />

          <p
            id={noticeId}
            role="status"
            data-testid="skip-notice"
            className="min-h-4 text-xs text-attention"
          >
            {notice ?? ""}
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="packaging-skip-confirm"
              onClick={() => {
                const typed = reason.trim();
                if (typed === "") {
                  setNotice(SKIP_REASON_EMPTY);
                  return;
                }
                if (typed.length < MIN_SKIP_REASON_LENGTH) {
                  // Refused here as well as in the schema, so the answer
                  // arrives without a round trip.
                  setNotice(SKIP_REASON_TOO_SHORT);
                  return;
                }
                setNotice(null);
                onSkip(typed);
              }}
              className="rounded-input border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
            >
              Skip packaging
            </button>
            <button
              type="button"
              data-testid="packaging-skip-cancel"
              onClick={() => {
                setOpenedHere(false);
                setDismissed(focusRequest);
                setReason("");
                setNotice(null);
                // The control that replaces this one, rather than `<body>`.
                focusAnchor(openRef.current);
              }}
              className="rounded-button px-3 py-1.5 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * When packaging was skipped, as a date in the user's zone (M10).
 *
 * This is a `"use client"` component that `/videos/[id]` renders on the
 * server, and `toLocaleDateString(undefined, …)` would read the machine's
 * locale and zone — Node's on the server, the viewer's in the browser. A
 * reviewer reproduced the consequence with a browser in `Pacific/Kiritimati`:
 * the server wrote "3 Mar 2026", Chromium wrote "Mar 4, 2026", and React threw
 * the subtree away on every load. So it goes through `formatInstant` with the
 * zone the server read (`useTimeZone()`), the same as every other instant the
 * product shows. An unparseable stamp is shown as it was stored rather than as
 * "Invalid Date": the `<time dateTime>` beside it is that string anyway.
 */
function formatSkippedAt(iso: string, zone: TimeZone): string {
  return formatInstant(iso, zone) ?? iso;
}
