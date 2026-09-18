import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono, Newsreader, Roboto } from "next/font/google";
import type { ReactNode } from "react";

import { ToastProvider } from "@/components/toast";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "NerTube",
  description: "A YouTube production pipeline: idea to published.",
};

/*
  The faces, self-hosted by `next/font`.

  Three of them are the product's (see the `--font-*` comments in
  `globals.css`); the fourth is Roboto, which exists only so the YouTube
  preview measures and draws in the face YouTube actually uses. Its note is
  beside it below.

  `next/font/google` downloads the files at build time and serves them from
  this application's own origin: no `<link>` to fonts.googleapis.com, so no
  render-blocking round trip to a third party and no request to Google from a
  reader's browser. Each one is asked for as a *variable* font — one file per
  family covering the whole weight range — which is why no `weight` is given
  for them.

  `display: "swap"` is the deliberate choice over `optional`: the fallback
  stacks in `globals.css` are metric-mismatched enough that a permanently
  wrong face is worse than one reflow, and every one of these faces is doing a
  job (see the `--font-*` comments) rather than decorating.

  Each declares the CSS variable it publishes; the `@theme inline` block maps
  the three product ones onto Tailwind's `font-display` / `font-sans` /
  `font-mono`. The fourth is deliberately not mapped onto anything.
*/

/** What the user wrote: page titles, video titles, hooks. */
const display = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-face-display",
});

/** The tool's own chrome: labels, buttons, help text. */
const sans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-face-sans",
});

/** What the tool measured: counts, ages, shortcut keys. */
const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-face-mono",
});

/*
  The fourth face is not one of the product's three, and it is not used by any
  of the product's chrome.

  It is **Roboto, for the YouTube preview only** — the face YouTube sets its
  titles in. Until it was here, `components/preview/measure-title.ts` measured
  in whatever the machine happened to fall back to (Liberation Sans on Linux,
  Arial on Windows, Helvetica on a Mac), and the preview's whole claim is that
  the cut it draws is the cut YouTube will make. Measuring a Roboto clamp in
  Arial is off by a character or two in the wrong direction, and it was the
  largest named gap in this component's fidelity.

  It costs no new dependency: `next/font/google` is already how the other
  three arrive, and this is one more call to it. The weights are pinned to the
  two the preview actually draws — 400 for a search title and a metadata line,
  500 for a feed and phone title — rather than the whole variable range, so the
  bytes fetched are the bytes used. It is self-hosted like the others, so no
  reader's browser asks Google for anything.

  Nothing else in the application may use it: Roboto is YouTube's voice here,
  not NerTube's, and `--font-face-youtube` is deliberately absent from the
  `@theme inline` block in `globals.css` so there is no utility class that
  could put it on a button by accident.
*/
const youtube = Roboto({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-face-youtube",
});

/**
 * `ToastProvider` is mounted here, once, rather than per page: a capture made
 * from the sidebar and a move refused on the board are the same kind of message
 * in the same corner of the screen, and one of them happens on every route the
 * sidebar is on. One provider is also what makes "exactly one toast mechanism"
 * true rather than aspirational — there is nowhere else to put a second one.
 *
 * It is a client component wrapping the tree, which does not make the tree a
 * client tree: `children` is still rendered on the server and passed through.
 *
 * ## The two unusual things in this file
 *
 * **The inline `<script>` in `<head>`.** It is the theme, and it has to run
 * before the first paint or the page flashes the wrong colours on every full
 * load. `lib/theme.ts` explains why nothing later in the lifecycle will do.
 *
 * **`suppressHydrationWarning` on `<html>`.** That script changes attributes
 * on the very element React is about to hydrate, so the server's `<html>` and
 * the browser's will differ by design, on exactly the two attributes it wrote.
 * The flag is scoped to this one element — it does not extend to `<body>` or
 * to anything inside it — so a real mismatch anywhere in the application is
 * still reported.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`h-full ${display.variable} ${sans.variable} ${mono.variable} ${youtube.variable}`}
    >
      <head>
        {/*
          A plain <script>, not `next/script`.

          `next/script` with `strategy="beforeInteractive"` looks like the
          right tool and is not: it emits
          `(self.__next_s=self.__next_s||[]).push([...])`, a queue Next's own
          runtime drains *after* it loads. That is one paint too late, which is
          the entire bug this element exists to prevent. Checked, not assumed —
          the emitted HTML for /login was read both ways.

          React logs a development-only warning about a `<script>` inside a
          component ("scripts inside React components are never executed when
          rendering on the client"). That is the behaviour this wants: the
          script belongs to the server's document, it has already run by the
          time React exists, and re-running it on a client navigation would do
          nothing but read `localStorage` again.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background font-sans text-foreground antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
