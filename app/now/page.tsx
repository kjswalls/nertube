import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { NowView } from "@/components/now/now-view";
import { readNowInputs } from "@/lib/now-data";
import { readClock } from "@/lib/request-clock";

export const metadata = { title: "Now · NerTube" };

/**
 * `/now` — "I have ten minutes. What can I move right now?"
 *
 * BRIEF.md calls this view *as important as the board*, and it is the one page
 * that is deliberately **not** about a video: it is about the next ten minutes.
 * Every row is one action on one video, and every row can be finished where it
 * stands.
 *
 * ## What this file does, and what it refuses to do
 *
 * It reads, and it hands the result to `lib/next-action.ts`. It contains no
 * rule about what the next action *is* — that lives in the pure function, where
 * it is unit-tested against PLAN.md's eight rules, and it is the same function
 * the client re-runs when a row is completed. Two copies of the ranking, one on
 * each side of the wire, is exactly the bug that would make a ticked row
 * reappear in the wrong section.
 *
 * The reading is not here either, any more: it is `lib/now-data.ts`, because
 * the sidebar draws a count of these same rows on every signed-in route and a
 * badge computed from a second, cheaper query would disagree with this list.
 * One reader, `cache()`d per request, so asking twice on this page costs one
 * set of queries.
 *
 * ## The clock is read once
 *
 * `readClock()` here (`lib/request-clock.ts`, the request's one `Date.now()`),
 * passed down as a number, and used for every age on the
 * page — including the ones the client recomputes after an interaction. That is
 * what makes the server's HTML and the browser's first render agree, and it is
 * why "3 days in stage" does not silently become "4 days" halfway down the
 * list. A reload gets a new clock; nothing else does.
 */
export default async function NowPage() {
  const { channels, videos } = await readNowInputs();

  if (channels.length === 0) {
    // Same destination as `/`: there is nothing to have ten minutes *for* yet.
    redirect("/c/new");
  }

  // The page's one clock read. See the file comment.
  const now = await readClock();

  return (
    <AppShell section="now" now={now}>
      <NowView channels={channels} videos={videos} now={now} />
    </AppShell>
  );
}
