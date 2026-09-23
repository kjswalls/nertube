import type { ReactNode } from "react";

import {
  AppSidebar,
  boardChannelOf,
  type SidebarSection,
} from "@/components/app-sidebar";
import { countTargetsIn } from "@/lib/calendar-data";
import { monthKey, monthOf, todayColumn } from "@/lib/calendar-dates";
import { countIdeas } from "@/lib/ideas-data";
import { countNowRows, readNowInputs } from "@/lib/now-data";
import { requireUser } from "@/lib/supabase/require-user";
import { readTimeZone } from "@/lib/time-zone-data";
import { TimeZoneProvider } from "@/components/time-zone";
import { readClock } from "@/lib/request-clock";

/**
 * The frame every signed-in route renders inside — except `/capture` — with the
 * sidebar on the left and the page on the right.
 *
 * `/capture` is the exception on purpose and says so in its own file: it is the
 * phone bookmark (PLAN.md's standalone quick-capture page), so it renders one
 * input on a bare page with no chrome at all. The consequence worth stating,
 * because it is easy to assume otherwise from the paragraph below, is that `c`
 * and `1`..`9` are *not* bound there — the page is already the capture form, so
 * there is nothing for `c` to open.
 *
 * It does its own `requireUser()` rather than taking the user as a prop, for
 * the reason the old header did: a page that forgets to guard cannot end up
 * rendering chrome for nobody. The channel list is read here too, once per
 * request, and handed to the sidebar — the sidebar is a pure renderer so that
 * it can be reasoned about (and, later, screenshotted) without a database.
 *
 * ## Why the page is a `<main>` this component owns
 *
 * Every route used to open with its own `<div className="flex min-h-dvh">`,
 * its own `<AppHeader/>` and its own `<main>` with its own padding — four
 * copies of the same three lines, which is four chances for the gutters to
 * drift apart. The shell owns the frame; a page passes `gutter="reading"` when
 * it is prose rather than work, and otherwise says nothing.
 *
 * - **32px** on the board and the video page. Work: the content is dense, the
 *   edge is close, and every pixel spent on margin is a card not on screen.
 * - **40px** on reading views. Prose wants a wider rest at the edge, and these
 *   pages are narrow-measure anyway, so the cost is nothing.
 *
 * Those are the numbers from 1024px up. Below that the two tokens step down —
 * 24/32 between 768 and 1024, 16/20 on a phone — in `app/globals.css`, so this
 * file still says only "work" or "reading" and never a width (M9; M3's review
 * finding 32 measured a 102px content column at 390px).
 *
 * The scroll container is the page, not the frame: the sidebar is `sticky` and
 * `h-dvh` so it stays put while a long board scrolls, without a nested
 * scroller that would swallow the page's own scrollbar.
 *
 * ## The Now count, and the channel list, from one read
 *
 * The sidebar says how much work `/now` is holding, and the number is
 * `rankNow(...).length` over exactly the rows that page renders — one reader
 * (`lib/now-data.ts`), `cache()`d per request. A cheaper count from its own
 * query would be a second definition of "something to do" and would disagree
 * with the page it points at; the note on `readNowInputs` lists the three ways
 * it would be wrong. The price is that every signed-in route pays for those
 * reads, and on `/now` itself the cache means it pays once.
 *
 * The channel list for the sidebar comes out of the **same** read. It used to
 * be a second `select` issued immediately before the count, over the same rows
 * in the same order with one column fewer — two answers to one question, in six
 * lines of one function, in a milestone whose whole theme is that there is one
 * reader per question.
 *
 * ## The Ideas count
 *
 * The same argument, one channel at a time. The Ideas row links to
 * `boardChannelOf(...)`'s bank, so the number beside it is that channel's bank
 * and no other — which is why `boardChannelOf` is exported from the sidebar and
 * read here rather than written out twice. `lib/ideas-data.ts` owns the
 * definition of "an idea" it counts by, and returns `null` rather than throwing
 * or guessing zero when it cannot read.
 *
 * ## The Calendar count
 *
 * Cross-channel, because the calendar is: one number for the month `/calendar`
 * opens on, over every channel's videos. It is derived from the same clock this
 * component already reads and turned into a calendar day by the same helper the
 * page uses (`lib/calendar-dates.ts`), so the badge and the month it opens
 * cannot land on opposite sides of midnight. `lib/calendar-data.ts` owns the
 * definition it counts by and returns `null` rather than guessing zero.
 *
 * ## The time zone (M10)
 *
 * The user's zone is read here, once per request (`readTimeZone()`, `cache()`d
 * so the page's own call is the same query), and put in a context for every
 * client component below (`components/time-zone.tsx`). "Today" for the
 * Calendar count is the day in that zone, the same one the calendar page
 * computes. While no zone is recorded the provider also mounts the detector
 * that records the browser's.
 *
 * ## The badge is allowed to fail; the page is not
 *
 * `readNowInputs` throws when any of its reads errors, and every signed-in route
 * renders inside this component. Left unguarded, a transient failure reading
 * `checklist_items` would 500 the board, the video page and `/c/new` — routes
 * that need none of that data. So the whole read is wrapped: on failure the
 * sidebar draws with no count and no channels, exactly the way the channel
 * `select` already degraded, and the page underneath renders. `/now` itself
 * keeps throwing, because there the data *is* the page.
 */
