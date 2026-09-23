"use client";

import Link, { useLinkStatus } from "next/link";

/**
 * List or matrix — the two ways of looking at one channel's ideas.
 *
 * PLAN.md gives the route one URL and one parameter: `/c/[slug]/ideas` is the
 * bank, `?view=matrix` is the grid. This is the control that says so, and it is
 * two real links for the same reason the video page's section tabs are links:
 * the view is a place, it can be pasted to somebody, and `aria-current="page"`
 * says which one is showing without inventing a tab widget that would then owe
 * arrow keys and a roving tabindex.
 *
 * There is one of these in the product, rendered by both halves of M5 — the
 * bank renders it (`components/ideas/list/idea-list.tsx`) because only the bank
 * knows what its filters currently are, and the matrix branch of the route
 * renders it with the query that route was asked for.
 *
 * ## Both links carry the filters
 *
 * The List link used to be a bare `/c/<slug>/ideas`, on the argument that the
 * matrix has no filters to preserve. The M5 review found what that costs:
 * arriving at the bank from a cell's drill-down — which carries *both* bucket
 * filters — glancing at the grid and coming back landed on an unfiltered list,
 * with nothing on screen to say anything had been dropped. A view switch is a
 * change of view, not a reset. So the query rides through both links and the
 * matrix ignores it, which is lossless in the only direction anybody notices.
 *
 * ## It says it heard the click
 *
 * `useLinkStatus` (`next/link`) is true between the press and the history
 * update. The destination is a dynamic route doing four RLS-scoped reads, so on
 * a slow connection the page sat completely unchanged for as long as the server
 * took — same heading, same `aria-current`, no busy state — which invites
 * pressing the one control M5 added for moving between its two halves again and
 * again. The hint is always rendered and only its opacity changes, because the
 * docs warn that an inline indicator is an easy way to introduce layout shift.
 */
export function IdeasViewSwitch({
  channelSlug,
  current,
  query,
}: {
  channelSlug: string;
  current: "list" | "matrix";
  /**
   * The bank's filters as a query string (`components/ideas/list/url.ts`
   * builds it), or `""`. Not the whole of `window.location.search`: `view` and
   * `cell` are this component's own business and are never carried across.
   */
  query?: string;
}) {
  const extra = query === undefined || query === "" ? "" : query;
  const listHref = extra === "" ? `/c/${channelSlug}/ideas` : `/c/${channelSlug}/ideas?${extra}`;
  const matrixHref =
    extra === ""
      ? `/c/${channelSlug}/ideas?view=matrix`
      : `/c/${channelSlug}/ideas?view=matrix&${extra}`;

  return (
    <nav
      aria-label="Idea views"
      data-testid="ideas-view-switch"
      data-current={current}
      className="flex items-center gap-1"
    >
      <ViewLink href={listHref} current={current === "list"} label="List" />
      <ViewLink href={matrixHref} current={current === "matrix"} label="Matrix" />
    </nav>
  );
}

function ViewLink({
  href,
  current,
  label,
}: {
  href: string;
  current: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      data-testid="ideas-view-link"
      className={[
        "flex items-center gap-1.5 rounded-button border px-2 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3 thumb:text-[14px]",
        current
          ? "border-border bg-surface font-medium text-foreground"
          : "border-transparent text-muted hover:text-foreground",
      ].join(" ")}
    >
      {label}
      <Pending />
    </Link>
  );
}

/**
 * The pending dot. A descendant of the `<Link>`, which is where `useLinkStatus`
 * is allowed to be read.
 */
function Pending() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-testid="view-link-pending"
      data-pending={pending ? "true" : "false"}
      className={[
        "h-1.5 w-1.5 shrink-0 rounded-full bg-accent transition-opacity",
        pending ? "animate-pulse opacity-100" : "opacity-0",
      ].join(" ")}
    />
  );
}
