"use client";

import { useEffect, useState } from "react";

import {
  PRIMARY_ACTION,
  QUIET_ACTION,
  StatePanel,
} from "@/components/state-panel";

/**
 * The page could not be drawn.
 *
 * Until M9 the application had no `error.tsx`, and three components said so in
 * their own comments ("the app has no `app/error.tsx`"), each having been
 * bitten by it: an unhandled rejection or a thrown read replaced the whole
 * route with Next's own screen — in production, "Application error: a
 * server-side exception has occurred", white, unstyled, with no way back but
 * the address bar. Every page that reads data throws when a read fails
 * (`/now`'s reader, the board's stages, the video page's row), which is right
 * — a page drawn from half its data would lie — but it needed somewhere to
 * land.
 *
 * ## What it says, and why
 *
 * Almost every failure that reaches this file is a read that did not come
 * back: the database or the network, not a bug in what was typed. So it says
 * that, says that nothing already saved was touched (a read writes nothing),
 * and offers the two things that fix a transient failure: try again, or go
 * somewhere else. The browser's own "offline" flag picks the sentence, because
 * "the server" is the wrong thing to blame when the laptop is on a train.
 *
 * The server's message is not shown. In production Next replaces it with a
 * generic string anyway (so it cannot leak a query), and the digest — the id
 * that finds the real message in the server's log — is printed small instead,
 * for the one person who will go and look.
 *
 * ## Why there is no sidebar
 *
 * An error boundary is a client component and `AppShell` is an async server
 * component that reads the database — the thing that has just failed. So this
 * renders on the bare page ground, centred, with "Go to Now" as a real
 * navigation (a full page load, not a client transition into the same broken
 * state).
 *
 * `retry` is Next 16.3's stable name for re-fetching and re-rendering the
 * segment (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-
 * conventions/error.md`); `reset` would re-render without re-fetching, which
 * cannot fix a read.
 */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Logged for the developer console, which is where a digest is matched.
    console.error(error);
  }, [error]);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <main
      id="main"
      data-testid="route-error"
      className="flex min-h-dvh w-full items-start justify-center px-gutter-reading py-[12vh]"
    >
      <title>Something went wrong · NerTube</title>
      <StatePanel
        tone="problem"
        headingLevel={1}
        className="w-full"
        title={offline ? "You’re offline" : "This page didn’t load"}
        actions={
          <>
            <button type="button" onClick={() => retry()} className={PRIMARY_ACTION}>
              Try again
            </button>
            {/* A plain anchor: a full load, not a client transition. */}
            <a href="/now" className={QUIET_ACTION}>
              Go to Now
            </a>
          </>
        }
      >
        <p>
          {offline
            ? "NerTube needs the connection to read your videos. Nothing you had already saved is affected."
            : "NerTube couldn’t read what this page needs — usually the connection or the database, for a moment. Nothing you had already saved is affected."}
        </p>
        <p>
          Trying again is safe: loading a page never changes anything.
        </p>
        {error.digest ? (
          <p className="font-mono text-[11px]">Reference {error.digest}</p>
        ) : null}
      </StatePanel>
    </main>
  );
}
