"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { moveVideo } from "@/app/actions/moves";
import { updateVideo } from "@/app/actions/videos";
import { useToast } from "@/components/toast";
import { useShortcuts } from "@/lib/shortcuts";

import { IdeaFilterBar } from "./idea-filters";
import { IdeaRow } from "./idea-row";
import {
  activeFilterCount,
  explainEmpty,
  inScope,
  matchesFilters,
  visibleIdeas,
} from "./filtering";
import { NO_IDEA_FILTERS, type Idea, type IdeaBucket, type IdeaFilters } from "./types";

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
 */
export function IdeaList({
  channelName,
  channelSlug,
  ideas,
  verticals,
  horizontals,
  promoteStage,
}: {
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
}) {
  const router = useRouter();
  const toast = useToast();

  const [filters, setFilters] = useState<IdeaFilters>(NO_IDEA_FILTERS);
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

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLDivElement>(null);

  // Hydration marker, the same one `/now` carries: the specs wait for it before
  // pressing a key, because a keystroke before hydration is swallowed.
  useEffect(() => {
    listRef.current?.setAttribute("data-ready", "true");
  }, []);

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

  const archivedCount = useMemo(
    () => all.filter((idea) => idea.archivedAt !== null).length,
    [all],
  );

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

    const verticalCounts = new Map<string, number>();
    for (const idea of against({ ...filters, verticalId: null })) {
      if (idea.verticalId === null) continue;
      verticalCounts.set(
        idea.verticalId,
        (verticalCounts.get(idea.verticalId) ?? 0) + 1,
      );
    }

    const horizontalCounts = new Map<string, number>();
    for (const idea of against({ ...filters, horizontalId: null })) {
      if (idea.horizontalId === null) continue;
      horizontalCounts.set(
        idea.horizontalId,
        (horizontalCounts.get(idea.horizontalId) ?? 0) + 1,
      );
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
      rowRefs.current
        .get(idea.id)
        ?.scrollIntoView({ block: "nearest", behavior: "auto" });
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
      if (busyId !== null) return;

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
        const moved = await moveVideo({
          videoId: idea.id,
          stageId: promoteStage.id,
          slug: channelSlug,
        });

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

        setPromoted((previous) => new Set(previous).add(idea.id));
        toast.push({
          message: `Promoted to ${promoteStage.name}.`,
          links: [{ label: "Open it", href: `/videos/${idea.id}` }],
        });
        if (moved.notice) toast.push({ message: moved.notice });
        // The server list is now wrong by one row; so is the board.
        router.refresh();
      } catch {
        toast.push({
          message: "Could not reach the server — nothing moved. Try again.",
          tone: "error",
        });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, channelSlug, promoteStage, router, toast],
  );

  const setArchived = useCallback(
    async (idea: Idea, archived: boolean) => {
      if (busyId !== null) return;
      setBusyId(idea.id);
      try {
        const result = await updateVideo({ videoId: idea.id, archived });
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
      } catch {
        toast.push({
          message: "Could not reach the server — nothing was saved. Try again.",
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
          hint: { keys: "j / k", text: "select an idea" },
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
          hint: { keys: "p", text: "promote it" },
          run: (event) => {
            if (!selected) return;
            event.preventDefault();
            void promote(selected);
          },
        },
        {
          key: "Enter",
          description: "Open the selected idea",
          hint: { keys: "Enter", text: "open the idea" },
          run: (event) => {
            if (!selected) return;
            event.preventDefault();
            router.push(`/videos/${selected.id}`);
          },
        },
      ],
      [promote, router, selected, step],
    ),
    { enabled: visible.length > 0 },
  );

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const promoteRefusal =
    promoteStage.id === null ? promoteStage.reason : null;

  return (
    <div
      ref={listRef}
      data-testid="idea-bank"
      data-ready="false"
      className="flex flex-1 flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
          Ideas
        </h1>
        <p data-testid="idea-summary" className="text-[12px] text-muted">
          {all.length === 0
            ? `Nothing captured for ${channelName} yet.`
            : `${liveCount} of ${all.filter((idea) => idea.archivedAt === null).length} in ${channelName}, newest first.`}
        </p>
      </div>

      <IdeaFilterBar
        filters={filters}
        onChange={setFilters}
        tags={tags}
        verticals={verticals}
        horizontals={horizontals}
        archivedCount={archivedCount}
        counts={counts}
      />

      {visible.length === 0 ? (
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
    </div>
  );
}
