"use client";

import { useEffect, useRef } from "react";

/**
 * The one keyboard-shortcut hook (PLAN.md "Shortcuts": *one `useShortcuts` hook
 * that ignores events from inputs*).
 *
 * **Provenance.** M1's board needed `j`/`k`/`[`/`]`/`Enter` before this file
 * existed, so this is the *minimal* interface the board needs, written to the
 * shape PLAN.md describes rather than to the board's convenience. It is
 * deliberately small: a flat list of `{ key, description, run }`, one document
 * listener, and the "not while typing" rule. Whoever builds the full set (`c`,
 * `g n/b/i/k`, `1..9`, `p`, `x`, `?`) should be able to grow this file —
 * chords, a cheat sheet built from `description`, a provider — without the
 * board changing.
 *
 * ## What it guarantees
 *
 * - Matching is on `KeyboardEvent.key`, case-sensitively, so `j` and `J` are
 *   different bindings and `[` works on any layout that produces `[`.
 * - Nothing fires while the user is typing: a target that is an `input`,
 *   `textarea`, `select`, `contenteditable`, or anything with
 *   `role="textbox"`/`role="searchbox"`, is left alone. `c` must not eat the
 *   `c` in a title.
 * - Nothing fires with Ctrl/Meta/Alt held — those belong to the browser and the
 *   OS. Shift is allowed, because `?` needs it.
 * - `Enter` and `Space` are left alone when focus is on a control that already
 *   does something with them (a button, a link, a checkbox…), so a shortcut
 *   never double-fires with a native activation.
 * - An event another handler has already called `preventDefault()` on is
 *   ignored.
 * - IME composition (`event.isComposing`, `keyCode === 229`) is ignored.
 *
 * `run` is called with the raw `KeyboardEvent`; it is the binding's own job to
 * `preventDefault()` if it wants to (the board does, so `[`/`]` do not reach a
 * browser back/forward binding and `j` does not start a find-as-you-type).
 */
export interface Shortcut {
  /** The `KeyboardEvent.key` to match, e.g. `"j"`, `"["`, `"Enter"`, `"?"`. */
  readonly key: string;
  /** Human wording for the `?` cheat sheet (M9). Never rendered by this hook. */
  readonly description: string;
  /** What the key does. Called at most once per keydown. */
  readonly run: (event: KeyboardEvent) => void;
}

export interface UseShortcutsOptions {
  /**
   * Bind the listener at all. Defaults to `true`. A page that opens a modal
   * passes `false` while it is open rather than unmounting its bindings.
   */
  readonly enabled?: boolean;
  /**
   * Where to listen. Defaults to the document. Passing an element scopes the
   * shortcuts to that subtree (the event still has to bubble to it).
   */
  readonly target?: Document | HTMLElement | null;
}

/** True when the event started in something the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;

  const role = target.getAttribute("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") {
    return true;
  }

  return false;
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

/**
 * Bind `shortcuts` for as long as the calling component is mounted.
 *
 * The list may be rebuilt on every render — it is read through a ref, so the
 * listener is attached once and the bindings are always the current ones. That
 * matters for the board, whose `run` closures capture the selected card.
 */
export function useShortcuts(
  shortcuts: readonly Shortcut[],
  options: UseShortcutsOptions = {},
): void {
  const { enabled = true, target } = options;

  const latest = useRef(shortcuts);
  // Updated in an effect, not during render: a render that React throws away
  // must not leave its bindings behind in a ref. (It also keeps
  // `react-hooks/refs` happy, which flags a write during render.)
  useEffect(() => {
    latest.current = shortcuts;
  });

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    const node: Document | HTMLElement = target ?? document;

    function onKeyDown(event: Event): void {
      const keyEvent = event as KeyboardEvent;

      if (keyEvent.defaultPrevented) return;
      if (keyEvent.isComposing || keyEvent.keyCode === 229) return;
      if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
      if (isTypingTarget(keyEvent.target)) return;
      if (isNativelyActivated(keyEvent.key, keyEvent.target)) return;

      for (const shortcut of latest.current) {
        if (shortcut.key === keyEvent.key) {
          shortcut.run(keyEvent);
          return;
        }
      }
    }

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [enabled, target]);
}
