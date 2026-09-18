"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useShortcuts } from "@/lib/shortcuts";

/**
 * The application's one modal.
 *
 * ## Why there is exactly one
 *
 * There were two. M1 built this for the `c` capture box; M4's thumbnails slice
 * built a second one, a native `<dialog>` with `showModal()`, for the swap
 * reason. Two modals is not a style disagreement — the second one had a bug the
 * first one had already fixed. `useShortcuts` (`lib/shortcuts.ts`) has a single
 * `keydown` listener on `document`, and the *only* thing that silences the page
 * underneath a dialog is an `exclusive` registration. A native `<dialog>` is
 * inert to clicks and focus but its key events still bubble to `document`, so
 * pressing `c` with focus on the swap dialog's Cancel button opened the capture
 * box on top of it. The fix is not to teach the second modal about the
 * registry; it is to have one modal that already knows.
 *
 * ## Why not `<dialog>` for the one either
 *
 * `showModal()` has to be called from an effect, which means one frame where
 * the content is in the DOM and not yet modal, and its top-layer backdrop
 * cannot be styled with the rest of the app. The behaviour that actually
 * matters is small enough to do properly by hand, and it is the behaviour
 * PLAN.md's keyboard-first workflow depends on:
 *
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` — a screen reader
 *   announces the box by name when it opens;
 * - focus moves **into** the dialog on open (to the first field, so `c` really
 *   is "type the idea");
 * - focus is **trapped** while it is open: Tab from the last control goes to
 *   the first, Shift+Tab from the first goes to the last;
 * - focus **returns** to whatever had it when the dialog closes, so `c`,
 *   Escape leaves the board exactly as it was;
 * - Escape closes, from anywhere inside — including from a text field, where
 *   the global shortcut registry deliberately does not listen;
 * - **the page underneath goes quiet**: the dialog registers an `exclusive`
 *   scope with `useShortcuts`, so `j`, `[`, `]`, `Enter` and `1..9` are not
 *   board or header keys while it is open. Without it, a key pressed while
 *   focus sat on the dialog's close button would move a card behind the
 *   dialog;
 * - a click on the backdrop closes it, and a click inside never does.
 *
 * The rest of the page is not `inert`: that is one attribute, but it needs the
 * host to own every sibling of the dialog, and this one is mounted inside a
 * header. `aria-modal` plus the trap is the standard fallback.
 */
export function Modal({
  title,
  returnFocusRef,
  onClose,
  testId,
  children,
}: {
  title: string;
  /**
   * What had focus when the dialog was asked for. The opener has to record it —
   * by the time this component's effects run, the form's `autoFocus` has
   * already moved focus and `document.activeElement` is the title input — and
   * it arrives as a ref so that reading it stays out of render.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A handle for the specs, on the dialog itself rather than on its content. */
  testId?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  /*
    An empty exclusive registration: it binds no key of its own, and while it
    is mounted no non-exclusive binding fires. Escape and Tab are handled below
    as React events, because both have to work from inside a text field — which
    is exactly where the registry, correctly, does not listen.
  */
  useShortcuts(EMPTY, { exclusive: true });
  // What to give focus back to, fixed at mount.
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = returnFocusRef?.current ?? document.activeElement;

    const dialog = dialogRef.current;
    // The form's own `autoFocus` normally wins the race; this is the fallback
    // for a dialog whose first control does not ask for focus.
    if (dialog && !dialog.contains(document.activeElement)) {
      focusable(dialog)[0]?.focus();
    }

    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement && document.contains(previous)) {
        previous.focus();
      }
    };
    // Mount only: the opener is fixed for the life of one dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape has to work from inside the title input, which is why this is a
      // React handler on the dialog rather than a `useShortcuts` binding: that
      // hook ignores everything typed into a field, correctly.
      onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const stops = focusable(dialog);
    if (stops.length === 0) return;

    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      // Not a focus trap by itself — the keydown handler below is — but it does
      // catch a click on the backdrop.
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-card border border-border bg-surface p-4 shadow-xl sm:p-5"
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-button px-2 py-1 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
          >
            Escape to close
          </button>
        </div>

        {children}
      </div>
    </div>,
    document.body,
  );
}

/** No keys of its own: the registration exists to silence the page behind it. */
const EMPTY: never[] = [];

/**
 * The dialog's tab stops, in document order.
 *
 * `offsetParent === null` catches the ones that are display:none — including
 * everything inside the closed disclosure, which must not become a tab stop
 * that Tab appears to fall into. (It is also why the disclosure unmounts its
 * fields rather than hiding them.)
 */
function focusable(root: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(", ");

  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (element) =>
      // A radio group is one tab stop; the browser tabs to the checked radio
      // (or the first, when none is). Ours is always one of `channelId`.
      !(element instanceof HTMLInputElement &&
        element.type === "radio" &&
        !element.checked) &&
      element.offsetParent !== null,
  );
}
