"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import {
  addChecklistItem,
  deleteChecklistItem,
  resetChecklist,
  toggleChecklistItem,
  type ChecklistResult,
} from "@/app/actions/checklist";
import { useSaveQueue, type SaveState } from "@/components/autosave";
import { sortItems, topPosition, type ChecklistItem } from "@/lib/checklist";

/**
 * The checklist's client state: what is on screen, and how it gets to the row.
 *
 * ## Optimistic, with a rollback that is real
 *
 * A tick has to land under the cursor immediately — it is the one interaction
 * this product has that happens ten times in a row — so every operation here is
 * applied to the list *before* it is sent. The price of that is honesty when
 * the write fails, and M2's reviewers found three bugs in exactly this area, so
 * the rules are written down:
 *
 * 1. **A failure puts the screen back.** Not "shows an error next to a tick
 *    that stayed ticked": the row returns to the state the server last
 *    confirmed, and the message says why. An optimistic tick that survives its
 *    own failure is the app lying about a row the user will never look at
 *    again.
 * 2. **Only the operations that did not land are rolled back.** Writes go out
 *    in order, one at a time; when the third of five fails, the first two are
 *    on the server and stay on screen, and the third to fifth are undone
 *    newest-first, which lands the list exactly where it was before the third.
 * 3. **The server's answer wins over the guess.** Each operation that lands is
 *    reconciled with the row the action returned — the real id of an added
 *    item, the real `checked_at` of a tick — so the screen holds database
 *    values a moment later rather than plausible ones.
 * 4. **A failure is never followed by "Saved".** The queue underneath stops on
 *    a failure instead of draining what was behind it, and everything it parks
 *    is rolled back through `onFailure` and offered to one Retry. A batch that
 *    reverted rows cannot be overwritten by an unrelated later success.
 * 5. **A dropped connection is a failure like any other.** `runOp` is wrapped,
 *    because an exception escaping this callback would skip every rule above
 *    it and leave a tick on screen that the database never took.
 *
 * ## Why it is built on `useSaveQueue`
 *
 * `components/autosave.tsx` already owns "one write on the wire at a time, the
 * next one queued and merged behind it", which is exactly the property a list
 * being ticked quickly needs: two overlapping writes are an *ordering* problem,
 * not a merge problem. This does not re-implement it. The only thing it
 * supplies is the merge — for a list the patch is a *sequence of operations*,
 * so operations concatenate where a field's patch would replace — and the
 * per-operation apply/revert/reconcile below.
 *
 * The one deliberate difference from the packaging block: those writes carry
 * absolute values and never touch the screen on failure, because the editor
 * holds text a person typed and throwing it away would be worse than a stale
 * row. A tick carries no text and *is* the screen, so here the rollback is the
 * honest answer and the text in the add box is what gets kept instead.
 */

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One change to the list, carrying everything needed to undo it.
 *
 * The undo information is captured at *dispatch* time rather than recomputed at
 * failure time: by the time a write fails, later operations may have changed
 * the same row, and "what it was before this operation" is not something the
 * list can still be asked.
 */
export type ChecklistOp =
  | {
      readonly kind: "toggle";
      readonly id: string;
      readonly checked: boolean;
      /** `checked_at` before the tick, so the revert is exact and not "null". */
      readonly previous: string | null;
    }
  | { readonly kind: "add"; readonly tempId: string; readonly text: string }
  | {
      readonly kind: "delete";
      readonly id: string;
      /** The whole row, so a failed delete can be put back where it was. */
      readonly removed: ChecklistItem;
    }
  | { readonly kind: "reset" };

export interface Checklist {
  /** The list, sorted, including anything not yet confirmed. */
  readonly items: readonly ChecklistItem[];
  readonly state: SaveState<readonly ChecklistOp[]>;
  readonly pending: boolean;
  readonly toggle: (id: string, checked: boolean) => void;
  readonly add: (text: string) => void;
  readonly remove: (id: string) => void;
  readonly reset: () => void;
  /** Re-send the operations that were rolled back. Nothing to retry is a no-op. */
  readonly retry: () => void;
  /**
   * Set when a write reported a stage other than the one on screen: the video
   * moved while this page was open, so what is rendered is another stage's
   * list. Never cleared here — the answer is to reload.
   */
  readonly movedAway: boolean;
}

/**
 * A client-side id for a row that does not have one yet.
 *
 * `crypto.randomUUID` exists in every browser this app supports and in Node 19+,
 * and the id is replaced by the database's own the moment the insert answers.
 * The `temp:` prefix is what keeps the two apart in the meantime — a row still
 * carrying one cannot be ticked or deleted, because the server has never heard
 * of it.
 */
export const TEMP_PREFIX = "temp:";

/**
 * Said when the request never reached the server.
 *
 * Deliberately *not* the generic string in `components/autosave.tsx`. That one
 * is written for a text field, which keeps what was typed and needs to be told
 * so; a tick carries no text and has just been taken back off the screen, so
 * the honest sentence is a different one.
 */
