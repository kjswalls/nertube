"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import { moveVideo, type GateField } from "@/app/actions/moves";
import { useToast, type ToastLink } from "@/components/toast";
import { WeeklyStrip, type StripColumn } from "@/components/board/weekly-strip";
import { compareKinds, isWipKind } from "@/lib/defaults";
import { stageStats } from "@/lib/stage-stats";
import { GATE_ANCHOR, SKIP_ANCHOR } from "@/lib/packaging";
import { useShortcuts } from "@/lib/shortcuts";

import { ScheduleFilmingDayButton } from "@/components/calendar/filming/schedule-day-button";
import type { FilmingCandidate } from "@/components/calendar/filming/types";

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
  filmingElsewhere,
  today,
  now,
}: {
  channelName: string;
  channelSlug: string;
  /** Enabled stages, already in `position` order. */
  stages: readonly BoardStage[];
  cards: readonly BoardCard[];
  wipThreshold: number;
  staleDays: number;
  /**
   * The request's clock, read once on the server.
   *
   * The weekly strip's ages are recomputed here rather than taken from each
   * card's `daysInStage`, because the median of nine floored day counts is not
   * the floored median of nine ages — and because the strip has to follow a
   * drag, which changes `stageEnteredAt` on a card without a new server render.
   * Passing the number down is what keeps the two sides of hydration agreeing.
   */
  now: number;
  /**
   * The videos sitting in Filming in this user's *other* channels.
   *
   * A list rather than a count since M6, because the badge is now a button and
   * the dialog it opens has to pre-select exactly the videos the badge is
   * counting — one creator, one camera, one Saturday. Its length is still what
   * is added to this channel's live Filming count, so the badge stays correct
   * while cards are dragged in and out without a refetch.
   */
  filmingElsewhere: readonly FilmingCandidate[];
  /** Today as a calendar day (`YYYY-MM-DD`), from the same server clock. */
  today: string;
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
    const board = boardRef.current;
    if (!board) return;
    board.setAttribute("data-ready", "true");

    /*
      On a phone the strip shows one column at a time, and it used to open on
      Idea — which for a channel whose ideas live in the bank is an empty
      column, with the work (and the Filming badge, principle 4's whole
      signal) three swipes to the right. M9's week walk found the badge by
      swiping past three empty columns. Below `md` the strip now opens at the
      first column that holds anything. At desktop widths nothing moves: the
      board there is what M3 signed off, and the columns fit or nearly fit.
    */
    if (!window.matchMedia("(width < 48rem)").matches) return;
    if (board.scrollWidth <= board.clientWidth) return;
    const first = Array.from(
      board.querySelectorAll<HTMLElement>('[data-testid="board-column"]'),
    ).find((column) =>
      column.querySelector('[data-testid="board-card"], [data-testid="filming-badge"]'),
    );
    if (!first) return;
    board.scrollLeft +=
      first.getBoundingClientRect().left - board.getBoundingClientRect().left;
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

      return { stage, total, all, visible, overflow };
    });
  }, [merged, stages]);

  /**
   * The weekly strip's three numbers per column.
   *
   * Derived from `columns` — which is derived from `merged` — so a drag moves a
   * card and the strip follows it in the same render. `total` is the honest
   * count, including the Idea cards the column itself does not draw.
   */
  const stripColumns = useMemo<StripColumn[]>(
    () =>
      columns.map(({ stage, total, all }) => ({
        stageId: stage.id,
        name: stage.name,
        stats: stageStats(
          all.map((card) => card.stageEnteredAt),
          now,
        ),
        overWip:
          stage.kind !== null && isWipKind(stage.kind) && total > wipThreshold,
      })),
    [columns, now, wipThreshold],
  );

  /** Selection order: column by column, top to bottom, rendered cards only. */
  const selectable = useMemo(
    () => columns.flatMap((column) => column.visible),
    [columns],
  );

  const filmingTotal = useMemo(() => {
    const filming = columns.find((column) => column.stage.kind === "filming");
    return filmingElsewhere.length + (filming?.total ?? 0);
  }, [columns, filmingElsewhere]);

  /**
   * What the schedule dialog is offered: every video in Filming, in every
   * channel — this channel's from the cards on screen (so a card dragged in a
   * second ago is included without a refetch), the rest from the server read.
   *
   * The two halves cannot double-count: `filmingElsewhere` is read with
   * `channel_id <> this one`, and a card cannot be in two channels.
   *
   * "Offered", not "pre-selected". Each candidate carries the filming day it is
   * already on, if any, and the dialog leaves those unticked and names the day
   * beside them — M6's review pressed "Schedule the day" with everything ticked
   * and emptied a shoot that had already been booked. The badge still *counts*
   * the whole pile, which is BRIEF.md principle 4's signal; what changed is
   * that the default action can no longer move anything.
   */
  const filmingCandidates = useMemo<FilmingCandidate[]>(() => {
    const filming = columns.find((column) => column.stage.kind === "filming");
    // `all`, not `visible`: the two are the same for this column — only the
    // Idea column caps what it draws — and "every video in Filming" is the
    // question, not "every card on screen".
    const here = (filming?.all ?? []).map((card) => ({
      id: card.id,
      title: card.title,
      // The board's own channel, carried on the card rather than invented
      // here. It used to be `""` — a `FilmingCandidate` claiming to know its
      // channel and naming one that does not exist, for exactly the half of
      // the list belonging to the board you are looking at.
      channelId: card.channelId,
      channelName,
      channelSlug,
      stageKind: "filming" as const,
      stageName: filming?.stage.name ?? "Filming",
      archived: false,
      targetPublishDate: card.targetPublishDate,
      targetPublishLabel: card.targetPublishLabel,
      filmingDayId: card.filmingDayId,
      filmingDayLabel: card.filmingDayLabel,
    }));
    return [...here, ...filmingElsewhere];
  }, [columns, channelName, channelSlug, filmingElsewhere]);

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
      keyboard?: { returnFocus: () => void },
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
        /*
          A refusal that came from `[`/`]` puts focus on its first link, so the
          choice between fixing and skipping is one Enter or one Tab away rather
          than behind every card on the board; Escape (or the toast going) puts
          focus back on the card (M9 review). A drag or a click on an arrow
          leaves focus where the person put it.
        */
        focus: keyboard !== undefined && links.length > 0,
        returnFocus: keyboard?.returnFocus,
      });
      return keyboard !== undefined && links.length > 0;
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
    async (card: BoardCard, target: BoardStage, fromKey = false) => {
      if (card.stageId === target.id) return;
      // Set when a keyboard refusal's toast has taken focus: the card must not
      // take it back after the snap-back below.
      let toastTookFocus = false;

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

          /*
            PLAN.md's one soft warning: *Publish Prep → Scheduled with < 3
            thumbnail paths is a soft warning only*. The move has already
            happened, so this is deliberately an **info** toast with a way to
            go and fix it, not the error tone a refusal takes — a warning that
            looked like a refusal would read as the hard gate PLAN.md says this
            must not be. The sentence itself is `moveVideo`'s, so the board,
            the stage select and `/now` all say the same thing.
          */
          if (result.notice) {
            toast.push({
              tone: "info",
              message: `“${title}” moved to ${target.name}. ${result.notice}`,
              links: [
                {
                  label: "Open Thumbnails",
                  href: `/videos/${card.id}?section=thumbnails`,
                },
              ],
            });
          }
        } else {
          // Snap back. The card returns to the column it was in; nothing is
          // left sitting where the database refused to put it.
          setOverrides((current) => ({ ...current, [card.id]: before }));
          toastTookFocus = showToast(
            `Could not move “${title}” to ${target.name}. ${result.message}${where}`,
            card.id,
            result.missing,
            title,
            fromKey
              ? { returnFocus: () => cardRefs.current.get(card.id)?.focus() }
              : undefined,
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
        refocus.current = toastTookFocus ? null : focusRole;
      }
    },
    [channelSlug, focusRoleFor, showToast, stageById, toast],
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
    (card: BoardCard, direction: -1 | 1, fromKey = false) => {
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

      void requestMove(card, target, fromKey);
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
      hint: { keys: "j / k", text: "select a card", label: "Select the next or previous card" },
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
        if (selectedCard) moveBy(selectedCard, -1, true);
      },
    },
    {
      key: "]",
      description: "Move the selected card forward one stage",
      hint: {
        keys: "[ / ]",
        text: "move a stage",
        label: "Move it back or forward a stage",
      },
      run: (event) => {
        event.preventDefault();
        if (event.repeat) return;
        if (selectedCard) moveBy(selectedCard, 1, true);
      },
    },
    {
      /*
        PLAN.md's "Promote = `p` on a card": the idea bank has had it since M5;
        the board did not until the M9 review found it missing. It is the same
        call `]` makes on an Idea card and the bank's Promote makes — a move to
        the channel's Packaging stage through `move_video` — so it runs the
        same checks and says the same things. On any other card it does
        nothing: there is nothing to promote.
      */
      key: "p",
      description: "Promote the selected idea to Packaging",
      hint: {
        keys: "p",
        text: "promote it",
        label: "Promote the selected idea to Packaging",
        bar: false,
      },
      run: (event) => {
        if (!selectedCard || event.repeat) return;
        if (stageById.get(selectedCard.stageId)?.kind !== "idea") return;
        event.preventDefault();
        const packaging = stages.find((stage) => stage.kind === "packaging");
        if (!packaging) {
          showToast(
            "This channel's Packaging stage is switched off, so there is nowhere to promote to. Switch it on under Settings › Stages.",
            null,
            null,
          );
          return;
        }
        void requestMove(selectedCard, packaging, true);
      },
    },
    {
      key: "Enter",
      description: "Open the selected card",
      hint: { keys: "Enter", text: "open it", label: "Open the selected card" },
      run: (event) => {
        if (!selectedCard) return;
        event.preventDefault();
        router.push(`/videos/${selectedCard.id}`);
      },
    },
    {
      key: "Escape",
      description: "Clear the card selection",
      // On the sheet, not the bar: Escape is the key everybody already tries,
      // and the bar is kept for the keys nobody would guess.
      hint: { keys: "Escape", text: "clear the selection", bar: false },
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
  ], { group: "On the board" });

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
      <WeeklyStrip columns={stripColumns} staleDays={staleDays} />

      <div
        ref={boardRef}
        data-testid="board"
        data-ready="false"
        /*
          `contain: paint` is not decoration.

          Without it this strip's scrollable overflow propagates all the way to
          the viewport: `<html>` grows a horizontal scrollbar at *every* width,
          and because the 224px sidebar is a static flex item on the same page,
          an ordinary trackpad swipe — with the pointer nowhere near the strip —
          takes capture, the channel switcher, the theme control and Sign out
          off the left of the screen and reveals 900px of blank ground, while
          the strip's own `scrollLeft` never moves. Making this a real paint
          container stops that at the strip, which is where the sideways scroll
          is supposed to live. `components/app-shell.tsx` clips the shell as
          well, so nothing else can reintroduce it either.
        */
        className="flex flex-1 items-stretch gap-4 overflow-x-auto pb-4 [contain:paint]"
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
          // Named by this channel's label for the column it sits under, so a
          // renamed Filming is not "3 in Filming" beside a heading that says
          // something else. Across channels the count is by kind regardless.
          const badgeText =
            stage.kind === "filming" && filmingTotal >= FILMING_BATCH_THRESHOLD
              ? filmingTotal > total
                ? `${filmingTotal} in ${stage.name} across all channels — schedule batch day?`
                : `${filmingTotal} in ${stage.name} — schedule batch day?`
              : null;

          /*
            M1 to M5 this was a sentence. It is the same sentence, and now it
            is the button that answers it: the schedule dialog opens with every
            video the badge is counting already ticked, so noticing and booking
            the Saturday are one click apart (BRIEF.md principle 4).
          */
          const filmingBadge =
            badgeText === null ? null : (
              <ScheduleFilmingDayButton
                candidates={filmingCandidates}
                today={today}
                label={badgeText}
                tone="badge"
                testId="filming-badge"
                title="Schedule a batch filming day with these videos on it."
              />
            );

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
                  /*
                    The cap's way out. The Idea column shows ten and counts the
                    rest (PLAN.md), which until M5 meant the count *was* the
                    whole of it: a number with nowhere to go. It is a link now,
                    and it goes to the bank the number is counting.
                  */
                  <Link
                    href={`/c/${channelSlug}/ideas`}
                    data-testid="idea-overflow"
                    draggable={false}
                    title="Open the idea bank: every idea in this channel, with filters and promote."
                    className="block rounded-button px-1 py-2 text-[11px] text-muted underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    +{overflow} more in Ideas
                  </Link>
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
