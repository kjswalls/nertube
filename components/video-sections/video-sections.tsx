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
 * The cost is honest and small: five sections' markup on every video, four of
 * them not painted. Four of the five are a heading and a paragraph.
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
}

export function VideoSections({
  pathname,
  initial,
  facts,
  panels,
  underTabs,
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

  return (
    <PackagingLiveProvider>
      <div className="flex flex-col gap-6">
        <SectionNav
          pathname={pathname}
          active={active}
          facts={facts}
          onSelect={select}
        />

        {underTabs}

        {VIDEO_SECTIONS.map((section) => {
          const current = section.id === active;
          return (
            <div
              key={section.id}
              id={`section-${section.id}`}
              data-testid={`section-panel-${section.id}`}
              hidden={!current}
              // `hidden` is `display: none` at the lowest specificity there is,
              // so a `flex` utility on this element would beat it and the panel
              // would stay on screen. The class is only applied when it shows.
              className={current ? "flex flex-col gap-8" : undefined}
            >
              {panels[section.id]}
            </div>
          );
        })}
      </div>
    </PackagingLiveProvider>
  );
}
