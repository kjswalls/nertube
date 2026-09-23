"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Modal } from "@/components/modal";
import { openShortcutSheet } from "@/components/shortcuts/keyboard-shortcuts";

/**
 * Where the sidebar goes on a phone: behind one button, in the application's
 * one modal.
 *
 * ## Why this exists
 *
 * M3's review measured it (finding 32): at 390×844 the 224px sidebar left
 * `main` 166px wide, and after two 32px gutters that was a 102px column — 72px
 * at 360. `/now` wrapped every row to two or three words a line. Narrowing the
 * gutter could not fix that; the sidebar had to stop taking the screen.
 *
 * Below the `md` breakpoint (768px) the shell draws the sidebar as a 56px bar —
 * this button, the wordmark and Capture — and the sections, the channels and the
 * account move behind the button. At and above it, this component renders
 * nothing visible and the sidebar is exactly what it was.
 *
 * ## Why it is `Modal` and not a drawer of its own
 *
 * Everything a navigation overlay must do is already done, once, in
 * `components/modal.tsx`: focus moves in and is trapped, Escape closes it from
 * anywhere inside, a tap on the backdrop closes it, focus goes back to this
 * button afterwards, and the `exclusive` shortcut scope keeps `j`/`x`/`1..9`
 * from acting on the page underneath while it is open. A second overlay would
 * have to get all six right again, and the M4 swap dialog is the record of
 * what happens when one does not. So this passes `placement="start"` and
 * owns nothing but the open/closed state.
 *
 * ## What it renders twice, and what it never does
 *
 * The *links* are rendered twice — `drawer` is a second server rendering of the
 * same list the desktop `<nav>` draws — because the two cannot be one element:
 * one is in the sidebar, the other is in a portal. That is safe because they
 * are pure markup. What must exist exactly once — `CaptureHost` (`c`) and
 * `KeyboardShortcuts` (`1`..`9`, `g`, `?`) — stays in the bar, mounted at every width,
 * and is never passed in here.
 */
/*
  A link chosen in the sheet, waiting for the page it leads to.

  Every page renders its own `AppShell`, so a navigation mounts a new bar and a
  new menu button, and the one `Modal` gave focus back to is gone a moment
  later — focus ended on <body> (M9 review). The chosen link records the time
  here; the menu button of the page that arrives takes focus if it mounts
  within a few seconds. A module-level record because it has to outlive the
  component that wrote it; a timestamp so that a stale one (a link to the page
  already open, which remounts nothing) cannot steal focus later.
*/
const chosenInSheet = { at: 0 };
const CHOSEN_WINDOW_MS = 10_000;

export function AppSidebarMenu({ drawer }: { drawer: ReactNode }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /*
    The sheet's "Keyboard shortcuts" button asks for the `?` sheet (M10). It
    is opened only once this sheet has closed: the one modal silences the
    page's bindings while it is up, and the shortcut sheet lists exactly
    those bindings, so reading them with the menu still open would list none
    of the page's keys. The effect below runs after `Modal`'s own cleanup has
    put focus back on the menu button, which is therefore where the shortcut
    sheet returns it.
  */
  const sheetAfterClose = useRef(false);
  useEffect(() => {
    if (open || !sheetAfterClose.current) return;
    sheetAfterClose.current = false;
    openShortcutSheet();
  }, [open]);

  useEffect(() => {
    const at = chosenInSheet.at;
    chosenInSheet.at = 0;
    if (at !== 0 && Date.now() - at < CHOSEN_WINDOW_MS) buttonRef.current?.focus();
  }, []);

  /*
    A window widened past the breakpoint while the sheet is open would leave a
    phone's overlay over a desktop's sidebar, with the same links in both. The
    query is the same `48rem` Tailwind's `md` is.
  */
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia("(min-width: 48rem)");
    const onChange = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="sidebar-menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        /*
          `md:hidden`: at desktop width the sidebar is on screen and this has
          nothing to open. 44px square, the size a thumb can hit without
          looking.
        */
        className="-ml-1 flex size-11 shrink-0 items-center justify-center rounded-button text-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent md:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
        </svg>
        <span className="sr-only">Menu</span>
      </button>

      {open ? (
        <Modal
          title="Menu"
          placement="start"
          testId="sidebar-drawer"
          returnFocusRef={buttonRef}
          onClose={() => setOpen(false)}
        >
          <div
            className="flex flex-1 flex-col gap-5"
            /*
              A link chosen in the sheet is a decision made: close it at once,
              rather than leave it open over a page that is loading. Focus goes
              back to the menu button — this one at once, and the new page's
              when it arrives (`chosenInSheet` above). Delegated here rather
              than threaded into every link, because the links are
              server-rendered and do not know they are in a sheet.
            */
            onClick={(event) => {
              const target = event.target as Element;
              if (target.closest("a[href]")) {
                chosenInSheet.at = Date.now();
                setOpen(false);
              } else if (target.closest("[data-opens-shortcut-sheet]")) {
                sheetAfterClose.current = true;
                setOpen(false);
              }
            }}
          >
            {drawer}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
