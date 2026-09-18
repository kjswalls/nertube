"use client";

import { useCallback } from "react";

import {
  applyTheme,
  nextThemeChoice,
  readThemeChoice,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

/**
 * The theme control, in the sidebar footer: one button that cycles
 * system → light → dark → system.
 *
 * ## It has no React state, on purpose
 *
 * The obvious version holds the current choice in `useState`, initialised from
 * `localStorage` in an effect. That version flashes: the server has no idea
 * what is stored, so it renders "System", and the correct word appears one
 * paint later. The same trick that fixes the *colours* fixes the label — the
 * boot script has already put `data-theme-choice` on `<html>` before anything
 * is painted, so the answer is in the document by the time this button exists.
 *
 * So all three words are rendered, and **CSS** reveals the one that matches
 * the attribute (see `app/globals.css`). The markup the server sends and the
 * markup React hydrates are identical — there is nothing to reconcile and
 * nothing to flash — and the two hidden words are `display: none`, which takes
 * them out of the accessibility tree too, so the button's accessible name is
 * "Theme: Dark" and not "Theme: System Light Dark".
 *
 * The click handler reads the choice back off the document rather than from a
 * copy of its own, which is what keeps a second tab, a manual attribute change
 * and this button from ever disagreeing about where in the cycle we are.
 */
export function ThemeToggle() {
  const cycle = useCallback(() => {
    const choice = nextThemeChoice(readThemeChoice());
    applyTheme(choice);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // Storage is blocked (private mode, "block all cookies"). The theme still
      // changes for this page; it just will not survive a reload. Losing the
      // preference is a better outcome than an unhandled exception in a click
      // handler, which React would turn into an error boundary.
    }
  }, []);

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={cycle}
      title="Switch between following the system, light and dark"
      className="flex w-full items-center justify-between gap-2 rounded-button border border-border px-2 py-1.5 text-[12px] text-muted outline-none transition-colors hover:border-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span>Theme</span>
      {/*
        Exactly one of these is displayed, chosen by `data-theme-choice` on
        <html>. The wrapper carries the mono face because this is a value the
        tool is reporting back, not prose.
      */}
      <span className="font-mono text-[11px] tracking-tight text-foreground">
        <span data-theme-value="system">System</span>
        <span data-theme-value="light">Light</span>
        <span data-theme-value="dark">Dark</span>
      </span>
    </button>
  );
}
