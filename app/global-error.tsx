"use client";

import "./globals.css";

import {
  PRIMARY_ACTION,
  QUIET_ACTION,
  StatePanel,
} from "@/components/state-panel";

/**
 * The last resort: the root layout itself failed, so `app/error.tsx` (which
 * renders inside it) cannot. Next requires this file to bring its own `<html>`
 * and `<body>`, and it gets neither the fonts nor the theme attribute the
 * layout would have set — `globals.css` still follows the system's light or
 * dark preference, which is what the layout's default is anyway.
 *
 * Deliberately smaller than `app/error.tsx`, but the same presentation: M9's
 * integration pass put it on `StatePanel`, the one shape every empty, missing
 * and failed view in the application uses. `StatePanel` is plain markup with
 * no state and no data, so depending on it costs this page nothing it could
 * fail on; a hand-drawn second "problem" layout was the thing to avoid.
 */
export default function GlobalError({ retry }: { retry: () => void }) {
  return (
    <html lang="en">
      <body className="bg-background font-sans text-foreground antialiased">
        <title>Something went wrong · NerTube</title>
        <main className="flex min-h-dvh w-full items-start justify-center px-gutter-reading py-[12vh]">
          <StatePanel
            tone="problem"
            headingLevel={1}
            className="w-full"
            title="NerTube didn’t load"
            actions={
              <>
                <button type="button" onClick={() => retry()} className={PRIMARY_ACTION}>
                  Try again
                </button>
                <a href="/now" className={QUIET_ACTION}>
                  Go to Now
                </a>
              </>
            }
          >
            <p>
              Something went wrong before the page could be drawn — usually the
              connection or the database, for a moment. Nothing you had already
              saved is affected.
            </p>
          </StatePanel>
        </main>
      </body>
    </html>
  );
}
