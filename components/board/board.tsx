"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import { moveVideo, type GateField } from "@/app/actions/moves";
import { useToast, type ToastLink } from "@/components/toast";
import { compareKinds, isWipKind } from "@/lib/defaults";
import { GATE_ANCHOR, SKIP_ANCHOR } from "@/lib/packaging";
import { useShortcuts } from "@/lib/shortcuts";

import { BoardColumn } from "./board-column";
import {
  compareCards,
  compareRecency,
  FILMING_BATCH_THRESHOLD,
  IDEA_COLUMN_LIMIT,
  type BoardCard,
  type BoardStage,
} from "./types";
import { VideoCard } from "./video-card";

/**
 * The board.
 *
 * ## Where a card is, and who decides
 *
 * The server component is the source of truth; this component keeps a small
 * `overrides` map on top of it so a move does not cost a round trip through a
 * full page render. A move is applied optimistically, then one of two things
 * happens:
 *
 * - **`move_video` accepted it.** The override is rewritten from the row the
 *   function returned (its `stage_id` and its fresh `stage_entered_at`), the
 *   action revalidates the board path, and when the new server props arrive the
 *   override is dropped because it now agrees with them.
 * - **`move_video` refused it.** The override is restored to exactly where the
 *   card was, which is the snap-back, and the toast names the missing field.
 *
 * The refusal path is the one that has to be right: the gate lives in the
 * database and the board does not second-guess it, so the card is never left in
 * a column the database would not have put it in. There is no client-side copy
 * of "is packaging done" anywhere in this file — the only way to find out is to
 * ask, and the answer is the one that is honoured.
 *
 * ## Moving a card
 *
 * Three ways, one code path (`requestMove`) and therefore one gate:
 *
 * - **Drag**, native HTML5: `dragstart` puts the id on the `DataTransfer`, the
 *   column's `dragover` opts in by calling `preventDefault()`, `drop` reads it
 *   back. No library.
 * - **The two buttons on every card**, which is what a screen reader or a
 *   switch user gets. Drag-and-drop as the only affordance is an accessibility
 *   failure, so the buttons are the real control and the drag is the shortcut.
 * - **`[` / `]`**, which move the selected card by `CORE_KIND_ORDER` — never by
 *   `stages.position`, which is display order only. `j` / `k` select, `Enter`
 *   opens.
 */
