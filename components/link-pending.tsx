"use client";

import { useLinkStatus } from "next/link";

/**
 * The "I heard you" for a clicked link, drawn inside that `<Link>`.
 *
 * Every signed-in route is rendered on request, and none has a `loading.tsx`
 * (the sidebar is part of each page, so a route-level fallback would blank it
 * too). Without this, a click on a sidebar row changed nothing on screen until
 * the next page had finished rendering on the server, which reads as a click
 * that did not land.
 *
 * It is the current-row marker's shape, pulsing, on the row being opened: the
 * same "this one" signal the destination will show once it arrives. Always
 * rendered and toggled by opacity, so the pending state shifts no layout.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-link-pending={pending ? "" : undefined}
      className={[
        "pointer-events-none absolute top-1/2 left-0 h-3.5 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-opacity",
        pending ? "animate-pulse opacity-100" : "opacity-0",
      ].join(" ")}
    />
  );
}
