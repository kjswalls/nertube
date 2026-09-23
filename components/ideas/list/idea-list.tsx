"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { moveVideo } from "@/app/actions/moves";
import { updateVideo } from "@/app/actions/videos";
import { CaptureLink } from "@/components/capture/capture-dialog";
import { IdeasViewSwitch } from "@/components/ideas/matrix/view-switch";
import { PRIMARY_ACTION, QUIET_ACTION, StatePanel } from "@/components/state-panel";
import { useToast } from "@/components/toast";
import { bucketOn } from "@/lib/buckets";
import { useShortcuts } from "@/lib/shortcuts";

import { IdeaFilterBar } from "./idea-filters";
import { IdeaRow } from "./idea-row";
import {
  activeFilterCount,
  describeScope,
  explainEmpty,
  inScope,
  matchesFilters,
  visibleIdeas,
} from "./filtering";
import { ideaFilterQuery } from "./url";
import { NO_IDEA_FILTERS, type Idea, type IdeaBucket, type IdeaFilters } from "./types";

/**
 * How long a write on this page may take before it is reported as unreachable.
 *
 * A server action that never resolves left the row pulsing, both its buttons
 * inert and the whole page's write path locked, with no way out but a reload —
 * an M5 review finding, reproduced by hanging the POST. The request is not
 * cancelled (a `move_video` that does land should land); what ends is this
 * page's waiting for it, which is the part the person is stuck in. Generous on
 * purpose: this is the "it is never coming" case, not the "it is slow" one.
 */
const WRITE_DEADLINE_MS = 12_000;

/** What the deadline rejects with, so the two callers can tell it apart. */
const DEADLINE = "deadline";

/** Was this the deadline above, rather than a request that failed outright? */
function timedOut(error: unknown): boolean {
  return error instanceof Error && error.message === DEADLINE;
}

/** The value, or a rejection once `WRITE_DEADLINE_MS` has passed. */
function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(DEADLINE)), WRITE_DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * The idea bank: every idea in one channel, newest first, with the four filters
 * and the three things you can do to a row.
 *
 * ## Where it sits in the product
 *
 * BRIEF.md puts the bank at the front of the pipeline: *capture must stay
 * cheap, and the bank is where an idea waits until it earns promotion*. The
 * board deliberately shows only ten ideas and counts the rest, so this page is
 * where the rest actually live — and it is what the board's "+K more in Ideas"
 * now points at, which until this milestone went nowhere.
 *
 * ## Three writes, three existing paths, no new concepts
 *
 * - **Promote** is `moveVideo` → the `move_video` RPC, the same call the board's
 *   drag and the `[`/`]` keys make. The gate applies moving *past* Packaging,
 *   never *into* it, so a promotion from here always succeeds — and on the day
 *   one does not, the refusal shows `moveVideo`'s own message rather than a
 *   swallowed "could not promote".
 * - **Archive** is `updateVideo({ archived: true })`, which writes
 *   `archived_at` and nothing else. That is the concept videos already have:
 *   the board's queries all end in `.is("archived_at", null)`, so the card
 *   leaves the board and the row leaves the bank in the same write. There is no
 *   second "dismissed" flag and no destructive delete — see the milestone note.
 * - **Restore** is the same call with `archived: false`.
 *
 * Nothing here is optimistic. A row that a failed write left looking promoted
 * is worse than a row that takes 150ms to change, and the whole page is three
 * buttons deep — there is no queue to build and nothing to roll back. What it
 * *does* do is keep a row that was just archived on screen, greyed, with a
 * Restore button, until the page is reloaded: archiving is meant to be cheap,
 * and cheap only stays safe if the undo is in the same place as the mistake.
 *
 * ## Keyboard
 *
 * `j`/`k` select, `p` promote, `Enter` open — registered once through
 * `lib/shortcuts.ts`, which is the application's only keyboard mechanism and
 * which already refuses to fire while the search box has focus.
 *
 * Selection is three things at once, since the M5 review: `data-selected` on
 * the row, **DOM focus** on it, and a sentence in the page's live region saying
 * which idea it is and where it sits. Before that it was only the first, so a
 * screen-reader user pressing `j` could not tell which idea `p` was about to
 * promote — and `j` then `p` is PLAN.md's own M5 acceptance. The board had
 * already solved this; this is the same pair, and the one live region carries
 * the filters' own feedback too.
 *
 * ## One write at a time, and it says so
 *
 * `busyId` is the page's lock. Every row renders `locked` while any row is
 * writing, so a control that will not act looks like it, and a press that gets
 * through is answered with a toast rather than swallowed. Each write has a
 * deadline (`WRITE_DEADLINE_MS`), because a server action that never resolves
 * used to leave one row pulsing and the whole page's write path locked with no
 * way out but a reload.
 *
 * ## The filters are in the address bar
 *
 * They arrive as `initialFilters`, parsed from the query string by the route
 * (`components/ideas/list/url.ts` names the parameters), and every change is
 * written back with `window.history.replaceState` — which Next supports and
 * syncs with its own router, and which costs no server round trip. That is the
 * point: the filtering is in-memory over rows that are already here, so a
 * `router.replace` per keystroke would re-run the page's four reads to produce
 * an identical list.
 *
 * `replaceState` and not `pushState`, deliberately: typing six letters into the
 * search box would otherwise be six entries in the history stack and six
 * presses of Back to leave the page. The cost, recorded in
 * `docs/MILESTONES.md`, is that Back does not step through filter changes — it
 * leaves the bank, which is what Back means everywhere else in this app.
 */
