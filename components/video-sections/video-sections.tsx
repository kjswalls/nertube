"use client";

import { useEffect, useState, type ReactNode } from "react";

import { PackagingLiveProvider } from "@/components/preview/live-packaging";

import { SectionNav } from "./section-nav";
import {
  DEFAULT_SECTION,
  parseSection,
  SECTION_PARAM,
  VIDEO_SECTIONS,
  type SectionFacts,
  type VideoSectionId,
} from "./sections";

/**
 * The video page's section routing: which one is showing, what the URL says
 * about it, and why none of it ever costs an unsaved edit.
 *
 * ## Every section is mounted, all the time
 *
 * Switching a section shows and hides, it does not mount and unmount. That is
 * the whole mechanism behind "switching sections must not lose unsaved edits":
 * the packaging block holds a draft, an autosave queue and an in-flight
 * request, and unmounting it would throw all three away — a half-typed
 * thumbnail concept would simply be gone, under a tab that still said 2/3.
 * Hidden panels use the `hidden` attribute, so they are out of the tab order and
 * out of the accessibility tree, and not merely invisible.
 *
 * The cost is honest, and M4 raised it. Five sections' markup renders on every
 * video, four of them not painted — and three of the five are now real work
 * (the packaging block, the three thumbnail slots with their feed comparison,
 * and the post-publish block), not a heading and a paragraph. Hydration is one
 * synchronous pass over the whole tree, so a heavier page is a longer window in
 * which a server-rendered control has no handler yet and a first click can be
 * swallowed. `e2e/hydration.ts` holds the full argument and the retry helper
 * the specs use.
 *
 * The trade is still the right way round: unmounting the hidden panels would
 * turn a swallowed first click into a lost draft, which is the worse of the
 * two. The honest fix if it gets worse is to make the sections lighter.
 *
 * ## The URL changes without a navigation
 *
 * `window.history.pushState` — which Next.js supports directly for exactly this
 * and keeps `usePathname` / `useSearchParams` in step with (see
 * `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`,
 * "Native History API"). It is not a navigation: no route transition, no
 * loading state, no scroll reset, and nothing unmounts.
 *
 * To be exact about what it *is*, because the dev server's log shows it: one
 * `GET` of the route at the new URL appears per tab click, which is Next
 * bringing its own router into step with the address bar. What does not happen
 * is a remount — the tree the packaging block is holding its draft, its
 * autosave queue and its in-flight request in is reconciled in place, and the
 * spec asserts exactly that by typing into a box nothing commits and finding it
 * still there a tab later.
 *
 * So the address bar is always paste-able, the back button walks the sections
 * (`popstate` is listened for), and a cold load of `?section=script` is
 * rendered on the server already open at Script. Three ways in, one answer.
 *
 * ## Why the state is not read from `useSearchParams`
 *
 * It could be: `pushState` syncs it. But `useSearchParams` in a component that
 * is not inside a `<Suspense>` opts the route into client-side rendering, and
 * the hook would then be a second thing that has to agree with the server's own
 * parse of the same parameter. One parse, on the server, handed down as
 * `initial`; the browser owns it from there.
 */

export interface VideoSectionsProps {
  /** `/videos/<id>` — the base every tab's href is built from. */
  pathname: string;
  /** What `?section=` said when the server rendered, already parsed. */
  initial: VideoSectionId;
  /** What each tab says about itself; the packaging one is re-derived live. */
  facts: SectionFacts;
  /** The five panels, rendered by the server and handed over as elements. */
  panels: Readonly<Record<VideoSectionId, ReactNode>>;
  /**
   * Rendered between the tabs and the panels, inside the provider: the
   * checklist strip, which belongs to the whole video rather than to any one
   * section and therefore must not move when the section changes.
   */
  underTabs?: ReactNode;
  /**
   * What a section puts in the **right rail**, if anything.
   *
   * Only Packaging has one today — the YouTube preview, which has to sit beside
   * the title box rather than below it, because the whole point of it is
   * watching the clamp move while the title is typed.
   */
  rails?: Partial<Record<VideoSectionId, ReactNode>>;
  /**
   * The line above the tabs — channel, stage, and the page's heading.
   *
   * It is passed in rather than rendered by the page around this component
   * because this component owns the page column's *width*: with a rail the
   * column is the main measure plus the rail, without one it is the reading
   * measure, and a header rendered outside would be aligned to neither.
   */
  header?: ReactNode;
}

