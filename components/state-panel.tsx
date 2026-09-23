import type { ReactNode } from "react";

/**
 * The one way this application says "there is nothing here yet" or "that did
 * not work" at the size of a view.
 *
 * M9 found eight milestones of these written eight ways: a bare muted sentence
 * on `/now`, "Nothing here yet." nine times across an empty board, "Press c to
 * capture an idea" in the bank (a key a phone does not have), a bordered card on
 * the calendar, a wordier bordered card on the matrix, and Next's own unstyled
 * "404: This page could not be found." for every missing video and channel.
 * Each was honest; together they read as nine tools. This is the shape they
 * share now.
 *
 * ## What every use of it has to say
 *
 * Three things, and the props are the three things:
 *
 * 1. **`title`** — what this view is, in the state it is in. "This board is
 *    empty", not "Oops".
 * 2. **`children`** — why it is in that state, and what changes it. One or two
 *    sentences. Not a pitch for the feature, and not a shrug.
 * 3. **`actions`** — the one thing to do next, one click away. A primary
 *    action first (`PRIMARY_ACTION`), then at most a quiet alternative
 *    (`QUIET_ACTION`). A state panel with no way forward is the dead end this
 *    component exists to prevent, so `actions` is required; a view that
 *    genuinely has nothing to offer should not be drawing one of these.
 *
 * ## Why it looks like this
 *
 * A card — 8px radius, 1px hairline, the surface ground, no shadow (shadows
 * are for overlays) — so an empty view reads as *a view with something in it
 * that says it is empty*, not as a page that failed to finish loading. The
 * title is in the display face at 17px because it sits where a page's first
 * content would; everything else is the tool's own voice, in the sans.
 *
 * `tone="problem"` is for errors, and it changes one thing: a 3px rule in the
 * attention colour down the leading edge. Not red — `over-limit` is the one
 * red in the product and it means a rule is being broken right now, which a
 * failed load is not — and not the accent, which means "press this". The
 * words carry the meaning; the rule is the shape that says "this one is not
 * just empty".
 *
 * It is a server component with no state, so a route's `not-found.tsx`, the
 * client `error.tsx` and a client list's empty branch can all render it.
 */
export function StatePanel({
  title,
  children,
  actions,
  tone = "empty",
  testId,
  headingLevel = 2,
  className = "",
}: {
  title: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  tone?: "empty" | "problem";
  testId?: string;
  /** `1` when the panel *is* the page (a 404, an error), else `2`. */
  headingLevel?: 1 | 2;
  className?: string;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <section
      data-testid={testId}
      data-state-panel={tone}
      className={[
        "flex max-w-xl flex-col gap-2 rounded-card border border-border bg-surface px-5 py-4",
        tone === "problem" ? "border-l-[3px] border-l-attention" : "",
        className,
      ].join(" ")}
    >
      <Heading className="font-display text-[17px] leading-snug font-semibold tracking-tight text-foreground">
        {title}
      </Heading>
      {children ? (
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted">
          {children}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
        {actions}
      </div>
    </section>
  );
}

/**
 * The main way forward. The same filled button `/c/new` has always used for
 * "Create channel", so the one strong control on an empty view looks like the
 * one strong control everywhere else. 44px under `thumb:`.
 */
export const PRIMARY_ACTION =
  "inline-flex items-center gap-2 rounded-button bg-foreground px-3 py-2 text-[13px] font-medium text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 thumb:min-h-11 thumb:px-4";

/** The alternative, when there is one: a link-weight control beside it. */
export const QUIET_ACTION =
  "rounded-button px-1 py-1 text-[13px] text-muted underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11";
