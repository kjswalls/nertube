"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useDismiss } from "@/lib/shortcuts";

/**
 * The one transient-message mechanism.
 *
 * M1 arrived with two: the board's own refusal toast and the capture host's
 * confirmation line. They looked different, announced differently and timed out
 * differently, for messages that appear in the same corner of the same screen
 * seconds apart. This is the merged one, mounted once in the root layout, and
 * it is what every "it happened / it did not happen" message goes through.
 *
 * ## The two tones, and why they are not the same element
 *
 * - **`error`** renders `role="alert"`: the user just tried to do something and
 *   it did not happen, so it interrupts. A refused drop is the case that
 *   matters — PLAN.md: *a refused drop snaps back with a toast naming the
 *   missing field, a "Fix packaging" link and a "Skip gate…" link*. M1 sent one
 *   link to the detail page because a link to a fragment nothing renders is
 *   worse than no link; M2 built the fields, so the board now sends both, each
 *   carrying the anchor of a control the detail page focuses on arrival (see
 *   board.tsx and `components/packaging/hash-focus.ts`).
 * - **`info`** renders `role="status"`: a capture landed. Announced politely,
 *   after whatever the screen reader is already saying.
 *
 * Both time out, because a message that stays forever stops being read, and
 * both carry a dismiss button, because a message that vanishes on its own
 * schedule is sometimes gone too soon.
 *
 * The region itself is always in the DOM: a live region that is inserted at the
 * same moment as its text is not reliably announced, so the container is
 * rendered empty and only its contents change.
 *
 * ## Reaching a toast from the keyboard, and keeping it (M9 review)
 *
 * A refused `]` on the board used to put "Fix packaging" and "Skip gate…" at
 * the end of the tab order, behind every card, on a 12-second clock that never
 * stopped — so a keyboard user who did reach a link could lose it, and their
 * focus, to <body> while reading it (WCAG 2.2.1, 2.4.3). Now:
 *
 * - the clock **stops** while the pointer is over a toast or focus is inside
 *   it, and starts again, in full, when both have left;
 * - a caller whose action came from a key can ask for `focus: true`, and the
 *   toast's first link takes focus as it appears (the board does, for a
 *   refused `[`/`]`);
 * - Escape with focus inside a toast dismisses it — it is a *region* in
 *   `lib/shortcuts.ts`, like an assist panel — and a toast that goes while
 *   holding focus gives it back (`returnFocus`, or whatever had it before).
 */
export type ToastTone = "info" | "error";

export interface ToastLink {
  readonly label: string;
  readonly href: string;
}

export interface ToastInput {
  readonly message: string;
  /** Defaults to `info`. */
  readonly tone?: ToastTone;
  /** Up to a couple of links out of the message, e.g. "Fix packaging". */
  readonly links?: readonly ToastLink[];
  /**
   * Move focus to the first link as the toast appears. For an action that
   * came from a key, where the links are otherwise the far end of the tab
   * order.
   */
  readonly focus?: boolean;
  /**
   * Where focus goes if the toast is dismissed while holding it. Defaults to
   * the element that had focus when the toast took it.
   */
  readonly returnFocus?: () => void;
}

interface Toast extends ToastInput {
  readonly id: number;
  readonly tone: ToastTone;
}

/** How long each tone stays. An error is longer: it has links to act on. */
const TIMEOUT_MS: Record<ToastTone, number> = { info: 6_000, error: 12_000 };

/** More than this on screen at once is noise; the oldest drops off. */
const MAX_VISIBLE = 3;

interface ToastApi {
  /**
   * Show a message. Returns the id it was given.
   *
   * Push is the whole of the API a caller gets: dismissing is the toast's own
   * business — its timeout and its × button — and an exported `dismiss` that
   * nothing calls is an invitation to grow a second way of taking messages off
   * the screen. It comes back when something needs it.
   */
  push: (input: ToastInput) => number;
}

const NOOP: ToastApi = {
  push: () => {
    if (process.env.NODE_ENV !== "production") {
      // Not thrown: a missing provider must never be the reason a move or a
      // capture fails. It is a bug in the tree, and it says so loudly in dev.
      console.warn("useToast() was called outside <ToastProvider>; message dropped.");
    }
    return -1;
  },
};

const ToastContext = createContext<ToastApi | null>(null);