export async function AppShell({
  currentSlug,
  section,
  gutter = "work",
  now,
  children,
}: {
  currentSlug?: string;
  section?: SidebarSection;
  gutter?: "work" | "reading";
  /**
   * The request's clock, when the page has already read one.
   *
   * `/now` passes its own so the badge and the list cannot land on opposite
   * sides of a 24-hour boundary. Every other route lets the shell read it,
   * because on those the count is the only thing that depends on it.
   */
  now?: number;
  children: ReactNode;
}) {
  const { user } = await requireUser();
  const timeZone = await readTimeZone();

  const clock = now ?? (await readClock());

  // Same order as `/`, which redirects to `/now` and falls back to the first
  // channel's board: `readNowInputs` reads `channels` ordered by `created_at`,
  // so a stable "first channel" means the two never disagree.
  let channels: { id: string; name: string; slug: string }[] = [];
  let nowCount = 0;
  try {
    // Both from the one `cache()`d read: the second call costs nothing, and
    // the ranking stays in the file that owns it.
    const inputs = await readNowInputs();
    channels = inputs.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      slug: channel.slug,
    }));
    nowCount = await countNowRows(clock, timeZone.zone);
  } catch {
    // The chrome degrades; the page does not disappear. See the note above.
  }

  // The bank the Ideas row opens, and therefore the bank it counts. Its own
  // reader swallows its own failures, so there is nothing to catch here.
  const ideasChannel = boardChannelOf(channels, currentSlug);
  const ideasCount =
    ideasChannel === undefined ? null : await countIdeas(ideasChannel.id);

  // The month `/calendar` opens on, from this request's one clock read. Its
  // reader swallows its own failures, like the bank's.
  const thisMonth = monthOf(todayColumn(clock, timeZone.zone));
  const calendarCount =
    thisMonth === null ? null : await countTargetsIn(monthKey(thisMonth));

  return (
    /*
      `overflow-x: clip` and not `hidden`: `hidden` on one axis forces the other
      to compute to `auto`, which would make this element a vertical scroll
      container and take the sticky sidebar's scrollport away from it. `clip`
      leaves `overflow-y: visible` alone, which is the whole reason it exists.

      What it is for: the board's column strip scrolls sideways, and its
      scrollable overflow was reaching the viewport — see the note on the strip
      itself. That is fixed at the strip; this is the belt to its braces, so no
      future wide child can scroll the chrome off the screen.
    */
    /*
      A column below `md` — the sidebar is a bar across the top there, see
      `AppSidebar` — and a row from `md` up, which is the layout M3 signed off.
    */
    <TimeZoneProvider zone={timeZone.zone} known={timeZone.known}>
      <div className="flex min-h-dvh w-full flex-col overflow-x-clip md:flex-row">
        {/*
          The bypass block (WCAG 2.4.1). The sidebar is ten tab stops on a
          two-channel account — wordmark, Capture, Now, Board, Ideas, Calendar,
          each channel, + New channel, Theme, Sign out — and it renders before
          the page on every signed-in route, so without this a keyboard user
          walks all of it to reach the first thing on the page, every time.

          Off-screen until focused rather than `display: none`, because a hidden
          element is not focusable and a skip link that cannot be focused is not a
          skip link.
        */}
        <a
          href="#main"
          data-testid="skip-to-main"
          /*
            Off-screen by transform rather than by `sr-only` + `focus:not-sr-only`:
            that pair toggles `position` in two utilities whose order in the sheet
            decides the winner, and one property (`transform`) has no such
            argument. `overflow-x: clip` on the element below clips it while it is
            parked, so it cannot widen the page either.
          */
          className="absolute top-2 left-2 z-50 -translate-x-[200%] rounded-button border border-border bg-surface px-3 py-2 text-[13px] focus-visible:translate-x-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Skip to content
        </a>

        <AppSidebar
          channels={channels}
          currentSlug={currentSlug}
          section={section}
          nowCount={nowCount}
          ideasCount={ideasCount}
          calendarCount={calendarCount}
          userEmail={user.email ?? null}
        />

        <main
          id="main"
          // The skip link's target. `-1` so it can be focused by the jump without
          // joining the tab order itself.
          tabIndex={-1}
          data-testid="app-main"
          data-gutter={gutter}
          className={[
            /*
              `relative` is load-bearing, and M9 found it at 390px on the matrix.
              An `sr-only` span is `position: absolute`; with no positioned
              ancestor its containing block is the viewport, and overflow
              clipping does not apply to a box whose containing block is outside
              the clipping element. So every visually hidden label inside the
              matrix's sideways-scrolling table sat at its static position, 900px
              out, and scrolled the whole page 507px — past the `overflow-x:
              clip` above, which was never asked about it. Positioning `main`
              makes it their containing block, and then the clip holds.
            */
            "relative flex min-w-0 flex-1 flex-col outline-none",
            gutter === "reading"
              ? "px-gutter-reading py-gutter-reading"
              : "px-gutter py-gutter",
          ].join(" ")}
        >
          {children}
        </main>
      </div>
    </TimeZoneProvider>
  );
}