export function IdeaList({
  channelId,
  channelName,
  channelSlug,
  ideas,
  verticals,
  horizontals,
  promoteStage,
  elsewhere,
  initialFilters,
}: {
  /** For the empty bank's capture box, which files into this channel. */
  channelId: string;
  channelName: string;
  channelSlug: string;
  /** Every Idea-stage video in this channel, archived ones included. */
  ideas: readonly Idea[];
  verticals: readonly IdeaBucket[];
  horizontals: readonly IdeaBucket[];
  /**
   * Where Promote sends a row, or why it cannot. A channel whose Packaging
   * stage has been disabled has nowhere to promote to, and that is a sentence
   * the button has to be able to say rather than a button that is missing.
   */
  promoteStage: { id: string; name: string } | { id: null; reason: string };
  /**
   * How many videos this channel holds **outside** the Idea stage.
   *
   * Only ever used to choose between two sentences for an empty bank. Promotion
   * is the bank's success condition, so the most common way to empty one is to
   * work through it — and the page used to answer that by denying anything had
   * ever been captured. A channel with videos further down the pipeline gets
   * "everything captured has moved on" instead.
   */
  elsewhere: number;
  /**
   * What the query string was asking for when this page was requested. Already
   * resolved against this channel's buckets by the route, so an id in here is
   * an id that exists.
   */
  initialFilters: IdeaFilters;
}) {
  const router = useRouter();
  const toast = useToast();

  const [filters, setFilters] = useState<IdeaFilters>(initialFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * Rows this page has written to since it loaded, as they now stand.
   *
   * Keyed on the server list it was computed against, the same trick
   * `components/now/now-view.tsx` uses: when a navigation brings a genuinely
   * new list, the overlay is dropped rather than replaying yesterday's edits
   * over it.
   */
  const [overlay, setOverlay] = useState<{
    over: readonly Idea[];
    map: ReadonlyMap<string, Idea>;
  } | null>(null);

  /** Promoted here, so gone from the bank — hidden until the refresh lands. */
  const [promoted, setPromoted] = useState<ReadonlySet<string>>(new Set());

  /** Archived here, so kept on screen with an undo even though it is archived. */
  const [lingering, setLingering] = useState<ReadonlySet<string>>(new Set());

  /**
   * The one sentence the live region carries: what `j`/`k` just selected, or
   * what the filters just did.
   *
   * One region and one string, the way `components/board/board.tsx` does it. A
   * second region would mean two things talking over each other, and the two
   * events here cannot happen in the same moment anyway — a keystroke that
   * moves the selection does not change the filters.
   */
  const [announcement, setAnnouncement] = useState("");

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLDivElement>(null);

  // Hydration marker, the same one `/now` carries: the specs wait for it before
  // pressing a key, because a keystroke before hydration is swallowed.
  useEffect(() => {
    listRef.current?.setAttribute("data-ready", "true");
  }, []);

  /*
    The address bar follows the filters.

    `window.history.replaceState` is the documented way to move the query string
    without a navigation (`node_modules/next/dist/docs/01-app/01-getting-started/
    04-linking-and-navigating.md`, "Native History API"); Next syncs it into its
    own router, so `useSearchParams` elsewhere stays correct and a later
    `router.refresh()` re-runs the page against the filtered URL rather than the
    bare one.

    Guarded by a string compare so the effect is a no-op on mount when the URL
    already says this — which is every arrival from a link, and which is what
    keeps a shared URL from being rewritten before it has been read.
  */
  useEffect(() => {
    const query = ideaFilterQuery(filters);
    const path = window.location.pathname;
    const target = query === "" ? path : `${path}?${query}`;
    if (`${path}${window.location.search}` === target) return;
    window.history.replaceState(null, "", target);
  }, [filters]);

  const all = useMemo(() => {
    const patched = overlay && overlay.over === ideas ? overlay.map : null;
    const merged = patched
      ? ideas.map((idea) => patched.get(idea.id) ?? idea)
      : ideas;
    return merged.filter((idea) => !promoted.has(idea.id));
  }, [ideas, overlay, promoted]);

  const visible = useMemo(() => {
    const matched = visibleIdeas(all, filters);
    // A row archived a moment ago falls out of scope immediately. It stays,
    // at its place in the order, so the undo is where the mistake was.
    const kept = all.filter(
      (idea) =>
        lingering.has(idea.id) &&
        !matched.includes(idea) &&
        matchesFilters(idea, filters),
    );
    if (kept.length === 0) return matched;
    const keep = new Set([...matched, ...kept]);
    return all.filter((idea) => keep.has(idea));
  }, [all, filters, lingering]);

  /** What the heading counts: live ideas under the current filters. */
  const liveCount = useMemo(
    () => visible.filter((idea) => idea.archivedAt === null).length,
    [visible],
  );

  /** Every live idea in the bank, whatever the filters say. The denominator. */
  const live = useMemo(
    () => all.filter((idea) => idea.archivedAt === null).length,
    [all],
  );

  const archivedCount = useMemo(
    () => all.filter((idea) => idea.archivedAt !== null).length,
    [all],
  );

  /*
    The filters, announced.

    Every piece of feedback the filter bar produces is a plain paragraph: the
    count beside the heading, and the explanation that replaces the list. Both
    are rewritten silently, so a screen-reader user got no confirmation that a
    select had taken and no notice that the list was now empty. This says the
    same thing the eye reads, through the page's one live region.

    Debounced, and skipped on mount: the search box fires this on every
    keystroke, and announcing the page's own opening state would be a page that
    talks when nothing has happened.
  */
  const lastScope = useRef<string | null>(null);
  useEffect(() => {
    const scope = describeScope(liveCount, live, filters, {
      verticals,
      horizontals,
    });
    /*
      Compared by *value*, not by "is this the first run".

      A run counter would be wrong twice over: React's strict mode mounts an
      effect, unmounts it and mounts it again in development, so the second
      mount would announce the page's own opening state; and a `router.refresh()`
      hands down new `verticals`/`horizontals` arrays whose contents have not
      changed, which would announce a scope nobody touched. Remembering the
      sentence means it is announced exactly when it is different.
    */
    if (lastScope.current === null) {
      lastScope.current = scope;
      return;
    }
    if (lastScope.current === scope) return;

    const timer = setTimeout(() => {
      lastScope.current = scope;
      setAnnouncement(scope);
    }, 400);
    return () => clearTimeout(timer);
  }, [filters, liveCount, live, verticals, horizontals]);

  /* ---------------------------------------------------------------------- */
  /* Filter options                                                          */
  /* ---------------------------------------------------------------------- */

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const idea of all) for (const tag of idea.tags) seen.add(tag);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [all]);

  /**
   * How many ideas each option would leave, with the *other* filters as they
   * are. Picking one then becomes a decision rather than a guess — and an
   * option reading `(0)` is the empty state predicted before it happens.
   */
  const counts = useMemo(() => {
    const against = (relaxed: IdeaFilters) =>
      all.filter((idea) => inScope(idea, filters) && matchesFilters(idea, relaxed));

    const tagCounts = new Map<string, number>();
    for (const idea of against({ ...filters, tag: null })) {
      for (const tag of idea.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    /*
      `bucketOn`, not `idea.verticalId`.

      These are the numbers printed beside each option, and they have to be the
      numbers the filter would then produce — which `filtering.ts` decides with
      `inBucket`, and the matrix's cells with `bucketOn`. Reading the column
      directly here was the one place left where a change to how "which bucket
      is this in" is answered would not have reached the counts on screen.
    */
    const verticalCounts = new Map<string, number>();
    for (const idea of against({ ...filters, verticalId: null })) {
      const id = bucketOn(idea, "vertical");
      if (id === null) continue;
      verticalCounts.set(id, (verticalCounts.get(id) ?? 0) + 1);
    }

    const horizontalCounts = new Map<string, number>();
    for (const idea of against({ ...filters, horizontalId: null })) {
      const id = bucketOn(idea, "horizontal");
      if (id === null) continue;
      horizontalCounts.set(id, (horizontalCounts.get(id) ?? 0) + 1);
    }

    return {
      tags: tagCounts,
      verticals: verticalCounts,
      horizontals: horizontalCounts,
    };
  }, [all, filters]);

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  /*
    Derived, not stored — the same rule as `/now`. A selection whose row has
    been promoted away is not a selection, and correcting that in an effect
    would be a second render on every write.
  */
  const selected = useMemo(() => {
    if (selectedId === null) return null;
    return visible.find((idea) => idea.id === selectedId) ?? null;
  }, [selectedId, visible]);

  const step = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((idea) => idea.id === selectedId);
      const next =
        index === -1
          ? delta > 0
            ? 0
            : visible.length - 1
          : Math.min(visible.length - 1, Math.max(0, index + delta));
      const idea = visible[next];
      setSelectedId(idea.id);
      /*
        Focus follows the selection, and the selection is announced.

        Before the M5 review this only scrolled: `data-selected` changed, DOM
        focus stayed wherever it was and nothing was announced, so a
        screen-reader user pressing `j` could not tell which idea `p` was about
        to promote — and `j` then `p` is PLAN.md's own M5 acceptance. The board
        already solved this (`components/board/board.tsx` focuses the card and
        writes its live region); this is the same pair. The row carries
        `tabIndex={-1}`, which is what lets a `<li>` take focus without becoming
        a tab stop.
      */
      const row = rowRefs.current.get(idea.id);
      row?.scrollIntoView({ block: "nearest", behavior: "auto" });
      row?.focus({ preventScroll: true });
      const title = idea.title.trim() === "" ? "Untitled" : idea.title;
      setAnnouncement(`${title}, ${next + 1} of ${visible.length} in the bank.`);
    },
    [selectedId, visible],
  );

  const registerRef = useCallback((id: string, element: HTMLLIElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  const patch = useCallback(
    (id: string, next: Idea) => {
      setOverlay((previous) => {
        const base =
          previous && previous.over === ideas
            ? previous.map
            : new Map<string, Idea>();
        const map = new Map(base);
        map.set(id, next);
        return { over: ideas, map };
      });
    },
    [ideas],
  );

  const promote = useCallback(
    async (idea: Idea) => {
      /*
        One write at a time, and it says so.

        The page takes a single write because two moves of the same row would
        race; what it used to do with the others was nothing at all — no
        request, no message — while every other row's buttons stayed enabled and
        pressable. They are marked inert now (`locked` on the row), and a press
        that gets here anyway is answered rather than swallowed.
      */
      if (busyId !== null) {
        toast.push({
          message: "One write at a time — wait for the one in flight to finish.",
        });
        return;
      }

      if (promoteStage.id === null) {
        toast.push({ message: promoteStage.reason, tone: "error" });
        return;
      }
      if (idea.archivedAt !== null) {
        toast.push({
          message: "Restore it first — an archived idea is not in the bank.",
          tone: "error",
        });
        return;
      }

      setBusyId(idea.id);
      try {
        const moved = await withDeadline(
          moveVideo({
            videoId: idea.id,
            stageId: promoteStage.id,
            slug: channelSlug,
          }),
        );

        if (!moved.ok) {
          /*
            PLAN.md: the gate applies to moves *past* Packaging, so this branch
            should be unreachable for a promotion. If it is ever reached — a
            disabled stage, a row someone else moved a second ago — the
            database's own reason is what gets shown. Swallowing it here is how
            a promotion that silently does nothing survives to the next release.
          */
          toast.push({ message: moved.message, tone: "error" });
          return;
        }

        /*
          The row is about to leave the list. If focus or the selection was on
          it, both move to its neighbour (the next row, or the previous one
          when it was last) before it goes — otherwise the unmount drops focus
          on <body> and the next `p` has nothing to act on (M9 review).
        */
        const index = visible.findIndex((row) => row.id === idea.id);
        const neighbour = visible[index + 1] ?? visible[index - 1] ?? null;
        const rowElement = rowRefs.current.get(idea.id);
        const focusWasHere =
          rowElement !== undefined && rowElement.contains(document.activeElement);
        if (neighbour !== null && (focusWasHere || selectedId === idea.id)) {
          setSelectedId(neighbour.id);
          if (focusWasHere) {
            rowRefs.current.get(neighbour.id)?.focus({ preventScroll: true });
          }
        }

        setPromoted((previous) => new Set(previous).add(idea.id));
        toast.push({
          message: `Promoted to ${promoteStage.name}.`,
          links: [{ label: "Open it", href: `/videos/${idea.id}` }],
        });
        if (moved.notice) toast.push({ message: moved.notice });
        // The server list is now wrong by one row; so is the board.
        router.refresh();
      } catch (error) {
        toast.push({
          message: timedOut(error)
            ? "The server has not answered. Reload to see whether it moved."
            : "Could not reach the server — nothing moved. Try again.",
          tone: "error",
        });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, channelSlug, promoteStage, router, selectedId, toast, visible],
  );

  const setArchived = useCallback(
    async (idea: Idea, archived: boolean) => {
      if (busyId !== null) {
        toast.push({
          message: "One write at a time — wait for the one in flight to finish.",
        });
        return;
      }
      setBusyId(idea.id);
      try {
        const result = await withDeadline(
          updateVideo({ videoId: idea.id, archived }),
        );
        if (!result.ok) {
          toast.push({ message: result.error, tone: "error" });
          return;
        }

        patch(idea.id, { ...idea, archivedAt: result.video.archivedAt });

        if (archived) {
          setLingering((previous) => new Set(previous).add(idea.id));
          toast.push({
            message: `Archived. It is out of the bank and off the board — Restore is on the row.`,
          });
        } else {
          setLingering((previous) => {
            const next = new Set(previous);
            next.delete(idea.id);
            return next;
          });
          toast.push({ message: "Back in the bank." });
        }
      } catch (error) {
        toast.push({
          message: timedOut(error)
            ? "The server has not answered. Reload to see whether it saved."
            : "Could not reach the server — nothing was saved. Try again.",
          tone: "error",
        });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, patch, toast],
  );

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  useShortcuts(
    useMemo(
      () => [
        {
          key: "j",
          description: "Select the next idea",
          hint: {
            keys: "j / k",
            text: "select an idea",
            label: "Select the next or previous idea",
          },
          run: (event) => {
            event.preventDefault();
            step(1);
          },
        },
        {
          key: "k",
          description: "Select the previous idea",
          run: (event) => {
            event.preventDefault();
            step(-1);
          },
        },
        {
          key: "p",
          description: "Promote the selected idea to Packaging",
          hint: {
            keys: "p",
            text: "promote it",
            label: "Promote the selected idea onto the board",
          },
          run: (event) => {
            if (!selected) return;
            event.preventDefault();
            void promote(selected);
          },
        },
        {
          key: "Enter",
          description: "Open the selected idea",
          hint: {
            keys: "Enter",
            text: "open the idea",
            label: "Open the selected idea",
          },
          run: (event) => {
            if (!selected) return;
            event.preventDefault();
            router.push(`/videos/${selected.id}`);
          },
        },
        {
          // M9: the same Escape as the board's and `/now`'s.
          key: "Escape",
          description: "Clear the idea selection",
          hint: { keys: "Escape", text: "clear the selection", bar: false },
          run: (event) => {
            if (!selected) return;
            event.preventDefault();
            setSelectedId(null);
          },
        },
      ],
      [promote, router, selected, step],
    ),
    { enabled: visible.length > 0, group: "In the idea bank" },
  );

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const promoteRefusal =
    promoteStage.id === null ? promoteStage.reason : null;

  /*
    An empty bank has two quite different meanings.

    Promotion is what the bank is *for*, so the commonest way to empty one is to
    work through it — and answering that with "nothing captured yet" denies the
    work. `elsewhere` is the channel's videos past the Idea stage, counted by
    the route; `promoted` is the ones this session moved, which the server count
    will not know about until the refresh lands.
  */
  const summary =
    all.length > 0
      ? `${liveCount} of ${live} in ${channelName}, newest first.`
      : elsewhere > 0 || promoted.size > 0
        ? `Nothing waiting in the bank — everything captured for ${channelName} has moved on.`
        : `Nothing captured for ${channelName} yet.`;

  return (
    <div
      ref={listRef}
      data-testid="idea-bank"
      data-ready="false"
      className="flex flex-1 flex-col gap-4"
    >
      {/*
        The view switch, rendered here rather than by the route, so its List and
        Matrix links carry the filters **as they now stand** — the bank's
        filters live in this component and are written to the address bar from
        it. A server-rendered switch could only ever carry the query the page
        was requested with, which is stale the moment anything is typed. The
        matrix branch of the route renders the same component with the query it
        was given; there is still exactly one switch in the product.
      */}
      <IdeasViewSwitch
        channelSlug={channelSlug}
        current="list"
        query={ideaFilterQuery(filters)}
      />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
          Ideas
        </h1>
        <p data-testid="idea-summary" className="text-[12px] text-muted">
          {summary}
        </p>
      </div>

      {/*
        Why Promote will refuse, once, above the list rather than in a tooltip
        on every button.

        It is the same sentence for every row — the channel's Packaging stage is
        off, or there is none — and a tooltip on a control is not something a
        keyboard or a touch user can summon. The buttons stay focusable and say
        the same thing when pressed.
      */}
      {promoteRefusal ? (
        <p
          data-testid="idea-promote-refusal"
          className="max-w-2xl rounded-card border border-border bg-surface px-card-x py-card-y text-[13px] text-attention"
        >
          {promoteRefusal}
        </p>
      ) : null}

      {/* Nothing to filter on an empty bank: the bar would be five controls
          that can only ever find nothing (M9). */}
      {all.length === 0 ? null : (
        <IdeaFilterBar
          filters={filters}
          onChange={setFilters}
          tags={tags}
          verticals={verticals}
          horizontals={horizontals}
          archivedCount={archivedCount}
          counts={counts}
        />
      )}

      {all.length === 0 ? (
        /*
          M9: a bank with nothing in it at all, archived included. The old
          sentence here was "Press c to capture an idea", which is a key a
          phone does not have and a mouse user has not been told about; the
          action is now the capture box itself, one click away. The two cases
          are the summary's two (a bank never used, and a bank worked
          through), because they want different words and the same button.
        */
        <StatePanel
          testId="idea-empty"
          title={
            elsewhere > 0 || promoted.size > 0
              ? "Everything in the bank has moved on"
              : "The idea bank is empty"
          }
          actions={
            <>
              <CaptureLink
                channels={[{ id: channelId, name: channelName, slug: channelSlug }]}
                channelId={channelId}
                testId="idea-empty-capture"
                className={PRIMARY_ACTION}
              >
                Capture an idea
              </CaptureLink>
              {elsewhere > 0 || promoted.size > 0 ? (
                <Link href={`/c/${channelSlug}/board`} className={QUIET_ACTION}>
                  See them on the board
                </Link>
              ) : null}
            </>
          }
        >
          {elsewhere > 0 || promoted.size > 0 ? (
            <p>
              Every idea captured for {channelName} has been promoted onto the
              board, which is what the bank is for. The next one starts here.
            </p>
          ) : (
            <p>
              Ideas wait here until you commit to one. A title is enough to
              capture one — a hook, notes, tags and its buckets can come later —
              and Promote moves it onto the board when you are ready to package
              it.
            </p>
          )}
        </StatePanel>
      ) : visible.length === 0 ? (
        <p data-testid="idea-empty" className="max-w-2xl text-[13px] text-muted">
          {explainEmpty(all, filters, { verticals, horizontals })}
          {activeFilterCount(filters) > 0 ? (
            <>
              {" "}
              <button
                type="button"
                data-testid="idea-clear-filters"
                onClick={() =>
                  setFilters((previous) => ({
                    ...NO_IDEA_FILTERS,
                    includeArchived: previous.includeArchived,
                  }))
                }
                className="rounded-button underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
              >
                Clear the filters
              </button>
            </>
          ) : null}
        </p>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-2">
          {visible.map((idea) => (
            <IdeaRow
              key={idea.id}
              idea={idea}
              selected={selected?.id === idea.id}
              busy={busyId === idea.id}
              locked={busyId !== null && busyId !== idea.id}
              promoteRefusal={promoteRefusal}
              onSelect={() => setSelectedId(idea.id)}
              onPromote={() => void promote(idea)}
              onArchive={() => void setArchived(idea, true)}
              onRestore={() => void setArchived(idea, false)}
              registerRef={registerRef}
            />
          ))}
        </ul>
      )}

      {/*
        What just happened, for a reader who cannot see the list change.

        `j`/`k` write the selection here (with the row's place in the list), and
        the filters write the scope here after a pause — see the effect above.
        `aria-atomic` so the whole sentence is read rather than the words that
        changed, which is what `components/board/board.tsx` does with its own.
      */}
      <p
        data-testid="idea-announcer"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
    </div>
  );
}
