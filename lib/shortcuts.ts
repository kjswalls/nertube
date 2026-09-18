"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The one keyboard mechanism (PLAN.md "Shortcuts": *one `useShortcuts` hook
 * that ignores events from inputs*).
 *
 * ## Why this is a registry and not a hook that adds a listener
 *
 * M1 landed from three directions at once, and two of them ended up calling
 * this file: the sidebar (`c`, `1..9`) and the board (`j`/`k`, `[`/`]`,
 * `Enter`). A hook that attached its own `keydown` listener per call site gave
 * one listener per mounted component, no way to see the whole set, and no way
 * for a modal to take the keyboard away from the page underneath it — three
 * separate bugs waiting for the fourth call site.
 *
 * So there is exactly one `keydown` listener in the application. It is attached
 * to `document` when the first binding registers and removed when the last one
 * leaves. Call sites register a list of bindings; the registry dispatches.
 *
 * ## The rules a binding can rely on
 *
 * - Matching is on `KeyboardEvent.key`, case-sensitively, so `j` and `J` are
 *   different bindings and `[` works on any layout that produces `[`.
 * - **Nothing fires while the user is typing.** An event whose target is an
 *   `input`, `textarea`, `select`, `contenteditable` or an element with
 *   `role="textbox"`/`"searchbox"`/`"combobox"` is left alone. `c` must not eat
 *   the `c` in a title, and `1` must not switch channel while a title is being
 *   written.
 * - Nothing fires with Ctrl/Meta/Alt held — those belong to the browser and the
 *   OS. Shift is allowed, because `?` needs it (M9).
 * - `Enter`/`Space` stand aside when focus is on a control the browser already
 *   activates with them (a button, a link, a checkbox), so a shortcut never
 *   double-fires with a native activation.
 * - An event another handler has already called `preventDefault()` on is
 *   ignored, and IME composition (`isComposing`, `keyCode === 229`) is ignored.
 * - **A binding registered while an `exclusive` scope is open is the only kind
 *   that fires.** That is how the capture modal makes the board's keys inert
 *   while it is open, without the board knowing the modal exists.
 * - Two bindings on one key: the most recently registered wins, and only one
 *   `run` is called per keydown.
 * - `run` receives the raw event and does its own `preventDefault()` — the
 *   board does, so `[` cannot reach a browser history binding and `j` does not
 *   start find-as-you-type.
 *
 * Registering nothing, on a route where a shortcut does not exist, is a no-op:
 * this file never assumes a board, a channel or a modal is on the page.
 */
export interface ShortcutHint {
  /** How the key is written in the hint bar, e.g. `"j / k"` or `"1–9"`. */
  readonly keys: string;
  /** Two or three words, lower case: "select a card". */
  readonly text: string;
}

export interface Shortcut {
  /** The `KeyboardEvent.key` to match, e.g. `"j"`, `"["`, `"Enter"`, `"?"`. */
  readonly key: string;
  /** Human wording, for assistive technology and the M9 `?` sheet. */
  readonly description: string;
  /**
   * What the hint bar shows for this binding, or nothing when a sibling
   * binding speaks for it (`k` says nothing; `j` says "j / k — select a card").
   */
  readonly hint?: ShortcutHint;
  /** What the key does. Called at most once per keydown. */
  readonly run: (event: KeyboardEvent) => void;
}

export interface UseShortcutsOptions {
  /**
   * Bind at all. Defaults to `true`. A component that has nothing to bind to
   * yet passes `false` rather than calling the hook conditionally.
   */
  readonly enabled?: boolean;
  /**
   * While this registration is mounted, only `exclusive` registrations receive
   * keys. The capture modal uses it: with the dialog open, `j` is not a board
   * key any more — it is either text or nothing.
   */
  readonly exclusive?: boolean;
}

