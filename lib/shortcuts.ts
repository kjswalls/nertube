"use client";

import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";

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
 * to `document` when the first binding (or dismissable layer) registers and
 * removed when the last one leaves. Call sites register; the registry
 * dispatches. M9 folded the last two keyboard paths that lived elsewhere — the
 * modal's Escape and the assist panel's Escape — into it, so "what does this
 * key do right now" has one answer in one file.
 *
 * ## The rules a binding can rely on
 *
 * - Matching is on `KeyboardEvent.key`, case-sensitively, so `j` and `J` are
 *   different bindings and `[` works on any layout that produces `[`.
 * - **Nothing fires while the user is typing.** An event whose target is a
 *   text-entry `input` (text, search, number, date, url…), a `textarea`, a
 *   `select`, anything contenteditable, or an element with
 *   `role="textbox"`/`"searchbox"`/`"combobox"`/`"spinbutton"` is left alone.
 *   `c` must not eat the `c` in a title, and `1` must not switch channel while
 *   a title is being written. A checkbox or a radio is *not* typing — ticking a
 *   row on `/now` and pressing `j` must move on — but Enter and Space on one
 *   belong to the browser, like on a button.
 * - Nothing fires with Ctrl/Meta/Alt held — those belong to the browser and the
 *   OS. Shift is allowed, because `?` needs it, and so is AltGr, because on a
 *   German or French keyboard it is the only way to type `[`, `]` or `/`.
 * - `Enter`/`Space` stand aside when focus is on a control the browser already
 *   activates with them (a button, a link, a checkbox), so a shortcut never
 *   double-fires with a native activation.
 * - An event another handler has already called `preventDefault()` on is
 *   ignored, and IME composition (`isComposing`, `keyCode === 229`) is ignored.
 * - **A binding registered while an `exclusive` scope is open is the only kind
 *   that fires.** That is how a modal makes the board's keys inert while it is
 *   open, without the board knowing the modal exists.
 * - Two bindings on one key: the most recently registered wins, and only one
 *   `run` is called per keydown.
 * - `run` receives the raw event and does its own `preventDefault()` — the
 *   board does, so `[` cannot reach a browser history binding and `j` does not
 *   start find-as-you-type.
 *
 * ## Two-key sequences
 *
 * A binding whose `key` holds a space — `"g n"` — is a sequence: the first key
 * arms it, the second key within {@link CHORD_TIMEOUT_MS} completes it. The
 * second key is *consumed* whether or not it completes anything, so `g` then a
 * stray `c` does not open capture: after `g` the next key is always read as
 * "go where?". Escape, or any keystroke into a field, cancels an armed
 * sequence. A key that starts a sequence cannot also be a binding of its own.
 *
 * ## Escape, defined once
 *
 * Escape dismisses exactly **one** thing per press, the first of:
 *
 * 1. an armed `g` sequence;
 * 2. the topmost **overlay** — a dialog (`components/modal.tsx`: capture, the
 *    swap reason, the `?` sheet) or any other layer drawn over the page —
 *    newest first, from anywhere, including from inside a text field;
 * 3. the **region** that contains focus — an inline assist panel — innermost
 *    first, also from inside a field;
 * 4. an ordinary binding on `Escape` — clearing the selection on the board,
 *    `/now` and the idea bank — which, like every binding, stands aside while
 *    the user is typing.
 *
 * A field that gives Escape a local meaning (reverting an edit in a settings
 * row) calls `preventDefault()` and so comes before all of these: the innermost
 * thing that uses Escape takes it and nothing else sees it. Layers register
 * with {@link useDismiss}; nothing else in the application listens for Escape.
 *
 * Registering nothing, on a route where a shortcut does not exist, is a no-op:
 * this file never assumes a board, a channel or a modal is on the page.
 */
export interface ShortcutHint {
  /**
   * How the key is written, e.g. `"j / k"` (either), `"g n"` (one then the
   * other), `"1–9"` or `"Enter"`.
   */
  readonly keys: string;
  /** A few words, lower case, for the hint bar: "select a card". */
  readonly text: string;
  /**
   * The `?` sheet's wording, when the bar's few words need their context
   * back: the bar can say "open it" beside `j / k`; a sheet row cannot.
   * Defaults to `text` with a capital.
   */
  readonly label?: string;
  /**
   * Whether the always-visible hint bar lists it. Defaults to `true`. The `?`
   * sheet lists every hinted binding; the bar is kept to the few that earn the
   * space.
   */
  readonly bar?: boolean;
}