const UNREACHABLE =
  "Could not reach the server, so that change was undone. Try it again when you are back online.";

export function isPending(item: ChecklistItem): boolean {
  return item.id.startsWith(TEMP_PREFIX);
}

/* -------------------------------------------------------------------------- */
/* Apply / revert / reconcile                                                  */
/* -------------------------------------------------------------------------- */

function applyOp(
  items: readonly ChecklistItem[],
  op: ChecklistOp,
  now: string,
): ChecklistItem[] {
  switch (op.kind) {
    case "toggle":
      return items.map((item) =>
        item.id === op.id
          ? { ...item, checkedAt: op.checked ? now : null }
          : item,
      );
    case "add":
      return sortItems([
        ...items,
        {
          id: op.tempId,
          text: op.text,
          // The same rule the server will use, so the row does not jump when
          // the real one arrives: `min(position) - 1`, which is the top.
          position: topPosition(items),
          estMinutes: null,
          checkedAt: null,
          createdAt: now,
        },
      ]);
    case "delete":
      return items.filter((item) => item.id !== op.id);
    case "reset":
      // Deliberately not optimistic: the templates live in the database and
      // this client has never read them, so the only honest guess at the list
      // after a reset is the one the server sends back.
      return [...items];
  }
}

function revertOp(
  items: readonly ChecklistItem[],
  op: ChecklistOp,
): ChecklistItem[] {
  switch (op.kind) {
    case "toggle":
      return items.map((item) =>
        item.id === op.id ? { ...item, checkedAt: op.previous } : item,
      );
    case "add":
      return items.filter((item) => item.id !== op.tempId);
    case "delete":
      return sortItems([...items, op.removed]);
    case "reset":
      return [...items];
  }
}

/** Newest first, so the list lands exactly where it was before `ops[0]`. */
function revertAll(
  items: readonly ChecklistItem[],
  ops: readonly ChecklistOp[],
): ChecklistItem[] {
  let next = [...items];
  for (let i = ops.length - 1; i >= 0; i -= 1) next = revertOp(next, ops[i]);
  return next;
}

/** Replace the guess with what the row actually holds. */
function reconcileOp(
  items: readonly ChecklistItem[],
  op: ChecklistOp,
  result: Extract<ChecklistResult, { ok: true }>,
): ChecklistItem[] {
  switch (op.kind) {
    case "toggle":
      return result.item === null
        ? [...items]
        : items.map((item) =>
            item.id === op.id
              ? { ...item, checkedAt: result.item?.checkedAt ?? null }
              : item,
          );
    case "add":
      return result.item === null
        ? [...items]
        : sortItems(
            items.map((item) =>
              item.id === op.tempId ? (result.item as ChecklistItem) : item,
            ),
          );
    case "delete":
      return [...items];
    case "reset":
      /*
        The server's list, plus anything the queue still owes.

        A reset replaces the whole list, and it used to replace it with the
        template rows *only* — which threw away a custom item added while the
        reset was on the wire. The add then landed in the database (at position
        0, i.e. as the next action, which is the entire point of the feature)
        and its own reconcile found no temp row to replace, so the map was the
        identity and the real row was never put back on screen. The row existed
        and the page showed neither it nor an error.

        A pending row is one this client invented and the server has not
        answered for yet, so it is exactly the set the reset cannot know about.
      */
      return sortItems([...(result.items ?? []), ...items.filter(isPending)]);
  }
}

/* -------------------------------------------------------------------------- */
/* The hook                                                                    */
/* -------------------------------------------------------------------------- */

/** One operation on the wire. Errors are values here; nothing throws past it. */
async function runOp(
  videoId: string,
  op: ChecklistOp,
): Promise<ChecklistResult> {
  switch (op.kind) {
    case "toggle":
      return toggleChecklistItem({ videoId, itemId: op.id, checked: op.checked });
    case "add":
      return addChecklistItem({ videoId, text: op.text });
    case "delete":
      return deleteChecklistItem({ videoId, itemId: op.id });
    case "reset":
      return resetChecklist({ videoId });
  }
}