interface Registration {
  shortcuts: readonly Shortcut[];
  enabled: boolean;
  exclusive: boolean;
  /** Registration order; higher is newer and wins a key conflict. */
  order: number;
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

const registrations = new Set<Registration>();
let nextOrder = 0;

/** Subscribers to the *hint* list (the visible legend), not to the keys. */
const hintSubscribers = new Set<() => void>();
/** Cached so `useSyncExternalStore` sees a stable value between changes. */
let hintSnapshot: readonly Shortcut[] = [];

/** True when the event started in something the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;

  const role = target.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

/**
 * True when the browser itself will act on Enter/Space for this target, so a
 * shortcut bound to the same key must stand aside.
 */
function isNativelyActivated(key: string, target: EventTarget | null): boolean {
  if (key !== "Enter" && key !== " ") return false;
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  if (tag === "BUTTON" || tag === "SUMMARY") return true;
  // A link is only activated by Enter, and only when it has an href.
  if (tag === "A" && target.hasAttribute("href")) return key === "Enter";

  const role = target.getAttribute("role");
  return role === "button" || role === "link" || role === "checkbox";
}

/** The registrations that may fire, newest first. */
function activeRegistrations(): Registration[] {
  const enabled = [...registrations].filter((entry) => entry.enabled);
  const exclusive = enabled.filter((entry) => entry.exclusive);
  const live = exclusive.length > 0 ? exclusive : enabled;
  return live.sort((a, b) => b.order - a.order);
}

function onKeyDown(event: Event): void {
  const keyEvent = event as KeyboardEvent;

  if (keyEvent.defaultPrevented) return;
  if (keyEvent.isComposing || keyEvent.keyCode === 229) return;
  if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
  if (isTypingTarget(keyEvent.target)) return;
  if (isNativelyActivated(keyEvent.key, keyEvent.target)) return;

  for (const entry of activeRegistrations()) {
    for (const shortcut of entry.shortcuts) {
      if (shortcut.key === keyEvent.key) {
        shortcut.run(keyEvent);
        return;
      }
    }
  }
}

let listening = false;

function syncListener(): void {
  if (typeof document === "undefined") return;
  const wanted = [...registrations].some((entry) => entry.enabled);
  if (wanted && !listening) {
    document.addEventListener("keydown", onKeyDown);
    listening = true;
  } else if (!wanted && listening) {
    document.removeEventListener("keydown", onKeyDown);
    listening = false;
  }
}

/** Recompute the visible legend and tell whoever renders it. */
function publish(): void {
  syncListener();

  const seen = new Set<string>();
  const hints: Shortcut[] = [];
  // Oldest first, so the legend reads c · 1–9 · j/k · [ ] · Enter: the sidebar
  // registers before the page underneath it does.
  for (const entry of [...activeRegistrations()].reverse()) {
    for (const shortcut of entry.shortcuts) {
      if (!shortcut.hint) continue;
      if (seen.has(shortcut.hint.keys)) continue;
      seen.add(shortcut.hint.keys);
      hints.push(shortcut);
    }
  }

  const changed =
    hints.length !== hintSnapshot.length ||
    hints.some((shortcut, index) => shortcut !== hintSnapshot[index]);
  if (!changed) return;

  hintSnapshot = hints;
  for (const notify of hintSubscribers) notify();
}

/* -------------------------------------------------------------------------- */
/* The hooks                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Bind `shortcuts` for as long as the calling component is mounted.
 *
 * The list may be rebuilt on every render — it is read through the
 * registration, which an effect keeps current — so the listener is attached
 * once and the bindings are always the newest ones. That matters for the board,
 * whose `run` closures capture the selected card.
 */
export function useShortcuts(
  shortcuts: readonly Shortcut[],
  options: UseShortcutsOptions = {},
): void {
  const { enabled = true, exclusive = false } = options;

  const registration = useRef<Registration | null>(null);
  if (registration.current === null) {
    registration.current = { shortcuts, enabled, exclusive, order: 0 };
  }

  // The bindings and the flags are written in an effect rather than during
  // render: a render React throws away must not leave its bindings behind.
  useEffect(() => {
    const entry = registration.current;
    if (!entry) return;
    entry.shortcuts = shortcuts;
    entry.enabled = enabled;
    entry.exclusive = exclusive;
    publish();
  });

  useEffect(() => {
    const entry = registration.current;
    if (!entry) return;
    nextOrder += 1;
    entry.order = nextOrder;
    registrations.add(entry);
    publish();
    return () => {
      registrations.delete(entry);
      publish();
    };
  }, []);
}

function subscribeToHints(notify: () => void): () => void {
  hintSubscribers.add(notify);
  return () => {
    hintSubscribers.delete(notify);
  };
}

function readHints(): readonly Shortcut[] {
  return hintSnapshot;
}

/** Nothing is bound on the server, so the legend starts empty and fills in. */
const NO_HINTS: readonly Shortcut[] = [];
function readServerHints(): readonly Shortcut[] {
  return NO_HINTS;
}

/**
 * The bindings that are live *right now*, for the visible legend.
 *
 * Derived from the registry rather than written out by hand anywhere, so the
 * hint bar cannot advertise a key that no longer exists or miss one that was
 * added — including the case that matters, where a key means something on one
 * route and nothing on another.
 */
export function useShortcutHints(): readonly Shortcut[] {
  return useSyncExternalStore(subscribeToHints, readHints, readServerHints);
}
