"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import {
  addTemplateItem,
  removeTemplateItem,
  reorderTemplateItems,
  updateTemplateItem,
  type TemplateResult,
} from "@/app/actions/checklist-templates";
import { useSaveQueue, type SaveState } from "@/components/autosave";
import {
  moveTemplate,
  nextPosition,
  renumber,
  sortTemplates,
  type TemplateItem,
} from "@/lib/checklist-templates";

/**
 * One stage's template, on screen and on its way to the row.
 *
 * ## Built on the one save queue
 *
 * `components/autosave.tsx` already owns "one write on the wire at a time, the
 * next one queued behind it, a failure stops the queue and parks the rest".
 * This supplies what the checklist on the video page supplies: a patch that is
 * a *sequence of operations* (so queued patches concatenate instead of
 * replacing), and the apply/reconcile for each kind of operation. It is a
 * smaller relative of `components/checklist/use-checklist.ts`, and deliberately
 * so — a template is edited a few times a month, not ticked ten times a minute.
 *
 * ## Confirmed plus pending
 *
 * Every write answers with the stage's whole list, so reconciliation is not a
 * merge: what the server last said is `confirmed`, and what is drawn is that
 * list with every operation not yet sent replayed on top. When a write lands,
 * `confirmed` is replaced, the operation leaves the pending list, and the
 * screen is recomputed — so an edit made while an add was in flight is neither
 * lost under the server's answer nor applied twice.
 *
 * A failure rolls the screen back to `confirmed` — the row never took it — and
 * offers one Retry carrying the failed operation and everything parked behind
 * it, in order.
 *
 * ## Moves are relative until they are sent
 *
 * A move is stored as "this row, up" and turned into a complete order only at
 * send time, against the list the server has confirmed *by then*. Stored as an
 * order at click time it would name a row that was still `temp:` when an add
 * was in flight, and the server would rightly refuse it.
 */

export type TemplateOp =
  | { readonly kind: "add"; readonly tempId: string; readonly text: string; readonly estMinutes: number }
  | { readonly kind: "edit"; readonly id: string; readonly text?: string; readonly estMinutes?: number }
  | { readonly kind: "remove"; readonly id: string; readonly text: string }
  | { readonly kind: "move"; readonly id: string; readonly direction: "up" | "down" };

export interface TemplateEditor {
  /** The list, sorted, including anything not yet confirmed. */
  readonly items: readonly TemplateItem[];
  readonly state: SaveState<readonly TemplateOp[]>;
  readonly pending: boolean;
  readonly add: (text: string, estMinutes: number) => void;
  readonly edit: (id: string, patch: { text?: string; estMinutes?: number }) => void;
  readonly remove: (id: string) => void;
  readonly move: (id: string, direction: "up" | "down") => void;
  /** Re-send the operations that were rolled back. */
  readonly retry: () => void;
  /**
   * The text of the row most recently removed, once the server confirms it
   * gone — so the editor can say what that means for the videos already in
   * the stage. Cleared by the next operation.
   */
  readonly lastRemoved: string | null;
}

const TEMP_PREFIX = "temp:";

export function isUnsaved(item: { id: string }): boolean {
  return item.id.startsWith(TEMP_PREFIX);
}

function tempId(): string {
  return `${TEMP_PREFIX}${crypto.randomUUID()}`;
}

/** One operation applied to a list, as the screen would show it. */
export function applyOp(
  items: readonly TemplateItem[],
  op: TemplateOp,
): TemplateItem[] {
  switch (op.kind) {
    case "add":
      return sortTemplates([
        ...items,
        {
          id: op.tempId,
          stageId: items[0]?.stageId ?? "",
          text: op.text,
          estMinutes: op.estMinutes,
          position: nextPosition(items),
        },
      ]);
    case "edit":
      return items.map((item) =>
        item.id === op.id
          ? {
              ...item,
              text: op.text ?? item.text,
              estMinutes: op.estMinutes ?? item.estMinutes,
            }
          : item,
      );
    case "remove":
      return items.filter((item) => item.id !== op.id);
    case "move":
      return moveTemplate(items, op.id, op.direction) ?? renumber(sortTemplates(items));
  }
}

function replay(
  confirmed: readonly TemplateItem[],
  ops: readonly TemplateOp[],
): TemplateItem[] {
  let items: TemplateItem[] = sortTemplates(confirmed);
  for (const op of ops) items = applyOp(items, op);
  return items;
}

