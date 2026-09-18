"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { dismissSwap, logMetrics } from "@/app/actions/metrics";
import { moveVideo } from "@/app/actions/moves";
import { toggleChecklistItem } from "@/app/actions/checklist";
import { updateVideo } from "@/app/actions/videos";
import { defaultIntent, type NowIntent } from "@/components/now/intent";
import { NowRowItem } from "@/components/now/now-row";
import { useToast } from "@/components/toast";
import {
  SECTION_ORDER,
  SECTION_TITLE,
  matchesFilters,
  rankNow,
  type NowChannel,
  type NowFilters,
  type NowRow,
  type NowVideo,
} from "@/lib/next-action";
import { useShortcuts } from "@/lib/shortcuts";

/**
 * `/now`'s list: the filters, the three sections, the keyboard, and the one
 * place that writes.
 *
 * ## Why the ranking runs here too
 *
 * The page hands this component the *videos*, not the rows, and it calls the
 * same `rankNow()` the server would. That is what makes "complete a row and it
 * re-ranks, without a reload" one line rather than a protocol: finishing a row
 * patches the one video it was about, and the pure function produces the new
 * list — the next checklist item takes the row's place, a move takes the video
 * off the list, and nothing else on the page moves for a reason nobody can see.
 *
 * The clock comes from the server as a number and is used unchanged. Ages are
 * therefore identical on both sides of hydration and stay still while the list
 * is being worked through; a reload gets a new clock and nothing else does.
 *
 * ## What the server still owns
 *
 * A patch is a *prediction* of what the row now holds, and it is thrown away
 * the moment a fresh server render arrives (the `over` tag below). Two of the
 * intents — a move and a confirm-live — also ask for that render, because
 * `move_video` snapshots the next stage's checklist templates into
 * `checklist_items` and the browser cannot know what they say. Everything else
 * is a column this page already has, so it re-ranks locally and costs nothing.
 */
