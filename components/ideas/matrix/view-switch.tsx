import Link from "next/link";

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
 * It is rendered by the route for both views, so the two halves of M5 cannot
 * end up with one switch each.
 */
export function IdeasViewSwitch({
  channelSlug,
  current,
}: {
  channelSlug: string;
  current: "list" | "matrix";
}) {
  return (
    <nav
      aria-label="Idea views"
      data-testid="ideas-view-switch"
      data-current={current}
      className="flex items-center gap-1"
    >
      <ViewLink
        href={`/c/${channelSlug}/ideas`}
        current={current === "list"}
        label="List"
      />
      <ViewLink
        href={`/c/${channelSlug}/ideas?view=matrix`}
        current={current === "matrix"}
        label="Matrix"
      />
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
      className={[
        "rounded-button border px-2 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
        current
          ? "border-border bg-surface font-medium text-foreground"
          : "border-transparent text-muted hover:text-foreground",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}
