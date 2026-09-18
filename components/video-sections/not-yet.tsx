import type { ReactNode } from "react";

/**
 * A section that has not been built yet, saying so.
 *
 * The alternative was drawing the M4 controls disabled — three thumbnail slots
 * with nothing behind them, a metrics pair that cannot be typed into. That is a
 * worse lie than an empty section: a disabled control claims the feature exists
 * and is unavailable *to you, now*, which is a sentence about permissions or
 * state. Nothing exists behind these two tabs at all, and the only honest thing
 * a page can do about that is name the milestone and say what will be there.
 *
 * (The assist pills next to the packaging fields are the opposite case, and
 * that is why they are drawn disabled rather than left out: the field they
 * belong to is real and finished, and where the button sits is a decision about
 * this screen. See `components/preview/assist-pill.tsx`.)
 */
export function NotYet({
  title,
  milestone,
  children,
}: {
  /** What this section will hold. */
  title: string;
  /** The milestone that builds it, e.g. "M4". */
  milestone: string;
  /** The detail: what will be here, and where the same job is done meanwhile. */
  children: ReactNode;
}) {
  return (
    <section
      data-testid="section-not-yet"
      data-milestone={milestone}
      className="flex flex-col gap-2 rounded-card border border-dashed border-border p-4"
    >
      <h2 className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        <span className="font-mono text-[11px] font-normal uppercase tracking-wide text-muted">
          arrives in {milestone}
        </span>
      </h2>
      <div className="flex flex-col gap-2 text-xs text-muted">{children}</div>
    </section>
  );
}
