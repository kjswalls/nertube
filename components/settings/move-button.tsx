"use client";

import { createRef, useEffect, useRef, type RefObject } from "react";

import type { MoveDirection, MoveVerdict } from "@/lib/stage-settings";

/**
 * The settings area's one reorder control: an arrow that is either offered or
 * says why it is not.
 *
 * Three editors reorder rows — stages, template items, buckets — and three
 * slices each drew their own pair of arrows. This is the one pair. It is
 * arrows rather than a drag handle because there is no drag-and-drop library
 * in this app (PLAN.md's dependency ceiling), the longest list is a dozen
 * rows, and an arrow is the same gesture for a keyboard as for a mouse.
 *
 * ## Disabled, never hidden — and never silent
 *
 * An arrow that cannot be pressed stays where it was, so the row's shape does
 * not change and a keyboard user finds it where they left it. Its `verdict`
 * carries the reason ("Core stages keep their order: Filming stays before
 * Editing.", "Formats is already first."), which goes into the `title` for a
 * pointer and into the accessible name for everyone else — the *why* is on
 * the thing that cannot be pressed, not only in a tooltip nobody can summon.
 *
 * ## Focus after a move: `useMoveFocus`
 *
 * The arrow that was pressed may disable itself by succeeding (a row moved to
 * the top has no "up" left), and a disabled button drops focus on `<body>`.
 * M6's review filed exactly that against the filming-day panel. The hook
 * below keeps focus on the row: the same arrow if it is still offered,
 * otherwise the other one, otherwise the row's own name field — and it waits
 * for the write to settle before it looks, so the arrow it finds is the one
 * that is offered afterwards, not the one disabled by the wait.
 */

/** The reason a row at either end of its list cannot go further. */
export function edgeVerdict(
  name: string,
  index: number,
  total: number,
  direction: MoveDirection,
): MoveVerdict {
  if (direction === "up" && index === 0) return { ok: false, reason: `${name} is already first.` };
  if (direction === "down" && index === total - 1) {
    return { ok: false, reason: `${name} is already last.` };
  }
  return { ok: true };
}

/** Said while a write is on the wire and the order cannot be trusted yet. */
export const IN_FLIGHT: MoveVerdict = { ok: false, reason: "A move is in flight." };

export function MoveButton({
  direction,
  subject,
  verdict,
  onClick,
  buttonRef,
  testIdPrefix,
}: {
  direction: MoveDirection;
  /** What is being moved, for the accessible name: "Move Filming up". */
  subject: string;
  verdict: MoveVerdict;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** `stage` → `stage-move-up`; the row's own test id, not this component's. */
  testIdPrefix: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid={`${testIdPrefix}-move-${direction}`}
      data-offered={verdict.ok ? "true" : "false"}
      disabled={!verdict.ok}
      onClick={onClick}
      title={verdict.ok ? `Move ${subject} ${direction}` : verdict.reason}
      aria-label={
        verdict.ok
          ? `Move ${subject} ${direction}`
          : `Move ${subject} ${direction} — not available. ${verdict.reason}`
      }
      className="flex size-6 items-center justify-center rounded-button border border-border font-mono text-[11px] leading-none outline-none enabled:hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30 thumb:size-11 thumb:text-[13px]"
    >
      <span aria-hidden="true">{direction === "up" ? "▲" : "▼"}</span>
    </button>
  );
}

export interface MoveFocus {
  /** A stable ref for one row's arrow, for `MoveButton`'s `buttonRef`. */
  readonly buttonRef: (rowId: string, direction: MoveDirection) => RefObject<HTMLButtonElement | null>;
  /**
   * Ask for focus to follow this row once the list has settled. Call it
   * just before the move is asked for; it is consumed once, and not while
   * `inFlight` is true.
   */
  readonly requestFocus: (rowId: string, direction: MoveDirection) => void;
  /**
   * Ask for focus to land on whatever `selector` finds once the list has
   * settled — the next row's name field after a removal, the add form's box
   * when there is no next row. Consumed once, after the next change to
   * `deps`.
   */
  readonly requestField: (selector: string) => void;
}

/**
 * Keep focus on the row that was moved — or, after a removal, on the row
 * that took its place.
 *
 * `deps` are whatever changes when the list re-renders after a write — the
 * list itself and the in-flight marker — and `nameField` is a selector for
 * the row's own text input, the last resort when neither arrow is offered any
 * more.
 *
 * `inFlight` is the reason the request is *kept* rather than consumed on the
 * first render after it was made. Every arrow is disabled while a write is on
 * the wire, so an effect that ran then would find no arrow to land on, fall
 * through to the name field and throw the request away — which is exactly
 * what the template editor did (M7's review: focus on the text box, not the
 * arrow, after every move there). Requesting before the write and consuming
 * after it also covers the write that fails: the list is unchanged, the
 * arrows come back, and focus goes back to the one that was pressed.
 *
 * A ref rather than state for the request: it is written just before the
 * list changes and read in the effect that runs after the change commits,
 * so there is nothing to render from and no second render to cause.
 */
export function useMoveFocus({
  deps,
  inFlight,
  nameField,
}: {
  deps: readonly unknown[];
  inFlight: boolean;
  nameField: (rowId: string) => string;
}): MoveFocus {
  const buttons = useRef(new Map<string, RefObject<HTMLButtonElement | null>>());
  const request = useRef<
    | { kind: "row"; rowId: string; direction: MoveDirection }
    | { kind: "field"; selector: string }
    | null
  >(null);
  const nameFieldRef = useRef(nameField);
  useEffect(() => {
    nameFieldRef.current = nameField;
  });

  useEffect(() => {
    if (inFlight) return;
    const wanted = request.current;
    if (!wanted) return;
    request.current = null;

    if (wanted.kind === "field") {
      document.querySelector<HTMLElement>(wanted.selector)?.focus();
      return;
    }

    const { rowId, direction } = wanted;
    const other = direction === "up" ? "down" : "up";
    const candidates = [
      buttons.current.get(`${rowId}:${direction}`)?.current,
      buttons.current.get(`${rowId}:${other}`)?.current,
    ];
    const target = candidates.find((button) => button && !button.disabled) ?? null;
    if (target) {
      target.focus();
    } else {
      document.querySelector<HTMLElement>(nameFieldRef.current(rowId))?.focus();
    }
    // The caller's deps are the trigger; the effect reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight, ...deps]);

  return {
    buttonRef(rowId, direction) {
      const key = `${rowId}:${direction}`;
      let ref = buttons.current.get(key);
      if (!ref) {
        ref = createRef<HTMLButtonElement>();
        buttons.current.set(key, ref);
      }
      return ref;
    },
    requestFocus(rowId, direction) {
      request.current = { kind: "row", rowId, direction };
    },
    requestField(selector) {
      request.current = { kind: "field", selector };
    },
  };
}
