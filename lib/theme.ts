/**
 * The theme choice: what is stored, what it means, and the one script that
 * applies it before anything is painted.
 *
 * There are **three** choices and only **two** palettes. "system" is not a
 * third set of colours; it is the absence of a decision, and it is represented
 * by the *absence* of `data-theme` on `<html>` so that the
 * `@media (prefers-color-scheme: dark)` block in `app/globals.css` is what
 * answers. That is the whole design:
 *
 * | stored        | `data-theme` | what decides the colours          |
 * |---------------|--------------|-----------------------------------|
 * | nothing       | absent       | the OS, through the media query   |
 * | `"system"`    | absent       | the OS, through the media query   |
 * | `"light"`     | `light`      | the attribute, beating the query  |
 * | `"dark"`      | `dark`       | the attribute, beating the query  |
 *
 * `data-theme-choice` is separate and always present once the script has run:
 * it carries *which of the three* was chosen, including the difference between
 * "system, and the system is dark" and "dark". The toggle's visible label is
 * selected from it in CSS rather than in React — see `ThemeToggle`.
 */

export const THEME_STORAGE_KEY = "nertube-theme";

export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (
    typeof value === "string" &&
    (THEME_CHOICES as readonly string[]).includes(value)
  );
}

/** The order the toggle cycles in: system → light → dark → system. */
export function nextThemeChoice(current: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.indexOf(current);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length];
}

/**
 * What the document currently says, which is authoritative in the browser: the
 * boot script below writes it before React exists, so reading it back is how
 * the toggle knows where in the cycle it is without keeping a second copy in
 * state that could disagree.
 */
export function readThemeChoice(): ThemeChoice {
  if (typeof document === "undefined") return "system";
  const value = document.documentElement.getAttribute("data-theme-choice");
  return isThemeChoice(value) ? value : "system";
}

/** Write a choice to the document. Browser only; does not persist. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  root.setAttribute("data-theme-choice", choice);
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

/**
 * The boot script, as source, for the `<script>` in `app/layout.tsx`.
 *
 * ## Why this is an inline, blocking script and not a `useEffect`
 *
 * This application is server-rendered: the HTML arrives with a `<body>` that
 * has a background, and the browser paints it as soon as it has the CSS.
 * An effect runs after hydration, which is several hundred milliseconds and a
 * whole paint later — so a user who asked for dark on a light OS would watch
 * the page flash white and then go dark, on every single navigation that is a
 * full load. The usual dodges (render nothing until mounted, cover it with a
 * spinner) are worse: they throw away the server render, which is the thing
 * that made the page fast.
 *
 * The fix is the only one there is: a tiny synchronous script in `<head>`,
 * before the first paint, that puts the stored choice on `<html>` so the very
 * first paint already has the right custom properties. It is ~200 bytes, it
 * has no dependencies, and it cannot block for longer than a `localStorage`
 * read.
 *
 * `try`/`catch` because `localStorage` *throws* — not returns null — in a
 * cross-origin iframe and under a "block all cookies" setting. A theme is not
 * worth a blank page, so a throw leaves the attributes off and the media query
 * in charge, which is exactly the "system" behaviour.
 *
 * It is written as a string rather than a function so that it cannot acquire
 * an import, a TypeScript helper or a transpiled `let` that assumes a module
 * scope it does not have.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,v=localStorage.getItem("${THEME_STORAGE_KEY}");if(v!=="light"&&v!=="dark")v="system";d.setAttribute("data-theme-choice",v);if(v==="system"){d.removeAttribute("data-theme")}else{d.setAttribute("data-theme",v)}}catch(e){}})()`;