export function useTemplateEditor({
  stageId,
  initial,
}: {
  stageId: string;
  initial: readonly TemplateItem[];
}): TemplateEditor {
  const confirmed = useRef<readonly TemplateItem[]>(sortTemplates(initial));
  const pendingOps = useRef<TemplateOp[]>([]);
  const [items, setItems] = useState<readonly TemplateItem[]>(() =>
    sortTemplates(initial),
  );
  const [lastRemoved, setLastRemoved] = useState<string | null>(null);

  const redraw = useCallback(() => {
    setItems(replay(confirmed.current, pendingOps.current));
  }, []);

  /** Run one operation against the server, in the order it was dispatched. */
  const runOp = useCallback(
    async (op: TemplateOp): Promise<TemplateResult | null> => {
      switch (op.kind) {
        case "add":
          return addTemplateItem({ stageId, text: op.text, estMinutes: op.estMinutes });
        case "edit":
          return updateTemplateItem({
            templateId: op.id,
            text: op.text,
            estMinutes: op.estMinutes,
          });
        case "remove":
          return removeTemplateItem({ templateId: op.id });
        case "move": {
          // Resolved now, against what the server has confirmed by now.
          const order = moveTemplate(confirmed.current, op.id, op.direction);
          // Off the end, or the row is gone: nothing to write, nothing wrong.
          if (order === null) return null;
          return reorderTemplateItems({
            stageId,
            orderedIds: order.map((item) => item.id),
          });
        }
      }
    },
    [stageId],
  );

  const queue = useSaveQueue<readonly TemplateOp[]>({
    merge: (queued, next) => [...queued, ...next],
    save: async (ops) => {
      for (const op of ops) {
        let result: TemplateResult | null;
        try {
          result = await runOp(op);
        } catch {
          return {
            ok: false,
            error:
              "Could not reach the server, so this is not saved. Nothing on screen has been lost — try again.",
          };
        }
        if (result && !result.ok) return { ok: false, error: result.error };
        if (result) confirmed.current = sortTemplates(result.items);
        // This operation is the first pending one: they are sent in order.
        pendingOps.current = pendingOps.current.filter((pending) => pending !== op);
        if (op.kind === "remove") setLastRemoved(op.text);
        redraw();
      }
      return { ok: true };
    },
    onFailure: () => {
      // Everything not landed — the failed op and whatever was parked behind
      // it — comes off the screen. The Retry payload carries the same ops.
      pendingOps.current = [];
      redraw();
    },
  });

  const dispatch = useCallback(
    (op: TemplateOp) => {
      setLastRemoved(null);
      pendingOps.current = [...pendingOps.current, op];
      redraw();
      queue.send([op]);
    },
    [queue, redraw],
  );

  const add = useCallback(
    (text: string, estMinutes: number) =>
      dispatch({ kind: "add", tempId: tempId(), text, estMinutes }),
    [dispatch],
  );

  const edit = useCallback(
    (id: string, patch: { text?: string; estMinutes?: number }) => {
      if (isUnsaved({ id })) return;
      if (patch.text === undefined && patch.estMinutes === undefined) return;
      dispatch({ kind: "edit", id, ...patch });
    },
    [dispatch],
  );

  const remove = useCallback(
    (id: string) => {
      if (isUnsaved({ id })) return;
      const row = items.find((item) => item.id === id);
      if (!row) return;
      dispatch({ kind: "remove", id, text: row.text });
    },
    [dispatch, items],
  );

  const move = useCallback(
    (id: string, direction: "up" | "down") => {
      if (isUnsaved({ id })) return;
      dispatch({ kind: "move", id, direction });
    },
    [dispatch],
  );

  const retry = useCallback(() => {
    if (queue.state.kind !== "error") return;
    const ops = queue.state.payload;
    if (ops.length === 0) return;
    pendingOps.current = [...ops];
    redraw();
    queue.send(ops);
  }, [queue, redraw]);

  return useMemo(
    () => ({
      items,
      state: queue.state,
      pending: queue.pending,
      add,
      edit,
      remove,
      move,
      retry,
      lastRemoved,
    }),
    [add, edit, items, lastRemoved, move, queue.pending, queue.state, remove, retry],
  );
}
