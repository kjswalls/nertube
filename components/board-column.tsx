import type { ReactNode } from "react";

/**
 * One kanban column: a header carrying the stage's name and its card count,
 * and a body that holds the cards.
 *
 * M0 renders these empty. M1 adds cards by passing them as `children` and a
 * real `count`; nothing else about the column has to change, which is why the
 * count is a prop rather than `children.length` and why the body is already a
 * scrolling flex column with the gap the cards will sit in.
 */
export function BoardColumn({
  name,
  count,
  children,
}: {
  name: string;
  count: number;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={name}
      className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-surface"
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="truncate text-sm font-medium" title={name}>
          {name}
        </h2>
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-xs tabular-nums text-muted">
          <span className="sr-only">{count === 1 ? "1 video" : `${count} videos`}</span>
          <span aria-hidden="true">{count}</span>
        </span>
      </header>

      <div className="flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {count === 0 ? (
          <p className="px-1 py-2 text-xs text-muted">Nothing here yet.</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