export interface Shortcut {
  /**
   * The `KeyboardEvent.key` to match, e.g. `"j"`, `"["`, `"Enter"`, `"?"` — or
   * two keys separated by a space for a sequence, e.g. `"g n"`.
   */
  readonly key: string;
  /** Human wording, for assistive technology. */
  readonly description: string;
  /**
   * What the hint bar and the `?` sheet show for this binding, or nothing when
   * a sibling binding speaks for it (`k` says nothing; `j` says
   * "j / k — select a card").
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
   * keys. A modal uses it: with the dialog open, `j` is not a board key any
   * more — it is either text or nothing.
   */
  readonly exclusive?: boolean;
  /**
   * The heading these bindings sit under on the `?` sheet, named for what the
   * person is doing: "Get around", "On the board". Registrations sharing a
   * title share a group. Omitted, the bindings are live but unlisted.
   */
  readonly group?: string;
}

/** How long an armed `g` waits for its second key. */
export const CHORD_TIMEOUT_MS = 1500;

interface Registration {
  shortcuts: readonly Shortcut[];
  enabled: boolean;
  exclusive: boolean;
  group: string | undefined;
  /** Registration order; higher is newer and wins a key conflict. */
  order: number;
}

interface Dismissable {
  dismiss: () => void;
  enabled: boolean;
  /** Absent: an overlay. Present: a region, live while focus is inside it. */
  within: RefObject<HTMLElement | null> | undefined;
  order: number;
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

const registrations = new Set<Registration>();
const dismissables = new Set<Dismissable>();
let nextOrder = 0;

/** Subscribers to the *visible* state: the hint list and an armed sequence. */
const subscribers = new Set<() => void>();
/** Cached so `useSyncExternalStore` sees a stable value between changes. */
let hintSnapshot: readonly Shortcut[] = [];

/** The first key of an armed sequence, or null. */
let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

/** Input types that take text. Everything else is a control, not a field. */
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

/** True when the event started in something the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type.toLowerCase());
  }
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;

  const role = target.getAttribute("role");
  return (
    role === "textbox" ||
    role === "searchbox" ||
    role === "combobox" ||
    role === "spinbutton"
  );
}

/**
 * True when the browser itself will act on Enter/Space for this target, so a
 * shortcut bound to the same key must stand aside.
 */
function isNativelyActivated(key: string, target: EventTarget | null): boolean {
  if (key !== "Enter" && key !== " ") return false;
  if (!(target instanceof HTMLElement)) return false;

  // A checkbox, radio, file or button input: not typing, but the browser owns
  // its activation keys.
  if (target instanceof HTMLInputElement) return true;

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

/**
 * Every enabled registration, newest first, whether or not an overlay is
 * silencing it — for the hint bar only.
 *
 * The bar is page furniture: it describes the page's keys, and the page is
 * still there under a dialog. Built from `activeRegistrations()` it went empty
 * the moment any `Modal` opened, and an empty bar renders nothing — which
 * unmounted the bar's own "all keys" button, the opener of the `?` sheet, so
 * closing the sheet gave focus back to a detached element and it landed on
 * <body> (M9 review). What may *fire* is still `activeRegistrations()`.
 */
function enabledRegistrations(): Registration[] {
  return [...registrations]
    .filter((entry) => entry.enabled)
    .sort((a, b) => b.order - a.order);
}

function disarm(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  if (pending === null) return;
  pending = null;
  notify();
}

function arm(prefix: string): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pending = prefix;
  pendingTimer = setTimeout(disarm, CHORD_TIMEOUT_MS);
  notify();
}

/** Steps 2 and 3 of the Escape order. True when something took it. */
function dismissOne(target: EventTarget | null): boolean {
  const live = [...dismissables].filter((entry) => entry.enabled);

  const overlays = live
    .filter((entry) => entry.within === undefined)
    .sort((a, b) => b.order - a.order);
  if (overlays.length > 0) {
    overlays[0].dismiss();
    return true;
  }

  if (!(target instanceof Node)) return false;
  let innermost: { entry: Dismissable; element: HTMLElement } | null = null;
  for (const entry of live) {
    const element = entry.within?.current;
    if (!element || !element.contains(target)) continue;
    if (innermost === null || innermost.element.contains(element)) {
      innermost = { entry, element };
    }
  }
  if (innermost === null) return false;
  innermost.entry.dismiss();
  return true;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

function onKeyDown(event: Event): void {
  const keyEvent = event as KeyboardEvent;

  if (keyEvent.defaultPrevented) return;
  if (keyEvent.isComposing || keyEvent.keyCode === 229) return;
  if (keyEvent.metaKey) return;
  // AltGr is how half the world types `[`, `]`, `/` and `?` — on Windows it
  // arrives as Ctrl+Alt — so it is a way of *producing* a key, not a modifier
  // on one. Ctrl or Alt without it still belongs to the browser.
  const altGraph = keyEvent.getModifierState?.("AltGraph") === true;
  if ((keyEvent.ctrlKey || keyEvent.altKey) && !altGraph) return;
  // Shift on its way to `?` must not cancel anything.
  if (MODIFIER_KEYS.has(keyEvent.key)) return;

  if (keyEvent.key === "Escape") {
    // 1. An armed sequence.
    if (pending !== null) {
      keyEvent.preventDefault();
      disarm();
      return;
    }
    // 2 and 3. The topmost overlay, else the region focus is in.
    if (dismissOne(keyEvent.target)) {
      keyEvent.preventDefault();
      return;
    }
    // 4. Falls through to the ordinary bindings below.
  }

  if (isTypingTarget(keyEvent.target)) {
    disarm();
    return;
  }
  if (isNativelyActivated(keyEvent.key, keyEvent.target)) return;

  const live = activeRegistrations();

  if (pending !== null) {
    // The second key of a sequence is always consumed: see the header.
    const sequence = `${pending} ${keyEvent.key}`;
    disarm();
    keyEvent.preventDefault();
    for (const entry of live) {
      for (const shortcut of entry.shortcuts) {
        if (shortcut.key === sequence) {
          shortcut.run(keyEvent);
          return;
        }
      }
    }
    return;
  }

  for (const entry of live) {
    for (const shortcut of entry.shortcuts) {
      if (shortcut.key === keyEvent.key) {
        shortcut.run(keyEvent);
        return;
      }
      if (shortcut.key.startsWith(`${keyEvent.key} `)) {
        if (keyEvent.repeat) return;
        keyEvent.preventDefault();
        arm(keyEvent.key);
        return;
      }
    }
  }
}

let listening = false;

function syncListener(): void {
  if (typeof document === "undefined") return;
  const wanted =
    [...registrations].some((entry) => entry.enabled) ||
    [...dismissables].some((entry) => entry.enabled);
  if (wanted && !listening) {
    document.addEventListener("keydown", onKeyDown);
    listening = true;
  } else if (!wanted && listening) {
    document.removeEventListener("keydown", onKeyDown);
    listening = false;
    disarm();
  }
}

/** Recompute the visible legend and tell whoever renders it. */
function publish(): void {
  syncListener();

  // A sequence armed under a registration that has since gone (the route
  // changed between `g` and `n`) must not survive it.
  if (pending !== null && sequencesAfter(pending).length === 0) disarm();

  const seen = new Set<string>();
  const hints: Shortcut[] = [];
  // Oldest first, so the legend reads c · 1–9 · j/k · [ ] · Enter: the sidebar
  // registers before the page underneath it does.
  for (const entry of [...enabledRegistrations()].reverse()) {
    for (const shortcut of entry.shortcuts) {
      if (!shortcut.hint || shortcut.hint.bar === false) continue;
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
  notify();
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
  const { enabled = true, exclusive = false, group } = options;

  const registration = useRef<Registration | null>(null);
  if (registration.current === null) {
    registration.current = { shortcuts, enabled, exclusive, group, order: 0 };
  }

  // The bindings and the flags are written in an effect rather than during
  // render: a render React throws away must not leave its bindings behind.
  useEffect(() => {
    const entry = registration.current;
    if (!entry) return;
    entry.shortcuts = shortcuts;
    entry.enabled = enabled;
    entry.exclusive = exclusive;
    entry.group = group;
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

/**
 * Make the calling component one of the things Escape closes — see "Escape,
 * defined once" above for where it falls in the order.
 *
 * - With no `within`, it is an **overlay**: the newest one enabled takes
 *   Escape from anywhere on the page, including from inside a text field (a
 *   dialog's title input is exactly where Escape has to work).
 * - With `within`, it is a **region**: it takes Escape only while focus is
 *   inside that element, and only when no overlay is open.
 */
export function useDismiss(
  onDismiss: () => void,
  options: {
    readonly enabled?: boolean;
    readonly within?: RefObject<HTMLElement | null>;
  } = {},
): void {
  const { enabled = true, within } = options;

  const layer = useRef<Dismissable | null>(null);
  if (layer.current === null) {
    layer.current = { dismiss: onDismiss, enabled, within, order: 0 };
  }

  useEffect(() => {
    const entry = layer.current;
    if (!entry) return;
    entry.dismiss = onDismiss;
    entry.within = within;
    if (entry.enabled !== enabled) {
      entry.enabled = enabled;
      // Re-enabling a layer makes it the newest: an overlay opened again is on
      // top of whatever opened while it was shut.
      if (enabled) {
        nextOrder += 1;
        entry.order = nextOrder;
      }
      syncListener();
    }
  });

  useEffect(() => {
    const entry = layer.current;
    if (!entry) return;
    nextOrder += 1;
    entry.order = nextOrder;
    dismissables.add(entry);
    syncListener();
    return () => {
      dismissables.delete(entry);
      syncListener();
    };
  }, []);
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
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
  return useSyncExternalStore(subscribe, readHints, readServerHints);
}

/** One key that completes an armed sequence, for the indicator. */
export interface SequenceStep {
  readonly key: string;
  readonly text: string;
}

function sequencesAfter(prefix: string): SequenceStep[] {
  const steps: SequenceStep[] = [];
  const seen = new Set<string>();
  for (const entry of [...activeRegistrations()].reverse()) {
    for (const shortcut of entry.shortcuts) {
      if (!shortcut.key.startsWith(`${prefix} `)) continue;
      const key = shortcut.key.slice(prefix.length + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ key, text: shortcut.hint?.text ?? shortcut.description });
    }
  }
  return steps;
}

function readPending(): string | null {
  return pending;
}
function readServerPending(): null {
  return null;
}

/**
 * The first key of an armed sequence (`"g"`), or null — so the page can say
 * what the next key will do while it waits for it.
 */
export function usePendingSequence(): {
  prefix: string | null;
  steps: readonly SequenceStep[];
} {
  const prefix = useSyncExternalStore(subscribe, readPending, readServerPending);
  return { prefix, steps: prefix === null ? [] : sequencesAfter(prefix) };
}

/** One group of the `?` sheet. */
export interface SheetGroup {
  readonly title: string;
  readonly entries: readonly ShortcutHint[];
}

/**
 * What the `?` sheet lists: every hinted binding that is live now, grouped by
 * its registration's `group`, in registration order.
 *
 * A snapshot, taken by whoever opens the sheet *before* it opens — the sheet
 * is a modal, and the moment it mounts its exclusive scope silences the page
 * it is describing.
 */
export function readShortcutSheet(): SheetGroup[] {
  const groups = new Map<string, ShortcutHint[]>();
  const seen = new Set<string>();
  for (const entry of [...activeRegistrations()].reverse()) {
    if (entry.group === undefined) continue;
    for (const shortcut of entry.shortcuts) {
      if (!shortcut.hint) continue;
      const identity = `${entry.group}\u0000${shortcut.hint.keys}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const list = groups.get(entry.group) ?? [];
      list.push(shortcut.hint);
      groups.set(entry.group, list);
    }
  }
  return [...groups].map(([title, entries]) => ({ title, entries }));
}
