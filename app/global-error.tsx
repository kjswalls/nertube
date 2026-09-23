"use client";

import "./globals.css";

/**
 * The last resort: the root layout itself failed, so `app/error.tsx` (which
 * renders inside it) cannot. Next requires this file to bring its own `<html>`
 * and `<body>`, and it gets neither the fonts nor the theme attribute the
 * layout would have set — `globals.css` still follows the system's light or
 * dark preference, which is what the layout's default is anyway.
 *
 * Deliberately smaller than `app/error.tsx`: if the layout is what broke,
 * the less this page depends on, the more likely it is to draw. Same words,
 * same way forward.
 */
export default function GlobalError({ retry }: { retry: () => void }) {
  return (
    <html lang="en">
      <body className="bg-background font-sans text-foreground antialiased">
        <title>Something went wrong · NerTube</title>
        <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-3 px-5">
          <h1 className="font-display text-[20px] font-semibold">
            NerTube didn&rsquo;t load
          </h1>
          <p className="text-[14px] leading-relaxed text-muted">
            Something went wrong before the page could be drawn — usually the
            connection or the database, for a moment. Nothing you had already
            saved is affected.
          </p>
          <div className="flex gap-4 pt-1">
            <button
              type="button"
              onClick={() => retry()}
              className="rounded-button bg-foreground px-3 py-2 text-[13px] font-medium text-background"
            >
              Try again
            </button>
            <a href="/now" className="py-2 text-[13px] text-muted underline">
              Go to Now
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
