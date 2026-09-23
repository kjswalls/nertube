"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The board's stages as a row of buttons, on a phone only (M10).
 *
 * Below 768px a column is nearly the width of the screen (see `BoardColumn`),
 * which is what makes a card readable there — and what makes nine columns
 * nine swipes. The weekly strip above says how many cards each busy stage
 * holds but is not a way to get to one. This row is: every stage in board
 * order with its count, 44px tall, and a tap scrolls the strip to that
 * column. The one showing is marked (`aria-current`), so the row also says
 * where in the pipeline you are.
 *
 * `md:hidden`: from 768px up the columns fit or nearly fit, and the desktop
 * board is exactly what M3 signed off. Buttons rather than links: the columns
 * have no address and should not get one just for this.
 */
export function StageJump({
  stages,
  boardRef,
}: {
  stages: readonly { readonly id: string; readonly name: string; readonly count: number }[];
  boardRef: RefObject<HTMLDivElement | null>;
}) {
  const [showing, setShowing] = useState(0);
  const rowRef = useRef<HTMLElement>(null);

  /*
    The row is wider than the screen too (nine stages), so the marked stage
    is kept in it: the M10 week walk found the board opened on Filming with
    "Film…" cut at the row's right edge. Only the row scrolls, sideways, and
    only when the marked button is not already whole — never the page.
  */
  useEffect(() => {
    const row = rowRef.current;
    const button = row?.querySelectorAll<HTMLElement>("button")[showing];
    if (!row || !button) return;
    const rowBox = row.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    if (box.left >= rowBox.left && box.right <= rowBox.right) return;
    const gutter = parseFloat(getComputedStyle(row).paddingLeft) || 0;
    row.scrollTo({ left: row.scrollLeft + box.left - rowBox.left - gutter, behavior: "auto" });
  }, [showing]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    // The column whose left edge is nearest the strip's — the one a snap
    // would settle on.
    const measure = () => {
      const left = board.getBoundingClientRect().left;
      const columns = Array.from(
        board.querySelectorAll<HTMLElement>('[data-testid="board-column"]'),
      );
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      columns.forEach((column, index) => {
        const gap = Math.abs(column.getBoundingClientRect().left - left);
        if (gap < distance) {
          distance = gap;
          best = index;
        }
      });
      setShowing(best);
    };
    measure();
    board.addEventListener("scroll", measure, { passive: true });
    return () => board.removeEventListener("scroll", measure);
  }, [boardRef]);

  function jump(index: number) {
    const board = boardRef.current;
    const column = board?.querySelectorAll<HTMLElement>(
      '[data-testid="board-column"]',
    )[index];
    if (!board || !column) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    board.scrollTo({
      left:
        board.scrollLeft +
        column.getBoundingClientRect().left -
        board.getBoundingClientRect().left,
      behavior: reduce ? "auto" : "smooth",
    });
  }

  return (
    <nav
      ref={rowRef}
      aria-label="Stages"
      data-testid="stage-jump"
      className="-mx-gutter overflow-x-auto px-gutter md:hidden"
    >
      <ul className="flex w-max gap-1.5">
        {stages.map((stage, index) => (
          <li key={stage.id}>
            <button
              type="button"
              data-testid="stage-jump-button"
              data-stage-name={stage.name}
              aria-current={index === showing ? "true" : undefined}
              onClick={() => jump(index)}
              className={[
                "flex min-h-11 items-center gap-2 rounded-button border px-3 text-[14px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent",
                index === showing
                  ? "border-accent/60 bg-surface font-medium text-foreground"
                  : "border-border text-muted",
              ].join(" ")}
            >
              {stage.name}
              <span className="font-mono text-[12px] text-muted">
                <span className="sr-only">, </span>
                {stage.count}
                <span className="sr-only">
                  {stage.count === 1 ? " video" : " videos"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
