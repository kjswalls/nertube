import type { ReactNode } from "react";

import { AppSidebar, type SidebarSection } from "@/components/app-sidebar";
import { countNowRows } from "@/lib/now-data";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * The frame every signed-in route renders inside: the sidebar on the left, the
 * page on the right.
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
 * The scroll container is the page, not the frame: the sidebar is `sticky` and
 * `h-dvh` so it stays put while a long board scrolls, without a nested
 * scroller that would swallow the page's own scrollbar.
 *
 * ## The Now count
 *
 * The sidebar says how much work `/now` is holding, and the number is
 * `rankNow(...).length` over exactly the rows that page renders — one reader
 * (`lib/now-data.ts`), `cache()`d per request. A cheaper count from its own
 * query would be a second definition of "something to do" and would disagree
 * with the page it points at; the note on `readNowInputs` lists the three ways
 * it would be wrong. The price is that every signed-in route pays for those
 * reads, and on `/now` itself the cache means it pays once.
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
  const { supabase, user } = await requireUser();

  // Same order as `/`, which redirects to `/now` and falls back to the first
  // channel's board: a stable "first channel" means the two never disagree.
  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, slug")
    .order("created_at", { ascending: true });

  // eslint-disable-next-line react-hooks/purity
  const clock = now ?? Date.now();
  const nowCount = await countNowRows(clock);

  return (
    <div className="flex min-h-dvh w-full">
      <AppSidebar
        channels={channels ?? []}
        currentSlug={currentSlug}
        section={section}
        nowCount={nowCount}
        userEmail={user.email ?? null}
      />

      <main
        data-testid="app-main"
        data-gutter={gutter}
        className={[
          "flex min-w-0 flex-1 flex-col",
          gutter === "reading"
            ? "px-gutter-reading py-gutter-reading"
            : "px-gutter py-gutter",
        ].join(" ")}
      >
        {children}
      </main>
    </div>
  );
}