export function NowView({
  channels,
  videos,
  now,
}: {
  channels: readonly NowChannel[];
  videos: readonly NowVideo[];
  now: number;
}) {
  const router = useRouter();
  const toast = useToast();

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Local patches, tagged with the props they were computed over.
   *
   * The same shape `FlowFields` settled on in M2, for the same reason: a
   * `useState` seeded from props does not re-seed, so a `router.refresh()` that
   * brings newer rows would be silently overruled by a stale copy. Tagging the
   * patch with the array it was computed against means the moment the server
   * sends a new one, every patch expires at once.
   */
  const [patched, setPatched] = useState<{
    over: readonly NowVideo[];
    map: ReadonlyMap<string, NowVideo>;
  } | null>(null);

  /** "Still waiting" — an acknowledgement, not a write. Lives for this render pass. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());

  const [filters, setFilters] = useState<NowFilters>({
    channelIds: [],
    quickOnly: false,
  });

  const [busyVideoId, setBusyVideoId] = useState<string | null>(null);

  /**
   * What the user last pointed at: the row's video **and** where it was in the
   * list.
   *
   * Both, because the list changes underneath the selection constantly — that
   * is the whole point of the page. Ticking the selected row usually replaces
   * it with the next item on the same video, which keeps the same id; moving it
   * takes the video off the list entirely, and then the row that slid up into
   * its place is the one that should be selected. The id answers the first
   * case, the index answers the second, and keeping both means `x` twice in a
   * row works.
   */
  const [selection, setSelection] = useState<{ videoId: string; index: number } | null>(
    null,
  );

  /**
   * `data-ready="true"` once this component has hydrated.
   *
   * The list renders on the server, so every row is on screen before any of
   * this file is running: until hydration a tick does nothing and `j` does
   * nothing. The board marks the same window the same way and for the same
   * reason — the end-to-end suite waits for the attribute rather than for a
   * timeout, which is the difference between a green run and a flaky one.
   *
   * Written straight to the node rather than held in state: it is a fact about
   * the DOM, and putting it in state would buy a second render of every row to
   * say something no row reads.
   */
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.setAttribute("data-ready", "true");
  }, []);

  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const registerRef = useCallback((videoId: string, element: HTMLLIElement | null) => {
    if (element) rowRefs.current.set(videoId, element);
    else rowRefs.current.delete(videoId);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Derivation                                                              */
  /* ---------------------------------------------------------------------- */

  const context = useMemo(
    () => ({ channels: new Map(channels.map((channel) => [channel.id, channel])) }),
    [channels],
  );

  const current = useMemo(() => {
    const overrides = patched && patched.over === videos ? patched.map : null;
    if (!overrides) return videos;
    return videos.map((video) => overrides.get(video.id) ?? video);
  }, [videos, patched]);

  const allRows = useMemo(
    () => rankNow(current, context, now),
    [current, context, now],
  );

  const rows = useMemo(
    () =>
      allRows.filter(
        (row) => !acknowledged.has(row.videoId) && matchesFilters(row, filters),
      ),
    [allRows, acknowledged, filters],
  );

  const sections = useMemo(
    () =>
      SECTION_ORDER.map((section) => ({
        section,
        rows: rows.filter((row) => row.section === section),
      })).filter((group) => group.rows.length > 0),
    [rows],
  );

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  /*
    Which row is selected *now*, derived rather than stored.

    An effect that corrected a stale selection after the fact would be a second
    render for every tick, and React says so out loud (`set-state-in-effect`).
    This is the same rule as a pure function: the stored value is what the user
    asked for, and this is what it means against the list as it currently
    stands.
  */
  const selectedVideoId = useMemo(() => {
    if (selection === null || rows.length === 0) return null;
    const found = rows.some((row) => row.videoId === selection.videoId);
    if (found) return selection.videoId;
    return rows[Math.min(selection.index, rows.length - 1)].videoId;
  }, [rows, selection]);

  const select = useCallback(
    (videoId: string) => {
      const index = rows.findIndex((row) => row.videoId === videoId);
      if (index === -1) return;
      setSelection((previous) =>
        previous && previous.videoId === videoId && previous.index === index
          ? previous
          : { videoId, index },
      );
    },
    [rows],
  );

  const step = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row.videoId === selectedVideoId);
      const next =
        index === -1
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + delta));

      const row = rows[next];
      setSelection({ videoId: row.videoId, index: next });
      rowRefs.current
        .get(row.videoId)
        ?.scrollIntoView({ block: "nearest", behavior: "auto" });
    },
    [rows, selectedVideoId],
  );

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Replace one video, locally, and let the pure function re-rank. */
  const patch = useCallback(
    (videoId: string, change: (video: NowVideo) => NowVideo) => {
      setPatched((previous) => {
        const base =
          previous && previous.over === videos ? previous.map : new Map<string, NowVideo>();
        const source = base.get(videoId) ?? videos.find((video) => video.id === videoId);
        if (!source) return previous;

        const next = new Map(base);
        next.set(videoId, change(source));
        return { over: videos, map: next };
      });
    },
    [videos],
  );

  const perform = useCallback(
    async (row: NowRow, intent: NowIntent) => {
      if (busyVideoId !== null) return;

      // "Still waiting" writes nothing at all — see `intent.ts`.
      if (intent.kind === "still-waiting") {
        setAcknowledged((previous) => new Set(previous).add(row.videoId));
        return;
      }

      setBusyVideoId(row.videoId);
      try {
        switch (intent.kind) {
          case "tick": {
            if (row.payload.input !== "tick") return;
            const itemId = row.payload.itemId;
            const result = await toggleChecklistItem({
              videoId: row.videoId,
              itemId,
              checked: true,
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            const saved = result.item;
            patch(row.videoId, (video) => ({
              ...video,
              checklist: video.checklist.map((item) =>
                item.id === itemId ? (saved ?? { ...item, checkedAt: new Date(now).toISOString() }) : item,
              ),
            }));
            toast.push({ message: `Ticked: ${row.label}` });
            return;
          }

          case "text": {
            if (row.payload.input !== "text") return;
            const field = row.payload.field;
            const result = await updateVideo({
              videoId: row.videoId,
              ...(field === "title"
                ? { title: intent.value }
                : { thumbnailConcept: intent.value }),
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              title: result.video.title,
              thumbnailConcept: result.video.thumbnailConcept,
            }));
            toast.push({
              message: field === "title" ? "Title saved." : "Thumbnail concept saved.",
            });
            return;
          }

          case "choose-hook": {
            if (row.payload.input !== "choice") return;
            // Exactly one chosen, which is what the gate counts. Rewriting the
            // whole array is how the "at most one chosen" rule in
            // `HookListSchema` stays satisfiable in one write.
            const hooks = row.payload.hooks.map((hook) => ({
              id: hook.id,
              text: hook.text,
              chosen: hook.id === intent.hookId,
            }));
            const result = await updateVideo({ videoId: row.videoId, hooks });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({ ...video, hooks: result.video.hooks }));
            toast.push({ message: "Hook chosen." });
            return;
          }

          case "metrics": {
            const result = await logMetrics({
              videoId: row.videoId,
              impressions: intent.impressions,
              ctr: intent.ctr,
            });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              first24Impressions: result.impressions,
              first24Ctr: result.ctr,
              metricsLoggedAt: result.metricsLoggedAt,
            }));
            toast.push({ message: "First 24 hours logged." });
            return;
          }

          case "keep-thumbnail": {
            const result = await dismissSwap({ videoId: row.videoId });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              swapDismissedAt: result.swapDismissedAt,
            }));
            toast.push({ message: "Keeping the thumbnail." });
            return;
          }

          case "unblocked": {
            const result = await updateVideo({ videoId: row.videoId, waitingOn: null });
            if (!result.ok) {
              toast.push({ message: result.error, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              waitingOn: result.video.waitingOn,
              waitingSince: result.video.waitingSince,
            }));
            toast.push({ message: "Unblocked." });
            return;
          }

          case "confirm-live": {
            if (row.payload.input !== "url") return;
            const { publishedStageId, publishedStageName, targetPublishDate } =
              row.payload;

            // The URL first: if the move then fails, the link is still recorded
            // and the row simply stays. The other order would move the video
            // into Published and lose what was typed.
            const saved = await updateVideo({
              videoId: row.videoId,
              youtubeUrl: intent.url,
            });
            if (!saved.ok) {
              toast.push({ message: saved.error, tone: "error" });
              return;
            }

            const moved = await moveVideo({
              videoId: row.videoId,
              stageId: publishedStageId,
              slug: row.channelSlug,
              // PLAN.md rule 5: `published_at` is the date it was scheduled
              // for, not the moment somebody got round to confirming it — rule
              // 2 counts its 24 hours from here.
              ...(targetPublishDate === null
                ? {}
                : { publishedAt: `${targetPublishDate}T00:00:00.000Z` }),
            });
            if (!moved.ok) {
              toast.push({ message: moved.message, tone: "error" });
              return;
            }

            patch(row.videoId, (video) => ({
              ...video,
              youtubeUrl: saved.video.youtubeUrl,
              stageId: moved.stageId,
              stageEnteredAt: moved.stageEnteredAt,
              publishedAt: targetPublishDate
                ? `${targetPublishDate}T00:00:00.000Z`
                : new Date(now).toISOString(),
              checklist: [],
            }));
            toast.push({ message: `Live. Moved to ${publishedStageName}.` });
            // The new stage's checklist was snapshot-copied by `move_video`
            // and only the server knows what it says.
            router.refresh();
            return;
          }

          case "move": {
            if (row.payload.input !== "move") return;
            const { toStageId, toStageName } = row.payload;
            const moved = await moveVideo({
              videoId: row.videoId,
              stageId: toStageId,
              slug: row.channelSlug,
            });
            if (!moved.ok) {
              toast.push({ message: moved.message, tone: "error" });
              return;
            }
            patch(row.videoId, (video) => ({
              ...video,
              stageId: moved.stageId,
              stageEnteredAt: moved.stageEnteredAt,
              checklist: [],
            }));
            toast.push({ message: `Moved to ${toStageName}.` });
            router.refresh();
            return;
          }
        }
      } finally {
        setBusyVideoId(null);
      }
    },
    [busyVideoId, now, patch, router, toast],
  );

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  const selectedRow = rows.find((row) => row.videoId === selectedVideoId) ?? null;

  useShortcuts(
    useMemo(
      () => [
        {
          key: "j",
          description: "Select the next row",
          hint: { keys: "j / k", text: "select a row" },
          run: (event) => {
            event.preventDefault();
            step(1);
          },
        },
        {
          key: "k",
          description: "Select the previous row",
          run: (event) => {
            event.preventDefault();
            step(-1);
          },
        },
        {
          key: "x",
          description: "Complete the selected row",
          hint: { keys: "x", text: "complete the row" },
          run: (event) => {
            if (!selectedRow) return;
            event.preventDefault();

            const intent = defaultIntent(selectedRow);
            if (intent) {
              void perform(selectedRow, intent);
              return;
            }
            // Nothing to press: put the caret where the answer goes. See
            // `defaultIntent` for why `x` refuses to guess.
            const element = rowRefs.current
              .get(selectedRow.videoId)
              ?.querySelector<HTMLElement>("[data-now-primary]");
            element?.focus();
          },
        },
        {
          key: "Enter",
          description: "Open the selected video",
          hint: { keys: "Enter", text: "open the video" },
          run: (event) => {
            if (!selectedRow) return;
            event.preventDefault();
            router.push(`/videos/${selectedRow.videoId}`);
          },
        },
      ],
      [perform, router, selectedRow, step],
    ),
    { enabled: allRows.length > 0 },
  );

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const hiddenByFilters = allRows.length - rows.length;

  return (
    <div
      ref={listRef}
      data-testid="now"
      data-ready="false"
      className="flex flex-1 flex-col gap-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
          Now
        </h1>
        <p data-testid="now-summary" className="text-[12px] text-muted">
          {rows.length === 0
            ? "Nothing is waiting on you."
            : `${rows.length} ${rows.length === 1 ? "thing" : "things"} you could move right now.`}
        </p>
      </div>

      {/* ---- filters ---- */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {channels.length > 1
          ? channels.map((channel) => {
              const on = filters.channelIds.includes(channel.id);
              return (
                <button
                  key={channel.id}
                  type="button"
                  data-testid="channel-chip"
                  data-channel-id={channel.id}
                  aria-pressed={on}
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      channelIds: on
                        ? previous.channelIds.filter((id) => id !== channel.id)
                        : [...previous.channelIds, channel.id],
                    }))
                  }
                  className={[
                    "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                    on
                      ? "border-accent text-foreground"
                      : "border-border text-muted hover:text-foreground",
                  ].join(" ")}
                >
                  {channel.name}
                </button>
              );
            })
          : null}

        <button
          type="button"
          data-testid="quick-filter"
          aria-pressed={filters.quickOnly}
          onClick={() =>
            setFilters((previous) => ({ ...previous, quickOnly: !previous.quickOnly }))
          }
          title="Rows estimated at ten minutes or less. Filming and editing need a real block, so they are hidden."
          className={[
            "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
            filters.quickOnly
              ? "border-accent text-foreground"
              : "border-border text-muted hover:text-foreground",
          ].join(" ")}
        >
          10 minutes or less
        </button>

        {hiddenByFilters > 0 ? (
          <span data-testid="filtered-out" className="font-mono text-[11px] text-muted">
            {hiddenByFilters} hidden
          </span>
        ) : null}
      </div>

      {/* ---- the list ---- */}
      {sections.length === 0 ? (
        <p data-testid="now-empty" className="text-[13px] text-muted">
          {allRows.length === 0
            ? "Nothing is waiting on you. Capture an idea with c, or promote one from the board."
            : "Nothing matches those filters. Turn one off to see the rest."}
        </p>
      ) : (
        <div className="flex max-w-3xl flex-col gap-5">
          {sections.map((group) => (
            <section
              key={group.section}
              data-testid="now-section"
              data-section={group.section}
              aria-label={SECTION_TITLE[group.section]}
              className="flex flex-col gap-2"
            >
              <h2 className="flex items-baseline gap-2 text-[11px] font-medium tracking-[0.06em] uppercase">
                <span
                  className={
                    group.section === "overdue"
                      ? "text-over-limit"
                      : group.section === "waiting"
                        ? "text-attention"
                        : "text-muted"
                  }
                >
                  {SECTION_TITLE[group.section]}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {group.rows.length}
                </span>
              </h2>

              <ul className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <NowRowItem
                    key={row.videoId}
                    row={row}
                    now={now}
                    selected={row.videoId === selectedVideoId}
                    busy={busyVideoId === row.videoId}
                    onSelect={() => select(row.videoId)}
                    onIntent={(intent) => void perform(row, intent)}
                    registerRef={registerRef}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
