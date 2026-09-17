"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
 *   missing field, a "Fix packaging" link and a "Skip gate…" link*.
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
  /** Show a message. Returns the id, so a caller can dismiss it early. */
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
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
  dismiss: () => {},
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

  const push = useCallback(
    (input: ToastInput) => {
      nextId.current += 1;
      const id = nextId.current;
      const tone = input.tone ?? "info";

      setToasts((current) => [...current, { ...input, id, tone }].slice(-MAX_VISIBLE));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TIMEOUT_MS[tone]),
      );
      return id;
    },
    [dismiss],
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

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  const alerts = toasts.filter((toast) => toast.tone === "error");
  const statuses = toasts.filter((toast) => toast.tone === "info");

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {/* Two regions, always present, each with its own politeness. */}
        <div role="status" aria-live="polite" className="contents">
          {statuses.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
        <div role="alert" className="contents">
          {alerts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      data-testid="toast"
      data-tone={toast.tone}
      className={[
        "pointer-events-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-background px-3 py-2 text-sm shadow-lg",
        toast.tone === "error" ? "border-red-500/60" : "border-border",
      ].join(" ")}
    >
      <p className="min-w-0 flex-1">{toast.message}</p>

      {(toast.links ?? []).map((link) => (
        <Link
          key={link.href + link.label}
          href={link.href}
          className="shrink-0 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          {link.label}
        </Link>
      ))}

      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 rounded px-1 text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
      >
        <span aria-hidden="true">×</span>
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}