export function Board({
  channelName,
  channelSlug,
  stages,
  cards,
  wipThreshold,
  staleDays,
  filmingInOtherChannels,
}: {
  channelName: string;
  channelSlug: string;
  /** Enabled stages, already in `position` order. */
  stages: readonly BoardStage[];
  cards: readonly BoardCard[];
  wipThreshold: number;
  staleDays: number;
  /**
   * Filming-stage cards in this user's *other* channels. Added to this
   * channel's live Filming count so the batch-day badge stays correct while
   * cards are dragged in and out, without a refetch.
   */
  filmingInOtherChannels: number;
}) {
  const router = useRouter();

  type Override = { stageId: string; stageEnteredAt: string; daysInStage: number };
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [pending, setPending] = useState<readonly string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const toast = useToast();

  // The id is also kept outside React state: `drop` can only read the
  // `DataTransfer` reliably in some browsers, and this is the fallback.
  const draggingIdRef = useRef<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const focusOnSelect = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);

  /**
   * The in-flight set again, outside React state.
   *
   * `pending` is what the cards render from; this is what the "one move at a
   * time per card" guard reads. They cannot be the same object: the guard runs
   * inside a `keydown` handler that closes over the *last rendered* `pending`,
   * and OS key auto-repeat delivers the next `]` long before React has
   * committed the previous `setPending`. Read from state, the guard therefore
   * lets three or four `move_video` calls out for one row; read from a ref, it
   * sees the write the previous keydown made.
   */
  const pendingRef = useRef(new Set<string>());

  /**
   * Where focus should land once a move has settled.
   *
   * A successful move re-creates the card's DOM node inside a different
   * column, so whatever was focused — the card itself after `j`, or one of its
   * two move buttons after a click — is removed from the document and focus
   * falls to `<body>`. That is a keyboard user losing their place on every
   * single move. This remembers what was focused when the move started and the
   * effect below puts it back on the re-rendered card.
   */
  const refocus = useRef<{ id: string; role: "card" | "back" | "forward" } | null>(
    null,
  );

  /**
   * `data-ready="true"` once this component has hydrated.
   *
   * The board renders on the server, so the columns and cards are on screen
   * before any of this file is running: until hydration a drag does nothing, a
   * move button does nothing and `j` does nothing. That window is real for a
   * user on a slow connection and it is the difference between a green test run
   * and a flaky one, so it is marked rather than guessed at — the end-to-end
   * suite waits for this attribute before it touches anything.
   *
   * Written straight to the node rather than held in state: it is a fact about
   * the DOM, and putting it in state would buy a second render of every card to
   * say something no card reads.
   */
  useEffect(() => {
    boardRef.current?.setAttribute("data-ready", "true");
  }, []);

  /* ---------------------------------------------------------------- data -- */

  /**
   * The server's cards with this session's moves laid over them.
   *
   * An override is only ever written from something that already happened: the
   * row `move_video` returned, or — when it refused — the position the card was
   * in before the attempt. So an override never disagrees with the database
   * about where a card is; it is just newer than the props sometimes are,
   * between a successful move and the revalidated render landing.
   *
   * *Limitation, deliberately:* an override outlives the render that catches up
   * with it, so a move made somewhere else (another tab, the detail page) is
   * masked on this board until it is reloaded. For a single-user board with no
   * realtime that is the cheap end of the trade; the alternative is a pruning
   * effect, which buys a cascading render to fix a case that needs two tabs.
   */
  const merged = useMemo<BoardCard[]>(
    () =>
      cards.map((card) => {
        const override = overrides[card.id];
        return override ? { ...card, ...override } : card;
      }),
    [cards, overrides],
  );

  const stageById = useMemo(
    () => new Map(stages.map((stage) => [stage.id, stage])),
    [stages],
  );

  /**
   * The enabled stages that have a `kind`, in `CORE_KIND_ORDER`. This — not
   * `position` — is what `[` and `]` step through, and disabled stages are
   * already gone, so forward from Publish Prep with Scheduled turned off lands
   * on Published.
   */
  const coreOrder = useMemo(
    () =>
      stages
        .filter((stage) => stage.kind !== null)
        .sort((a, b) => compareKinds(a.kind!, b.kind!)),
    [stages],
  );

  const neighbours = useCallback(
    (stageId: string): { back: BoardStage | null; forward: BoardStage | null } => {
      const index = coreOrder.findIndex((stage) => stage.id === stageId);
      if (index === -1) return { back: null, forward: null };
      return {
        back: coreOrder[index - 1] ?? null,
        forward: coreOrder[index + 1] ?? null,
      };
    },
    [coreOrder],
  );

  /** Per column: every card in it, and the subset actually rendered. */
  const columns = useMemo(() => {
    const grouped = new Map<string, BoardCard[]>();
    for (const stage of stages) grouped.set(stage.id, []);
    for (const card of merged) grouped.get(card.stageId)?.push(card);

    return stages.map((stage) => {
      const all = grouped.get(stage.id) ?? [];
      const total = all.length;

      let visible = [...all].sort(compareCards);
      let overflow = 0;

      // The idea bank is a bank, not a queue: ten recent ones and a count.
      if (stage.kind === "idea" && total > IDEA_COLUMN_LIMIT) {
        visible = [...all]
          .sort(compareRecency)
          .slice(0, IDEA_COLUMN_LIMIT)
          .sort(compareCards);
        overflow = total - IDEA_COLUMN_LIMIT;
      }

      return { stage, total, visible, overflow };
    });
  }, [merged, stages]);

  /** Selection order: column by column, top to bottom, rendered cards only. */
  const selectable = useMemo(
    () => columns.flatMap((column) => column.visible),
    [columns],
  );

  const filmingTotal = useMemo(() => {
    const filming = columns.find((column) => column.stage.kind === "filming");
    return filmingInOtherChannels + (filming?.total ?? 0);
  }, [columns, filmingInOtherChannels]);

  /* --------------------------------------------------------------- moves -- */

  /**
   * Refusals go through the application's one toast mechanism
   * (`components/toast.tsx`), mounted by the root layout.
   *
   * PLAN.md: *a refused drop snaps back with a toast naming the missing field,
   * a "Fix packaging" link (detail scrolled to that field) and a "Skip gate…"
   * link*. M1 shipped neither — the packaging editor, the gate indicator and
   * the skip flow were all M2, so both fragments pointed at nothing and both
   * dropped the user at the top of a stub with neither field on it, which is
   * worse than no link at all. M2 builds the fields, so the pair is back.
   *
   * The two links go to *different* places and that is the point of having
   * two. "Fix packaging" carries the anchor of the field the database actually
   * stopped on (`GATE_ANCHOR`), so the caret lands in the box that is empty —
   * the concept when it is the concept, the hook list when it is the hook.
   * "Skip gate…" goes to the reason box with the disclosure already open. One
   * is the work; the other is the deliberate decision not to do it, and the
   * refusal is exactly the moment somebody is choosing between them.
   *
   * A refusal that is *not* the gate (a disabled stage, a cross-channel drop)
   * gets neither: there is no field to fix and nothing to skip.
   */
  const showToast = useCallback(
    (
      message: string,
      videoId: string | null,
      missing: GateField | null,
      title?: string,
    ) => {
      const links: ToastLink[] = [];

      if (videoId && missing) {
        links.push({
          label: "Fix packaging",
          href: `/videos/${videoId}#${GATE_ANCHOR[missing]}`,
        });
        links.push({
          label: "Skip gate…",
          href: `/videos/${videoId}#${SKIP_ANCHOR}`,
        });
      } else if (videoId) {
        links.push({
          label: title ? `Open “${title}”` : "Open the video",
          href: `/videos/${videoId}`,
        });
      }

      toast.push({
        tone: "error",
        message,
        links: links.length > 0 ? links : undefined,
      });
    },
    [toast],
  );

  /**
   * What is focused inside this card right now, if anything: the card element
   * itself, or one of its two move buttons (they carry `data-move`).
   */
  const focusRoleFor = useCallback(
    (cardId: string): { id: string; role: "card" | "back" | "forward" } | null => {
      const element = cardRefs.current.get(cardId);
      const active = document.activeElement;
      if (!element || !(active instanceof HTMLElement)) return null;
      if (!element.contains(active)) return null;
      const role = active.getAttribute("data-move");
      return {
        id: cardId,
        role: role === "back" || role === "forward" ? role : "card",
      };
    },
    [],
  );

  const requestMove = useCallback(
    async (card: BoardCard, target: BoardStage) => {
      if (card.stageId === target.id) return;

      const from = stageById.get(card.stageId);
      const title = card.title.trim() === "" ? "Untitled" : card.title;

      // One move at a time per card: two `move_video` calls in flight for one
      // row would race over `stage_entered_at` and over which stage wins. A
      // second `]` pressed before the first has landed is therefore dropped —
      // but said out loud, because a key that silently does nothing reads as a
      // broken board rather than as a busy one.
      if (pendingRef.current.has(card.id)) {
        setAnnouncement(`“${title}” is still moving. Wait for that to finish.`);
        return;
      }

      // Captured before the optimistic write, so the snap-back is exact.
      const before: Override = {
        stageId: card.stageId,
        stageEnteredAt: card.stageEnteredAt,
        daysInStage: card.daysInStage,
      };

      // Remembered before the optimistic write re-creates the node, and put
      // back after every render the move causes — including the last one.
      const focusRole = focusRoleFor(card.id);
      refocus.current = focusRole;

      pendingRef.current.add(card.id);
      setPending((current) => [...current, card.id]);
      setOverrides((current) => ({
        ...current,
        [card.id]: {
          stageId: target.id,
          stageEnteredAt: new Date().toISOString(),
          daysInStage: 0,
        },
      }));
      setAnnouncement(`Moving “${title}” to ${target.name}…`);

      const where = from ? ` It is still in ${from.name}.` : "";

      try {
        const result = await moveVideo({
          videoId: card.id,
          stageId: target.id,
          slug: channelSlug,
        });

        if (result.ok) {
          setOverrides((current) => ({
            ...current,
            [card.id]: {
              stageId: result.stageId,
              stageEnteredAt: result.stageEnteredAt,
              daysInStage: 0,
            },
          }));
          setAnnouncement(`Moved “${title}” to ${target.name}.`);
        } else {
          // Snap back. The card returns to the column it was in; nothing is
          // left sitting where the database refused to put it.
          setOverrides((current) => ({ ...current, [card.id]: before }));
          showToast(
            `Could not move “${title}” to ${target.name}. ${result.message}${where}`,
            card.id,
            result.missing,
            title,
          );
          setAnnouncement(`“${title}” was not moved. ${result.message}`);
        }
      } catch {
        // The call never reached the server, or its answer never came back:
        // a dropped connection, a restarted server, an aborted POST. Without
        // this the rejection escapes `requestMove` before the snap-back and
        // before `pending` is cleared, and the card sits in a column the
        // database never accepted, marked "Moving…" and unmovable, for the
        // life of the page — saying nothing at all.
        setOverrides((current) => ({ ...current, [card.id]: before }));
        showToast(
          `Could not move “${title}” to ${target.name}: the server could not be reached.${where}`,
          null,
          null,
        );
        setAnnouncement(
          `“${title}” was not moved: the server could not be reached.`,
        );
      } finally {
        pendingRef.current.delete(card.id);
        setPending((current) => current.filter((id) => id !== card.id));
        // The node is about to be re-created one more time, in whichever
        // column this move ended in. The role is the one the move started
        // with: a click on "→ Move forward" ends with that button focused on
        // the card in its new column, not with focus on the document.
        refocus.current = focusRole;
      }
    },
    [channelSlug, focusRoleFor, showToast, stageById],
  );

  // Runs after every render, and does nothing unless a move asked it to: the
  // card it names has just been re-created somewhere else, so this is the
  // first moment the new node exists to be focused.
  useEffect(() => {
    const wanted = refocus.current;
    if (!wanted) return;
    const element = cardRefs.current.get(wanted.id);
    if (!element) return;
    refocus.current = null;

    if (wanted.role !== "card") {
      const button = element.querySelector<HTMLButtonElement>(
        `[data-move="${wanted.role}"]`,
      );
      // A disabled button cannot take focus — the move is still in flight, or
      // the card has reached the end of the order — so the card takes it.
      if (button && !button.disabled) {
        button.focus();
        return;
      }
    }
    element.focus();
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  const moveBy = useCallback(
    (card: BoardCard, direction: -1 | 1) => {
      const stage = stageById.get(card.stageId);
      const { back, forward } = neighbours(card.stageId);
      const target = direction === -1 ? back : forward;

      if (!target) {
        const title = card.title.trim() === "" ? "Untitled" : card.title;
        if (stage && stage.kind === null) {
          showToast(
            `“${title}” is in ${stage.name}, a stage with no place in the core order, so the arrows and the bracket keys have nowhere to send it. Drag it to a column instead.`,
            null,
            null,
          );
        } else {
          showToast(
            `“${title}” is already in the ${direction === -1 ? "first" : "last"} stage.`,
            null,
            null,
          );
        }
        return;
      }

      void requestMove(card, target);
    },
    [neighbours, requestMove, showToast, stageById],
  );

  /* ----------------------------------------------------------- selection -- */

  const select = useCallback((id: string, focus: boolean) => {
    setSelectedId((current) => {
      if (current === id) return current;
      if (focus) focusOnSelect.current = true;
      return id;
    });
  }, []);

  useEffect(() => {
    if (!focusOnSelect.current || selectedId === null) return;
    focusOnSelect.current = false;
    const element = cardRefs.current.get(selectedId);
    element?.focus();
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  const step = useCallback(
    (direction: -1 | 1) => {
      if (selectable.length === 0) return;

      const index = selectable.findIndex((card) => card.id === selectedId);
      const next =
        index === -1
          ? direction === 1
            ? 0
            : selectable.length - 1
          : Math.min(Math.max(index + direction, 0), selectable.length - 1);

      const card = selectable[next];
      if (!card) return;

      select(card.id, true);
      const stage = stageById.get(card.stageId);
      const title = card.title.trim() === "" ? "Untitled" : card.title;
      setAnnouncement(
        `${title}, in ${stage?.name ?? "an unknown stage"}, card ${next + 1} of ${selectable.length}.`,
      );
    },
    [select, selectable, selectedId, stageById],
  );

  const selectedCard = useMemo(
    () => selectable.find((card) => card.id === selectedId) ?? null,
    [selectable, selectedId],
  );

  useShortcuts([
    {
      key: "j",
      description: "Select the next card",
      hint: { keys: "j / k", text: "select a card" },
      run: (event) => {
        event.preventDefault();
        step(1);
      },
    },
    {
      key: "k",
      description: "Select the previous card",
      run: (event) => {
        event.preventDefault();
        step(-1);
      },
    },
    {
      key: "[",
      description: "Move the selected card back one stage",
      run: (event) => {
        event.preventDefault();
        // A held key is one move, not four: `repeat` is the OS saying the key
        // never came up, and nobody means to send a card four stages back.
        if (event.repeat) return;
        if (selectedCard) moveBy(selectedCard, -1);
      },
    },
    {
      key: "]",
      description: "Move the selected card forward one stage",
      hint: { keys: "[ / ]", text: "move a stage" },
      run: (event) => {
        event.preventDefault();
        if (event.repeat) return;
        if (selectedCard) moveBy(selectedCard, 1);
      },
    },
    {
      key: "Enter",
      description: "Open the selected card",
      hint: { keys: "Enter", text: "open it" },
      run: (event) => {
        if (!selectedCard) return;
        event.preventDefault();
        router.push(`/videos/${selectedCard.id}`);
      },
    },
    {
      key: "Escape",
      description: "Clear the card selection",
      // No hint: Escape is the key everybody already tries, and the capture
      // dialog says "Escape to close" on its own face.
      run: (event) => {
        // Only when there is a selection to clear. Escape means something to
        // the browser (stopping a load, closing a native picker) and a
        // shortcut that swallows it when it has nothing to do is a bug.
        if (selectedId === null) return;
        event.preventDefault();
        setSelectedId(null);
        setAnnouncement("Selection cleared.");
      },
    },
  ]);

  /* ----------------------------------------------------------------- dnd -- */

  const DND_MIME = "application/x-nertube-video";

  function onDragStart(card: BoardCard, event: DragEvent<HTMLElement>): void {
    try {
      event.dataTransfer.setData(DND_MIME, card.id);
      event.dataTransfer.setData("text/plain", card.id);
      event.dataTransfer.effectAllowed = "move";
    } catch {
      // Some browsers lock the DataTransfer down; `draggingIdRef` covers it.
    }
    draggingIdRef.current = card.id;
    setDraggingId(card.id);
    select(card.id, false);
  }

  function onDragEnd(): void {
    draggingIdRef.current = null;
    setDraggingId(null);
    setDragOverStageId(null);
  }

  function readDraggedId(event: DragEvent<HTMLElement>): string | null {
    try {
      const custom = event.dataTransfer.getData(DND_MIME);
      if (custom) return custom;
      const plain = event.dataTransfer.getData("text/plain");
      if (plain) return plain;
    } catch {
      // Protected mode outside `drop`; fall through.
    }
    return draggingIdRef.current;
  }

  function onDrop(stage: BoardStage, event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDragOverStageId(null);
    setDraggingId(null);

    const id = readDraggedId(event);
    draggingIdRef.current = null;
    if (!id) return;

    const card = merged.find((candidate) => candidate.id === id);
    if (!card) return;

    void requestMove(card, stage);
  }

  /* -------------------------------------------------------------- render -- */

  return (
    <>
      <div
        ref={boardRef}
        data-testid="board"
        data-ready="false"
        className="flex flex-1 items-stretch gap-3 overflow-x-auto pb-4"
      >
        {columns.map(({ stage, total, visible, overflow }) => {
          const wipWarning =
            stage.kind !== null &&
            isWipKind(stage.kind) &&
            total > wipThreshold;

          /*
            Counted across every channel, because there is one creator and one
            camera — but rendered inside one channel's column, directly under
            that column's own count. When the two numbers disagree the badge
            has to say why, or it reads as the board miscounting rather than as
            the signal BRIEF.md principle 4 asks for.
          */
          const filmingBadge =
            stage.kind === "filming" && filmingTotal >= FILMING_BATCH_THRESHOLD
              ? filmingTotal > total
                ? `${filmingTotal} in Filming across all channels — schedule batch day?`
                : `${filmingTotal} in Filming — schedule batch day?`
              : null;

          return (
            <BoardColumn
              key={stage.id}
              name={stage.name}
              count={total}
              wipWarning={wipWarning}
              wipThreshold={wipThreshold}
              filmingBadge={filmingBadge}
              isDropTarget={dragOverStageId === stage.id}
              onDragOver={(event) => {
                // Without this the browser refuses the drop outright.
                event.preventDefault();
                try {
                  event.dataTransfer.dropEffect = "move";
                } catch {
                  /* nothing to do */
                }
                if (dragOverStageId !== stage.id) setDragOverStageId(stage.id);
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragOverStageId(stage.id);
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) {
                  return;
                }
                setDragOverStageId((current) =>
                  current === stage.id ? null : current,
                );
              }}
              onDrop={(event) => onDrop(stage, event)}
              footer={
                overflow > 0 ? (
                  <p
                    data-testid="idea-overflow"
                    className="px-1 py-2 text-xs text-muted"
                    title="The idea bank lives on /c/[slug]/ideas, which is M5. Until then the count is the whole of it."
                  >
                    +{overflow} more in Ideas
                  </p>
                ) : null
              }
            >
              {visible.map((card) => {
                const { back, forward } = neighbours(card.stageId);
                return (
                  <li key={card.id}>
                    <VideoCard
                      card={card}
                      channelName={channelName}
                      staleDays={staleDays}
                      selected={selectedId === card.id}
                      pending={pending.includes(card.id)}
                      dragging={draggingId === card.id}
                      previousStageName={back?.name ?? null}
                      nextStageName={forward?.name ?? null}
                      registerRef={(id, element) => {
                        if (element) cardRefs.current.set(id, element);
                        else cardRefs.current.delete(id);
                      }}
                      onSelect={() => select(card.id, false)}
                      onMoveBack={() => moveBy(card, -1)}
                      onMoveForward={() => moveBy(card, 1)}
                      onDragStart={(event) => onDragStart(card, event)}
                      onDragEnd={onDragEnd}
                    />
                  </li>
                );
              })}
            </BoardColumn>
          );
        })}
      </div>

      {/* Every move and every selection is announced here, so the keyboard path
          is usable without seeing the screen. */}
      <p
        data-testid="board-announcer"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>

    </>
  );
}