/** Push a message. Safe to call from any client component under the layout. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const start = useCallback(
    (id: number, tone: ToastTone) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TIMEOUT_MS[tone]),
      );
    },
    [dismiss],
  );

  /** Stop the clock: the toast is being read or used. */
  const hold = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      nextId.current += 1;
      const id = nextId.current;
      const tone = input.tone ?? "info";

      setToasts((current) => [...current, { ...input, id, tone }].slice(-MAX_VISIBLE));
      start(id, tone);
      return id;
    },
    [start],
  );

  // A component that unmounts mid-timeout (a navigation) must not leave the
  // timer behind.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  const alerts = toasts.filter((toast) => toast.tone === "error");
  const statuses = toasts.filter((toast) => toast.tone === "info");

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/*
        Below `md` the toasts sit under the phone's 56px bar rather than at the
        bottom: the bottom of a phone screen is where the thumb is, and on
        `/now` it is where the next row's control lands after a tick. M9's week
        walk found "Ticked: …" drawn over the Move button it was reporting on.
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 max-md:top-[4.25rem] max-md:bottom-auto">
        {/* Two regions, always present, each with its own politeness. */}
        <div role="status" aria-live="polite" className="contents">
          {statuses.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onDismiss={dismiss}
              onHold={hold}
              onRelease={start}
            />
          ))}
        </div>
        <div role="alert" className="contents">
          {alerts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onDismiss={dismiss}
              onHold={hold}
              onRelease={start}
            />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
  onHold,
  onRelease,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
  onHold: (id: number) => void;
  onRelease: (id: number, tone: ToastTone) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  /** Focus has been inside at some point: only then is it ours to give back. */
  const hadFocus = useRef(false);
  const { id, tone, focus: takeFocus, returnFocus } = toast;

  useDismiss(() => onDismiss(id), { within: ref });

  function settle(): void {
    if (hovered.current || focused.current) onHold(id);
    else onRelease(id, tone);
  }

  /*
    Take focus if asked, and give it back on the way out. A layout effect, so
    the cleanup still sees whether focus was inside while the nodes exist.
  */
  const returnRef = useRef(returnFocus);
  useLayoutEffect(() => {
    returnRef.current = returnFocus;
  });
  useLayoutEffect(() => {
    const element = ref.current;
    const before = document.activeElement;
    if (takeFocus) firstLink.current?.focus();
    return () => {
      if (element === null) return;
      const active = document.activeElement;
      const holding =
        element.contains(active) || (active === document.body && hadFocus.current);
      if (!holding) return;
      if (returnRef.current) returnRef.current();
      else if (before instanceof HTMLElement && document.contains(before)) before.focus();
    };
    // Mount only: one toast, one arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      data-testid="toast"
      data-tone={toast.tone}
      onPointerEnter={() => {
        hovered.current = true;
        settle();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        settle();
      }}
      onFocus={() => {
        focused.current = true;
        hadFocus.current = true;
        settle();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        focused.current = false;
        settle();
      }}
      className={[
        // Below `md` the toast is pinned under the bar, so it is capped to the
        // screen under it and scrolls inside itself rather than running off
        // the bottom (M10 review: 598px tall on a 568px phone).
        "pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-1 rounded-card border bg-background px-3 py-2 text-sm shadow-lg max-md:max-h-[calc(100svh-5.25rem)] max-md:overflow-y-auto",
        toast.tone === "error" ? "border-over-limit/60" : "border-border",
      ].join(" ")}
    >
      {/*
        Below `md` the sentence has its own full-width line and the links sit
        on a row under it. Beside them, `flex-1` squeezed it to a word per
        line on a 320px phone (M10 review).
      */}
      <p className="min-w-0 flex-1 max-md:basis-full">{toast.message}</p>

      {(toast.links ?? []).map((link, index) => (
        <Link
          key={link.href + link.label}
          ref={index === 0 ? firstLink : undefined}
          href={link.href}
          className="shrink-0 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent thumb:inline-flex thumb:min-h-11 thumb:items-center thumb:px-1"
        >
          {link.label}
        </Link>
      ))}

      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        data-testid="toast-dismiss"
        className="shrink-0 rounded-button px-1 text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent thumb:ml-auto thumb:inline-flex thumb:size-11 thumb:items-center thumb:justify-center thumb:px-0 thumb:text-base"
      >
        <span aria-hidden="true">×</span>
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}