export function VideoSections({
  pathname,
  initial,
  facts,
  panels,
  underTabs,
  rails,
  header,
}: VideoSectionsProps) {
  const [active, setActive] = useState<VideoSectionId>(initial);

  /*
    A navigation that *did* re-render the server — a `Link` from somewhere else
    carrying its own `?section=`, a `router.refresh()` after a stage move —
    arrives here as a new `initial`, and the section it names wins.

    Adjusted during render rather than in an effect. React's own guidance for
    "reset state when a prop changes" is exactly this shape: compare against the
    last prop seen, set both, and let React restart the render before anything
    is committed to the DOM. In an effect it would be a second commit, so the
    old section would paint for a frame first.
  */
  const [lastInitial, setLastInitial] = useState<VideoSectionId>(initial);
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setActive(initial);
  }

  // Back and forward through the sections this component pushed.
  useEffect(() => {
    const onPopState = () => {
      const raw = new URLSearchParams(window.location.search).get(SECTION_PARAM);
      setActive(parseSection(raw ?? undefined));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const select = (id: VideoSectionId) => {
    setActive(id);
    const search = id === DEFAULT_SECTION ? "" : `?${SECTION_PARAM}=${id}`;
    // Built from the live location rather than from `pathname` so a URL that
    // carries something else — a hash from a gate deep link — is not quietly
    // rewritten by changing tabs.
    window.history.pushState(null, "", `${window.location.pathname}${search}`);
  };

  /*
    The rail, and why the page's width is decided here.

    `hasRail` is about the *set* of rails, not about the one showing. If the
    column narrowed every time the user opened Script and widened again on
    Packaging, the tabs would slide out from under the pointer on every click —
    a layout that moves the control you just used. So the column keeps one
    width for the whole page, and the rail column is simply empty for the four
    sections that do not fill it.

    Side by side only above 1480px, and the number is not a taste: the rail
    holds the YouTube preview, whose frames are YouTube's own pixel sizes, and
    a 360px feed card shrunk to fit a narrow rail would answer "does this
    read?" wrongly — the one thing that component must never do. 224 sidebar +
    32 gutter + 672 measure + 32 gap + 452 rail + 32 gutter is 1444, so the
    breakpoint sits just above it. Below it the rail's content is not dropped;
    the grid is one column and it stacks under the panels at full size, which
    is exactly where the preview sat before the rail existed.
  */
  const rail = rails?.[active] ?? null;
  const hasRail = rails !== undefined && Object.keys(rails).length > 0;

  /*
    Every class below is written out in full rather than composed from a
    shared constant, because Tailwind finds the classes it must generate by
    scanning this file as text: a template hole is a class that never gets a
    rule. The breakpoint therefore appears literally, five times, and the
    comment above is the one place it is explained.
  */
  const column = hasRail ? "max-w-2xl min-[1480px]:max-w-[1156px]" : "max-w-2xl";
  const split = hasRail
    ? "grid grid-cols-1 items-start gap-8 min-[1480px]:grid-cols-[minmax(0,42rem)_var(--spacing-rail-max)]"
    : "flex flex-col";

  return (
    <PackagingLiveProvider>
      <div className={`mx-auto flex w-full flex-col gap-8 ${column}`}>
        {header}

        <div className="flex flex-col gap-6">
          <SectionNav
            pathname={pathname}
            active={active}
            facts={facts}
            onSelect={select}
          />

          {underTabs}

          <div className={split}>
            <div className="flex min-w-0 flex-col gap-8">
              {VIDEO_SECTIONS.map((section) => {
                const current = section.id === active;
                return (
                  <div
                    key={section.id}
                    id={`section-${section.id}`}
                    data-testid={`section-panel-${section.id}`}
                    hidden={!current}
                    // `hidden` is `display: none` at the lowest specificity
                    // there is, so a `flex` utility on this element would beat
                    // it and the panel would stay on screen. The class is only
                    // applied when it shows.
                    className={current ? "flex flex-col gap-8" : undefined}
                  >
                    {panels[section.id]}
                  </div>
                );
              })}
            </div>

            {/*
              The column is kept on every section; the *landmark* is not.

              Keeping the grid column the same width whatever section is open is
              the decision argued above — it is what stops the tabs sliding
              under the pointer when one is pressed. Emitting a labelled
              `<aside>` to hold that column is a separate thing, and it is not
              what that argument justifies: on Script, Thumbnails, Flow and
              Publish the element has no children, so a screen reader's landmark
              list gained a complementary region called "Alongside this section"
              containing nothing, on four sections out of five. An empty
              placeholder keeps the arithmetic and says nothing.
            */}
            {hasRail ? (
              rail === null ? (
                <div data-testid="video-rail" data-filled="false" aria-hidden="true" />
              ) : (
                <aside
                  data-testid="video-rail"
                  data-filled="true"
                  aria-label="Alongside this section"
                  // The 1px rule and the gutter belong to the rail only where
                  // there *is* a rail beside something: stacked, a left border
                  // on a full-width block is a stripe down the page. `sticky`
                  // keeps the preview in view while the packaging block below
                  // it is scrolled through.
                  className="min-w-0 min-[1480px]:sticky min-[1480px]:top-gutter min-[1480px]:border-l min-[1480px]:border-border min-[1480px]:pl-gutter"
                >
                  {rail}
                </aside>
              )
            ) : null}
          </div>
        </div>
      </div>
    </PackagingLiveProvider>
  );
}

