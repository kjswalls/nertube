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

import { useDismiss, useShortcuts } from "@/lib/shortcuts";

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
 * - Escape closes, from anywhere inside — including from a text field — and
 *   closes only the newest dialog when two are open (`useDismiss` in
 *   `lib/shortcuts.ts`, where the one Escape order is written down);
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
  onClosed,
  testId,
  placement = "center",
  width = "default",
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
  /**
   * Run once this dialog has gone, after the focus return above.
   *
   * For the caller whose opener does not survive the dialog. The swap dialog's
   * "Ship this one" becomes a disabled "Shipped" the moment the swap lands, and
   * `focus()` on a disabled button is a no-op — so focus would land on `<body>`
   * exactly when something *did* happen. The caller gets the last word about
   * where focus goes; everything else about the return stays here.
   */
  onClosed?: () => void;
  /** A handle for the specs, on the dialog itself rather than on its content. */
  testId?: string;
  /**
   * Where the box sits. `"center"` is every dialog in the application; `"start"`
   * is a full-height sheet against the leading edge, which is what the app
   * shell's navigation becomes on a phone (`components/app-sidebar-menu.tsx`).
   *
   * One prop and not a second component, because everything that makes this a
   * modal — the focus trap, the return, Escape from inside a field, the
   * `exclusive` scope that silences the page's keys, the backdrop — is exactly
   * as true of a navigation drawer as of the capture box. Only the geometry
   * differs, so only the geometry is a variant.
   */
  placement?: "center" | "start";
  /**
   * How wide a centred box may grow. `"default"` (32rem) is every form; the
   * `?` sheet is `"wide"` (48rem) because it is a reference card set in two
   * columns, and at one column it ran past the bottom of a laptop screen.
   */
  width?: "default" | "wide";
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  /*
    An empty exclusive registration: it binds no key of its own, and while it
    is mounted no non-exclusive binding fires.

    Escape is the registry's too: every open dialog is an *overlay*, and the
    newest overlay takes Escape from anywhere — including from inside the
    title field, where ordinary bindings, correctly, do not listen. That is
    what makes two stacked layers close one at a time, newest first (the
    phone's menu under the capture box; the `?` sheet over a board with a card
    selected). The order is written down once, in `lib/shortcuts.ts`. Tab
    stays a React handler below: the trap is this element's business alone.
  */
  useShortcuts(EMPTY, { exclusive: true });
  useDismiss(onClose);
  // What to give focus back to, fixed at mount.
  const opener = useRef<Element | null>(null);
  // Read through a ref: the effect below is mount-only, so a callback captured
  // in its closure would be the one this dialog opened with, for ever. Kept up
  // to date in its own effect rather than in render — a ref written during
  // render is a value React has not committed yet.
  const closedRef = useRef(onClosed);
  useEffect(() => {
    closedRef.current = onClosed;
  });

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
      closedRef.current?.();
    };
    // Mount only: the opener is fixed for the life of one dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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

  const sheet = placement === "start";

  return createPortal(
    <div
      // Not a focus trap by itself — the keydown handler below is — but it does
      // catch a click on the backdrop.
      className={
        sheet
          ? // `overscroll-contain` so a swipe on the backdrop does not scroll
            // the page underneath the sheet.
            "fixed inset-0 z-50 flex justify-start overscroll-contain bg-black/40"
          : "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]"
      }
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        data-testid={testId}
        data-placement={placement}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className={
          sheet
            ? // Never the whole width: the strip of backdrop that is left is
              // what a thumb taps to dismiss it, and what says the page is
              // still there underneath.
              "flex h-dvh w-[min(20rem,calc(100vw-3rem))] flex-col overflow-y-auto overscroll-contain border-r border-border bg-sidebar px-3 py-4 shadow-xl"
            : [
                "w-full rounded-card border border-border bg-surface p-4 shadow-xl sm:p-5",
                width === "wide" ? "max-w-3xl" : "max-w-lg",
              ].join(" ")
        }
      >
        <div
          className={[
            "mb-3 flex items-baseline justify-between gap-3",
            sheet ? "px-1" : "",
          ].join(" ")}
        >
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-button px-2 py-1 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3"
          >
            {/*
              A touchscreen has no Escape key, so there the button says what it
              does rather than which key does it. `display: none` takes the
              other word out of the accessibility tree too, so the name is
              exactly one of the two.
            */}
            <span className="pointer-coarse:hidden">Escape to close</span>
            <span className="hidden pointer-coarse:inline">Close</span>
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