export function useChecklist({
  videoId,
  stageId,
  initial,
}: {
  videoId: string;
  /** The stage whose list this is — the video's current stage. */
  stageId: string;
  /** The rows as the server rendered them. */
  initial: readonly ChecklistItem[];
}): Checklist {
  const [items, setItems] = useState<ChecklistItem[]>(() => sortItems(initial));
  const [movedAway, setMovedAway] = useState(false);

  /**
   * The operations that were rolled back, waiting for a retry.
   *
   * A ref and not the queue's own `state.payload`: the payload is the whole
   * batch that was sent, and re-sending all of it would re-run the operations
   * that already landed — harmless for a tick, a duplicate row for an add.
   */
  const failed = useRef<readonly ChecklistOp[]>([]);
  /** False when re-sending `failed` would be wrong rather than merely useless. */
  const retryable = useRef(true);

  const { state, pending, send, touch } = useSaveQueue<readonly ChecklistOp[]>({
    // A list's patch is a sequence, so a write that arrives while one is in
    // flight joins the queue behind it rather than replacing it.
    merge: (queued, next) => [...queued, ...next],

    /*
      The single rollback point.

      `save` below records what did not land; this puts the screen back, once,
      for all of it — the unsent tail of the batch that failed *and* whatever
      the queue had parked behind it. It has to be one pass, newest-first
      (`revertAll`), because two passes in dispatch order would undo a repeated
      toggle to the wrong value.
    */
    onFailure: (parked) => {
      const all = parked ? [...failed.current, ...parked] : failed.current;
      failed.current = all;
      if (all.length > 0) setItems((current) => revertAll(current, all));
    },

    save: async (ops) => {
      for (let index = 0; index < ops.length; index += 1) {
        const op = ops[index];

        /*
          `runOp` turns a refusal into a value, but it cannot turn a *dropped
          connection* into one: an aborted request rejects, and an exception
          thrown from here would sail past every rollback in this file and out
          into the queue's own catch, where the generic message is the field
          editor's — "Nothing you typed has been lost" — which is false for a
          tick that has just been discarded. The tick would stay on screen, the
          ratio would count it, the database would hold nothing, and the Retry
          the app offered would return early on an empty `failed` and do
          nothing at all.

          So the throw is caught here and answered exactly like a refusal.
        */
        let result: ChecklistResult;
        try {
          result = await runOp(videoId, op);
        } catch {
          failed.current = ops.slice(index);
          retryable.current = true;
          return { ok: false, error: UNREACHABLE };
        }

        if (!result.ok) {
          failed.current = ops.slice(index);
          retryable.current = true;
          return { ok: false, error: result.error };
        }

        if (result.stageId !== stageId) {
          /*
            The video moved to another stage while this page was open.

            Every action in `app/actions/checklist.ts` reads the video's current
            stage itself and returns it, with a header comment saying why: *a
            client showing a different one can say the video has moved instead
            of silently dropping the write*. This is that comparison, and it
            used to be made for `add` alone — so a tab left open on a departed
            stage would happily tick and delete rows in it and reconcile the
            answer in as a success.

            What to put back on screen differs by kind, and the difference is
            real. An `add` lands in the stage the video is in *now*, so the temp
            row on screen names something no read of this list will ever return
            and has to go. A tick or a delete named a row by id, and that row is
            one of the ones on screen: the write landed on it, so reverting it
            would be the second lie. Either way the operations *behind* the one
            that ran were never sent, so they come back.

            In practice this is the fallback, not the usual path: the action
            revalidates `/videos/[id]`, the route re-renders with the new stage,
            and the strip is keyed by that stage, so it remounts onto the real
            list. What this covers is the case where that re-render does not
            arrive — the state here is then the last word, and it is honest.
          */
          failed.current =
            op.kind === "add" ? ops.slice(index) : ops.slice(index + 1);
          retryable.current = false;
          setMovedAway(true);
          return {
            ok: false,
            error:
              op.kind === "add"
                ? "This video moved to another stage while the page was open, so that item was added to the stage it is in now. Reload to see it."
                : "This video moved to another stage while the page was open, so this list is the stage it has left. That change was saved there. Reload to see where it is now.",
            conflict: true,
          };
        }

        setItems((current) => reconcileOp(current, op, result));
      }

      failed.current = [];
      retryable.current = true;
      return { ok: true };
    },
  });

  const dispatch = useCallback(
    (ops: readonly ChecklistOp[]) => {
      const now = new Date().toISOString();
      setItems((current) => {
        let next = [...current];
        for (const op of ops) next = applyOp(next, op, now);
        return next;
      });
      touch();
      send(ops);
    },
    [send, touch],
  );

  const toggle = useCallback(
    (id: string, checked: boolean) => {
      const item = items.find((row) => row.id === id);
      if (!item || isPending(item)) return;
      dispatch([{ kind: "toggle", id, checked, previous: item.checkedAt }]);
    },
    [dispatch, items],
  );

  const add = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      dispatch([
        {
          kind: "add",
          tempId: `${TEMP_PREFIX}${crypto.randomUUID()}`,
          text: trimmed,
        },
      ]);
    },
    [dispatch],
  );

  const remove = useCallback(
    (id: string) => {
      const item = items.find((row) => row.id === id);
      if (!item || isPending(item)) return;
      dispatch([{ kind: "delete", id, removed: item }]);
    },
    [dispatch, items],
  );

  const reset = useCallback(() => {
    dispatch([{ kind: "reset" }]);
  }, [dispatch]);

  const retry = useCallback(() => {
    const ops = failed.current;
    if (ops.length === 0 || !retryable.current) return;
    failed.current = [];
    // Re-dispatched rather than re-sent: the rows are back where they were, so
    // the optimistic half has to happen again too. A stale `previous` is not a
    // hazard — it is by definition the value the list holds right now.
    dispatch(ops);
  }, [dispatch]);

  return useMemo(
    () => ({ items, state, pending, toggle, add, remove, reset, retry, movedAway }),
    [add, items, movedAway, pending, remove, reset, retry, state, toggle],
  );
}
